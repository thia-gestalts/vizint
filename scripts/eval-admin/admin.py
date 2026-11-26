import argparse
import errno
import json
import socket
import re
import secrets
import subprocess
from pathlib import Path

import uvicorn
from a2wsgi import WSGIMiddleware
from flask import Flask, abort, g, jsonify, redirect, render_template, request, send_file, session, url_for
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Mount, Route

import jobs

ROOT = Path(__file__).resolve().parents[2] / ".view-generation"
RUN_ID = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}")
ATTEMPT = re.compile(r"case-[1-9]\d*-attempt-[1-9]\d*")
ARTIFACTS = ("result.json", "request.json", "response.json", "activity.html",
             "activity.css", "activity.js", "activity.ts", "activity.bundle.js", "view.yml", "preview.png")
flask = Flask(__name__)
flask.secret_key = secrets.token_hex(32)
mcp = FastMCP(
    "Vizint evaluation", stateless_http=True, json_response=True,
    streamable_http_path="/mcp",
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:8765", "localhost:8765"],
        allowed_origins=["http://127.0.0.1:8765", "http://localhost:8765"],
    ),
)


def read_json(path, default):
    if path.is_symlink():
        return default
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, type(default)) else default
    except (OSError, ValueError):
        return default


def run_folder(run_id):
    path = ROOT / run_id
    if RUN_ID.fullmatch(run_id) and not path.is_symlink() and path.is_dir():
        return path
    raise FileNotFoundError(run_id)


def artifact_path(folder, attempt, name):
    if ATTEMPT.fullmatch(attempt) and name in ARTIFACTS:
        path = (folder / attempt / name).resolve()
        if path.is_relative_to(folder.resolve()) and path.is_file():
            return path
    raise FileNotFoundError(name)


def artifact_links(folder, attempt):
    links = {}
    for name in ARTIFACTS:
        try:
            artifact_path(folder, attempt, name)
        except FileNotFoundError:
            continue
        links[name] = f"/api/runs/{folder.name}/artifacts/{attempt}/{name}"
    return links


def read_run(folder, include_artifacts=True):
    rows = []
    for row in read_json(folder / "results.json", []):
        if not isinstance(row, dict) or not isinstance(row.get("attempts"), list):
            continue
        attempts = [
            {**attempt, "artifacts": artifact_links(folder, attempt["path"])} if include_artifacts else attempt
            for attempt in row["attempts"]
            if isinstance(attempt, dict) and isinstance(attempt.get("path"), str)
        ]
        outcome = "pending"
        if attempts and row.get("finished", True):
            passed = row.get("passed", attempts[-1].get("passed"))
            outcome = "passed" if passed is True else "failed"
        rows.append({**row, "attempts": attempts, "status": outcome})
    return {
        "id": folder.name, "settings": read_json(folder / "run.json", {}),
        "job": jobs.job_state(folder),
        "cases": rows, "url": f"/runs/{folder.name}",
        "api_url": f"/api/runs/{folder.name}",
    }


@mcp.tool()
def list_runs(model: str | None = None, status: str = "all", limit: int = 20) -> dict:
    """Find recent unique run batches by exact model name and final fixture outcome."""
    if status not in ("all", "passed", "failed") or not 1 <= limit <= 100:
        raise ValueError("Use status all, passed or failed and a limit from 1 to 100.")
    summaries = []
    for folder in sorted(ROOT.glob("*"), reverse=True):
        try:
            run = read_run(run_folder(folder.name), include_artifacts=False)
        except FileNotFoundError:
            continue
        cases = [
            {key: case.get(key) for key in ("model", "name", "status")}
            for case in run["cases"]
            if (model is None or case.get("model") == model)
            and (status == "all" or case["status"] == status)
        ]
        planned = [
            case for case in run["settings"].get("cases", [])
            if isinstance(case, dict) and case.get("model") == model
        ]
        if not cases and (status != "all" or (model is not None and not planned)):
            continue
        summaries.append({**run, "cases": cases, "settings": {
            "command": run["settings"].get("command"),
            **({"repairPolicy": run["settings"]["repairPolicy"]} if "repairPolicy" in run["settings"] else {}),
        }})
        if len(summaries) == limit:
            break
    return {"runs": summaries}


@mcp.tool()
def get_run(run_id: str) -> dict:
    """Read run settings, all attempts, diagnostics, and links to supporting artifacts."""
    return read_run(run_folder(run_id))


@mcp.tool()
def read_attempt_artifact(run_id: str, attempt: str, name: str, offset: int = 0) -> dict:
    """Read up to 8,000 characters from a text artifact. Pass next_offset to continue."""
    if offset < 0 or name == "preview.png":
        raise ValueError("Use a text artifact and a nonnegative character offset.")
    with artifact_path(run_folder(run_id), attempt, name).open(errors="replace") as file:
        remaining = offset
        while remaining:
            skipped = file.read(min(remaining, 8000))
            if not skipped:
                break
            remaining -= len(skipped)
        excerpt = file.read(8001)
    return {"text": excerpt[:8000], "next_offset": offset + 8000 if len(excerpt) > 8000 else None}


def case_prompt(folder, settings, case):
    for planned in settings.get("cases", []):
        if (isinstance(planned, dict) and planned.get("model") == case.get("model")
                and planned.get("fixture") == case.get("name")
                and planned.get("pairId") == case.get("pairId")):
            brief = planned.get("brief")
            if isinstance(brief, str) and brief.strip():
                return brief

    attempts = case.get("attempts", [])
    if attempts:
        try:
            path = artifact_path(folder, attempts[0]["path"], "request.json")
        except FileNotFoundError:
            pass
        else:
            for message in read_json(path, {}).get("messages", []):
                if isinstance(message, dict) and message.get("role") == "user":
                    content = message.get("content")
                    if isinstance(content, str) and content.strip():
                        return content
    return None


def prompt_groups(runs, model=None):
    groups = {}
    for summary in runs:
        try:
            folder = run_folder(summary["id"])
        except FileNotFoundError:
            continue
        run = read_run(folder, include_artifacts=False)
        matching = {(case["model"], case["name"], case["status"]) for case in summary["cases"]}
        cases = [case for case in run["cases"]
                 if (case.get("model"), case.get("name"), case["status"]) in matching]
        if not cases and not run["cases"]:
            cases = [
                {"model": planned.get("model"), "name": planned.get("fixture"), "status": "pending"}
                for planned in run["settings"].get("cases", [])
                if isinstance(planned, dict) and (model is None or planned.get("model") == model)
            ]
        prompts = {}
        for case in cases:
            prompts.setdefault(case_prompt(folder, run["settings"], case), []).append(case)
        for prompt, prompt_cases in (prompts or {None: []}).items():
            groups.setdefault(prompt, []).append({**summary, "cases": prompt_cases})
    return sorted(groups.items(), key=lambda item: (item[0] is None, (item[0] or "").casefold()))


def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_hex(32)
    return session["csrf"]


def check_csrf():
    token = session.get("csrf")
    if not token or not secrets.compare_digest(token, request.form.get("csrf", "")):
        abort(403)


def available_fixtures():
    try:
        return jobs.fixtures()
    except (OSError, ValueError, subprocess.SubprocessError):
        return []


@flask.post("/evaluations")
def start_evaluation():
    check_csrf()
    action = request.form.get("action")
    if action in ("compare", "eval"):
        models, _ = jobs.models()
        selected = list(dict.fromkeys(request.form.getlist("model")))
        fixture = request.form.get("fixture")
        if (not selected or any(model not in models or model.startswith("-") for model in selected)
                or (action == "compare" and len(selected) != 1)
                or (fixture and fixture not in available_fixtures())):
            abort(400, "Choose an installed model and a valid fixture")
        args = [action]
        for model in selected:
            args += ["--model", model]
        if fixture:
            args += ["--fixture", fixture]
        if action == "eval" and request.form.get("repair") == "once":
            args += ["--repair-policy", "once"]
    elif action == "control":
        args = ["eval", "--control"]
    elif action == "replay":
        ids = request.form.getlist("run_id")
        if not ids:
            abort(400, "Choose a source run")
        try:
            for run_id in ids:
                run_folder(run_id)
        except FileNotFoundError:
            abort(400, "Invalid source run")
        args = ["replay", *dict.fromkeys(ids)]
    else:
        abort(400, "Unknown evaluation action")
    active, started = jobs.launch(ROOT, args, action)
    if not active:
        abort(409, "An evaluation is starting")
    return redirect(f"/runs/{active}" + ("" if started else "?busy=1"), code=303)


@flask.post("/runs/<run_id>/cancel")
def cancel_evaluation(run_id):
    check_csrf()
    try:
        folder = run_folder(run_id)
    except FileNotFoundError:
        abort(404)
    if jobs.active_job(ROOT) != run_id or jobs.job_state(folder).get("status") not in jobs.ACTIVE:
        abort(409, "This evaluation is not active")
    (folder / "cancel.request").touch()
    return redirect(f"/runs/{run_id}", code=303)


def replay_source(run):
    return run["settings"].get("command") in (None, "generate", "eval") and any(
        case.get("model") != "Checked-in view" and case.get("status") in ("passed", "failed") for case in run["cases"]
    )


@flask.context_processor
def admin_navigation():
    if "active_job" not in g:
        g.active_job = jobs.active_job(ROOT)
    return {"active_job": g.active_job}


@flask.get("/")
def dashboard():
    if request.args:
        return redirect(url_for("history", **{
            name: request.args[name] for name in ("model", "status") if name in request.args
        }))
    return redirect(url_for("evaluate"))


@flask.get("/evaluate")
def evaluate():
    models, model_error = jobs.models()
    sources = list_runs(limit=100)["runs"]
    return render_template("evaluate.html", models=models, model_error=model_error,
                           fixtures=available_fixtures(), csrf=csrf_token(),
                           replay_sources=[run for run in sources if replay_source(run)])


@flask.get("/runs")
def history():
    model = request.args.get("model") or None
    status = request.args.get("status", "all")
    try:
        runs = list_runs(model, status, 100)["runs"]
    except ValueError as error:
        abort(400, str(error))
    return render_template("index.html", groups=prompt_groups(runs, model), model=model, status=status)


def replay_summary(run):
    if run["settings"].get("command") != "replay":
        return None
    totals = {"loop only": 0, "once only": 0, "both": 0, "neither": 0, "incomplete": 0}
    cutoffs = {arm: {seconds: 0 for seconds in (30, 60, 120)} for arm in ("once", "loop")}
    by_pair = {}
    for case in run["cases"]:
        by_pair.setdefault(case.get("pairId"), {})[case.get("policy")] = case
    for pair in run["settings"].get("cases", []):
        arms = by_pair.get(pair["pairId"], {})
        if any(arms.get(arm, {}).get("status") not in ("passed", "failed") or
               arms[arm].get("stopReason") == "infrastructure-error" for arm in cutoffs):
            totals["incomplete"] += 1
            continue
        winners = [arm for arm in cutoffs if arms[arm]["status"] == "passed"]
        outcome = ("both" if len(winners) == 2 else f"{winners[0]} only") if winners else "neither"
        totals[outcome] += 1
        for arm in winners:
            attempt = next(item for item in arms[arm]["attempts"] if item.get("passed"))
            seconds = attempt.get("elapsedSeconds", 0)
            for cutoff in cutoffs[arm]:
                cutoffs[arm][cutoff] += int(seconds <= cutoff)
    return {"totals": totals, "cutoffs": cutoffs}


def language_summary(run):
    if run["settings"].get("command") != "compare":
        return None
    languages = ("javascript", "typescript")
    outcomes = {name: dict.fromkeys((*languages, "both", "neither"), 0) for name in ("working", "passed")}
    incomplete = 0
    by_pair = {}
    for case in run["cases"]:
        by_pair.setdefault(case.get("pairId"), {})[case.get("language")] = case
    pairs = []
    for pair in run["settings"].get("cases", []):
        arms = by_pair.get(pair["pairId"], {})
        pairs.append({"fixture": pair["fixture"], "arms": [arms[name] for name in pair["order"] if name in arms]})
        if any(arms.get(name, {}).get("status") not in ("passed", "failed") or
               arms[name].get("stopReason") == "infrastructure-error" for name in languages):
            incomplete += 1
            continue
        for metric, counts in outcomes.items():
            winners = [name for name in languages if arms[name].get(metric)]
            key = "both" if len(winners) == 2 else winners[0] if winners else "neither"
            counts[key] += 1
    return {"outcomes": outcomes, "incomplete": incomplete, "pairs": pairs}


@flask.get("/runs/<run_id>")
def detail(run_id):
    g.active_job = jobs.active_job(ROOT)
    try:
        run = get_run(run_id)
    except FileNotFoundError:
        abort(404)
    for case in run["cases"]:
        case["prompt"] = case_prompt(run_folder(run_id), run["settings"], case)
    try:
        with (run_folder(run_id) / "runner.log").open("rb") as log:
            log.seek(max(0, log.seek(0, 2) - 12000))
            tail = log.read().decode("utf-8", errors="replace")
    except OSError:
        tail = ""
    return render_template("detail.html", run=run, replay=replay_summary(run), comparison=language_summary(run),
                           active=run["job"].get("status") in jobs.ACTIVE, log=tail, replay_source=replay_source(run),
                           busy=request.args.get("busy"), csrf=csrf_token())


@flask.get("/api/runs")
def api_list():
    try:
        return jsonify(list_runs(
            request.args.get("model") or None, request.args.get("status", "all"),
            int(request.args.get("limit", "20")),
        ))
    except ValueError as error:
        return jsonify(error=str(error)), 400


@flask.get("/api/runs/<run_id>")
def api_detail(run_id):
    try:
        return jsonify(get_run(run_id))
    except FileNotFoundError:
        return jsonify(error="Run not found"), 404


@flask.get("/api/runs/<run_id>/artifacts/<attempt>/<name>")
def download(run_id, attempt, name):
    try:
        path = artifact_path(run_folder(run_id), attempt, name)
    except FileNotFoundError:
        return jsonify(error="Artifact not found"), 404
    response = send_file(
        path, mimetype="image/png" if name == "preview.png" else "application/octet-stream",
        as_attachment=name != "preview.png", download_name=name,
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


mcp_app = mcp.streamable_http_app()
app = TrustedHostMiddleware(
    Starlette(routes=[Route("/mcp", mcp_app, methods=["GET", "POST", "DELETE"]), Mount("/", WSGIMiddleware(flask))],
              lifespan=mcp_app.router.lifespan_context),
    allowed_hosts=["127.0.0.1", "localhost"],
)

def main():
    parser = argparse.ArgumentParser(description="Serve the local evaluation admin.")
    parser.add_argument("--port", type=int, help="Require a specific loopback port.")
    args = parser.parse_args()
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")

    ports = [args.port] if args.port is not None else range(8765, 8775)
    with socket.socket() as listener:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        for port in ports:
            try:
                listener.bind(("127.0.0.1", port))
            except OSError as error:
                if error.errno != errno.EADDRINUSE and getattr(error, "winerror", None) != 10048:
                    raise
            else:
                break
        else:
            parser.exit(1, "Admin port unavailable. Use mise run views:admin --port PORT.\n")

        security = mcp.settings.transport_security
        security.allowed_hosts = [f"{host}:{port}" for host in ("127.0.0.1", "localhost")]
        security.allowed_origins = [f"http://{host}" for host in security.allowed_hosts]
        print(f"View evaluations: http://127.0.0.1:{port}", flush=True)
        print(f"Agent MCP endpoint: http://127.0.0.1:{port}/mcp", flush=True)
        config = uvicorn.Config(app, host="127.0.0.1", port=port)
        uvicorn.Server(config).run(sockets=[listener])


if __name__ == "__main__":
    main()
