import argparse
import errno
import fcntl
import json
import re
import secrets
import socket
import statistics
import threading
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import uvicorn
from a2wsgi import WSGIMiddleware
from flask import Flask, abort, g, jsonify, redirect, render_template, request, send_file, session, url_for
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Mount, Route

import authoring
import authoring_report
import jobs

ROOT = Path(__file__).resolve().parents[2] / ".view-generation"
RUN_ID = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}")
ATTEMPT = re.compile(r"case-[1-9]\d*-attempt-[1-9]\d*")
ARTIFACTS = ("result.json", "request.json", "response.json", "activity.html", "activity.css", "activity.js",
             "activity.raw.js", "activity.ts", "activity.bundle.js", "view.yml", "preview.png")
TIERS = ("publishable", "working", "starts", "broken")
NOTE_LIMIT = 4000
flask = Flask(__name__)
flask.secret_key = secrets.token_hex(32)
mcp = FastMCP(
    "Vizint evaluation", stateless_http=True, json_response=True, streamable_http_path="/mcp",
    instructions=(
        "Runs compare arms (model and generation settings) on benchmark fixtures or a custom brief. "
        "Call describe_options first, then start_run with a hypothesis. One run executes at a time; "
        "poll get_run for progress and the scoreboard. Tiers, best first: publishable (fixture checks and "
        "strict types pass), working (fixture checks pass), starts (loads without errors), broken. "
        "Use get_sample and read_attempt_artifact for evidence. Record conclusions with add_note: the "
        "humans reading the dashboard see your notes, and you see theirs in get_run. "
        "Authoring tools cover everyday view work in Codex and Claude Code, captured by local hooks: "
        "query_authoring compares turns grouped and filtered by client, model, effort, tool, view, check status "
        "or time; authoring_failures clusters check diagnostics; get_authoring_view gives one view's history and "
        "effort until it first passed; get_authoring_turn, read_authoring_transcript and read_authoring_check_file "
        "give a turn's tool calls, conversation and checked sources. A turn's usage covers every view it touched. "
        "Record conclusions on a view with add_authoring_note."
    ),
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:8765", "localhost:8765"],
        allowed_origins=["http://127.0.0.1:8765", "http://localhost:8765"],
    ),
)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
    if isinstance(run_id, str) and RUN_ID.fullmatch(run_id) and not path.is_symlink() and path.is_dir():
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


def tier_of(checks):
    """Mirror of tierOf in scripts/view-repair-policy.mjs; also rescores legacy attempts."""
    checks = checks if isinstance(checks, dict) else {}
    starts = checks.get("startup", checks.get("browser")) == "pass"
    if checks.get("syntax") != "pass" or not starts:
        return "broken"
    if checks.get("fixture") != "pass":
        return "starts"
    return "publishable" if checks.get("type") == "pass" else "working"


def origin_label(origin):
    if not isinstance(origin, dict):
        return "Unknown"
    if origin.get("kind") == "agent":
        return f"Agent · {origin.get('name', 'agent')}"
    return "You (CLI)" if origin.get("name") == "cli" else "You"


def read_notes(folder):
    return [note for note in read_json(folder / "notes.json", []) if isinstance(note, dict)]


def append_note(folder, author, text):
    text = text.strip() if isinstance(text, str) else ""
    if not text or len(text) > NOTE_LIMIT:
        raise ValueError(f"A note needs 1–{NOTE_LIMIT} characters.")
    with (folder / ".notes.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        notes = read_notes(folder)
        note = {"at": now(), "author": author, "text": text}
        notes.append(note)
        temporary = folder / ("notes-" + uuid4().hex + ".tmp")
        temporary.write_text(json.dumps(notes, indent=2))
        temporary.replace(folder / "notes.json")
    return note


def status_of(job, rows, planned):
    if job.get("status"):
        return job["status"]
    if planned and len(rows) == planned and all(row.get("finished") for row in rows):
        return "completed"
    return "incomplete"


def sample_summary(folder, row):
    attempts = [item for item in row.get("attempts", []) if isinstance(item, dict) and isinstance(item.get("path"), str)]
    selected = next((item for item in attempts if item["path"] == row.get("selectedAttempt")), attempts[-1] if attempts else {})
    first = next((item for item in (selected.get("diagnostics") or []) if isinstance(item, dict)), None)
    preview = selected.get("path") and selected.get("preview")
    return {
        "arm": row.get("arm"), "fixture": row.get("fixture"), "sample": row.get("sample"),
        "tier": row.get("tier") or ("broken" if row.get("finished") else None), "passed": row.get("passed"),
        "finished": bool(row.get("finished")), "stopReason": row.get("stopReason"), "attempts": len(attempts),
        "selectedAttempt": row.get("selectedAttempt"), "checks": selected.get("checks", {}),
        "typeErrorsRaw": row.get("typeErrorsRaw"), "typeErrors": row.get("typeErrors"),
        "seconds": row.get("elapsedSeconds"), "example": selected.get("example"), "codemod": selected.get("codemod"),
        "firstDiagnostic": first and {"stage": first.get("stage"), "message": str(first.get("message", ""))[:600]},
        "preview": f"/api/runs/{folder.name}/artifacts/{selected['path']}/preview.png" if preview else None,
        "url": f"/runs/{folder.name}/samples/{row.get('arm')}/{row.get('fixture')}/{row.get('sample')}",
    }


def median(values):
    values = [value for value in values if isinstance(value, (int, float))]
    return round(statistics.median(values), 1) if values else None


def scoreboard(spec, cases, samples):
    targets = spec.get("fixtures") or ["custom"]
    planned = {}
    for case in cases:
        key = (case.get("arm"), case.get("fixture"))
        planned[key] = planned.get(key, 0) + 1
    arms = []
    for arm in spec.get("arms", []):
        own = [item for item in samples if item["arm"] == arm["id"]]
        done = [item for item in own if item["finished"]]
        cells = []
        for target in targets:
            cell = [item for item in done if item["fixture"] == target]
            tally = {tier: sum(item["tier"] == tier for item in cell) for tier in TIERS}
            cells.append({
                "fixture": target, "planned": planned.get((arm["id"], target), 0), "done": len(cell),
                "tally": tally, "best": next((tier for tier in TIERS if tally[tier]), None),
            })
        tally = {tier: sum(item["tier"] == tier for item in done) for tier in TIERS}
        arms.append({
            "id": arm["id"], "label": arm.get("label"), "arm": arm, "cells": cells, "tally": tally,
            "planned": sum(planned.get((arm["id"], target), 0) for target in targets), "done": len(done),
            "accepted": sum(bool(item["passed"]) for item in done),
            "medianTypeErrorsRaw": median([item["typeErrorsRaw"] for item in done]),
            "medianTypeErrors": median([item["typeErrors"] for item in done]),
            "medianSeconds": median([item["seconds"] for item in done]),
        })
    return {"fixtures": targets, "arms": arms}


def headline(board, custom):
    parts = []
    for arm in board["arms"]:
        tally = arm["tally"]
        if not arm["done"]:
            parts.append(f"{arm['id']} pending")
        elif custom:
            parts.append(f"{arm['id']} {arm['accepted']}/{arm['done']} accepted")
        else:
            parts.append(f"{arm['id']} {tally['publishable'] + tally['working']}/{arm['done']} working · "
                         f"{tally['publishable']}/{arm['done']} publishable")
    return parts


def load_run(folder, details=True):
    spec = read_json(folder / "experiment.json", {})
    meta = read_json(folder / "run.json", {})
    rows = [row for row in read_json(folder / "results.json", []) if isinstance(row, dict)]
    job = jobs.job_state(folder)
    base = {"id": folder.name, "url": f"/runs/{folder.name}", "api_url": f"/api/runs/{folder.name}",
            "notes": read_notes(folder), "job": job}
    if not spec or "arms" not in spec:
        return {**base, **legacy_run(folder, meta, rows, details), "legacy": True}
    cases = [case for case in meta.get("cases", []) if isinstance(case, dict)]
    samples = [sample_summary(folder, row) for row in rows]
    board = scoreboard(spec, cases, samples)
    run = {
        **base, "legacy": False, "spec": spec, "origin": spec.get("origin"), "originLabel": origin_label(spec.get("origin")),
        "hypothesis": spec.get("hypothesis"), "status": status_of(job, rows, len(cases)),
        "progress": {"done": sum(item["finished"] for item in samples), "planned": len(cases)},
        "scoreboard": board, "headline": headline(board, "brief" in spec), "order": meta.get("order"),
    }
    if details:
        run["samples"] = samples
        run["provenance"] = {key: meta.get(key) for key in
                             ("git", "runnerHash", "checkHash", "node", "typescript", "ollama", "browser", "models")}
    return run


def legacy_run(folder, meta, rows, details):
    cases = []
    for row in rows:
        attempts = [item for item in row.get("attempts", []) if isinstance(item, dict) and isinstance(item.get("path"), str)]
        for item in attempts:
            item["tier"] = tier_of(item.get("checks"))
            if details:
                item["artifacts"] = artifact_links(folder, item["path"])
        best = next((tier for tier in TIERS if any(item["tier"] == tier for item in attempts)), "broken")
        cases.append({"model": row.get("model"), "fixture": row.get("name"), "policy": row.get("policy") or row.get("language"),
                      "tier": best, "attempts": attempts if details else len(attempts)})
    return {"hypothesis": f"Legacy {meta.get('command') or 'run'}", "originLabel": "Legacy", "status": "legacy",
            "settings": meta if details else {"command": meta.get("command")}, "cases": cases,
            "headline": [f"{case['model']} / {case['fixture']}: {case['tier']}" for case in cases[:4]]}


def all_runs():
    for folder in sorted(ROOT.glob("*"), reverse=True):
        try:
            yield load_run(run_folder(folder.name), details=False)
        except FileNotFoundError:
            continue


def find_sample(run_id, arm, fixture, sample):
    folder = run_folder(run_id)
    for row in read_json(folder / "results.json", []):
        if (isinstance(row, dict) and row.get("arm") == arm and row.get("fixture") == fixture
                and row.get("sample") == sample):
            attempts = [{**item, "tier": item.get("tier") or tier_of(item.get("checks")),
                         "artifacts": artifact_links(folder, item["path"])}
                        for item in row.get("attempts", []) if isinstance(item, dict) and isinstance(item.get("path"), str)]
            return folder, {**sample_summary(folder, row), "attempts": attempts}
    raise FileNotFoundError(sample)


def start(spec, origin):
    """Validate and launch a run. Raises jobs.SpecError or returns (run_id, started)."""
    if not isinstance(spec, dict):
        raise jobs.SpecError("Invalid run spec: expected an object")
    normalized = jobs.validate({**{key: value for key, value in spec.items() if value is not None}, "origin": origin})
    return jobs.launch(ROOT, normalized)


def agent_origin(agent_name, ctx=None):
    name = agent_name.strip() if isinstance(agent_name, str) else ""
    if not name and ctx is not None:
        try:
            name = ctx.session.client_params.clientInfo.name
        except AttributeError:
            name = ""
    return {"kind": "agent", "name": (name or "agent")[:60]}


# Agent tools

@mcp.tool()
def describe_options() -> dict:
    """Fixtures, installed models, arm settings, limits and defaults, plus the active run if any."""
    models, error = jobs.models()
    return {**jobs.describe(), "models": models, "modelError": error, "activeRun": jobs.active_job(ROOT)}


@mcp.tool()
def start_run(hypothesis: str, arms: list[dict], fixtures: list[str] | None = None, brief: str | None = None,
              agent_name: str = "", ctx: Context = None) -> dict:
    """Start a run. Give fixtures (benchmark names) or a custom brief, and 1–4 arms such as
    {"model": "qwen3.5:4b", "examples": "retrieved", "samples": 3}. Name yourself in agent_name."""
    try:
        run_id, started = start({"hypothesis": hypothesis, "arms": arms, "fixtures": fixtures, "brief": brief},
                                agent_origin(agent_name, ctx))
    except jobs.SpecError as error:
        raise ValueError(str(error))
    if not started:
        raise ValueError(f"Run {run_id} is active. Wait for it to finish or cancel it.")
    return {"run_id": run_id, "url": f"/runs/{run_id}"}


@mcp.tool()
def list_runs(origin: str = "all", limit: int = 20, include_legacy: bool = False) -> dict:
    """Recent runs, newest first, with hypothesis, origin, status and a per-arm headline.
    origin is all, human or agent."""
    if origin not in ("all", "human", "agent") or not 1 <= limit <= 100:
        raise ValueError("Use origin all, human or agent and a limit from 1 to 100.")
    runs = []
    for run in all_runs():
        if run["legacy"] and not include_legacy:
            continue
        if origin != "all" and (run.get("origin") or {}).get("kind") != origin:
            continue
        runs.append({key: run.get(key) for key in
                     ("id", "hypothesis", "origin", "status", "progress", "headline", "legacy", "url")})
        if len(runs) == limit:
            break
    return {"runs": runs}


@mcp.tool()
def get_run(run_id: str) -> dict:
    """A run's spec, status, scoreboard, sample summaries, notes and provenance."""
    return load_run(run_folder(run_id))


@mcp.tool()
def get_sample(run_id: str, arm: str, fixture: str, sample: int) -> dict:
    """All attempts of one sample with checks, diagnostics, codemod fixes and artifact URLs."""
    return find_sample(run_id, arm, fixture, sample)[1]


@mcp.tool()
def read_attempt_artifact(run_id: str, attempt: str, name: str, offset: int = 0) -> dict:
    """Read up to 8,000 characters from a text artifact. Pass next_offset to continue."""
    if name == "preview.png":
        raise ValueError("Use a text artifact.")
    return read_window(artifact_path(run_folder(run_id), attempt, name), offset)


def read_window(path, offset):
    if offset < 0:
        raise ValueError("Use a nonnegative character offset.")
    with path.open(errors="replace") as file:
        remaining = offset
        while remaining:
            skipped = file.read(min(remaining, 8000))
            if not skipped:
                break
            remaining -= len(skipped)
        excerpt = file.read(8001)
    return {"text": excerpt[:8000], "next_offset": offset + 8000 if len(excerpt) > 8000 else None}


@mcp.tool()
def cancel_run(run_id: str) -> dict:
    """Cancel the active run."""
    request_cancel(run_folder(run_id))
    return {"run_id": run_id, "status": "cancelling"}


@mcp.tool()
def add_note(run_id: str, text: str, agent_name: str = "", ctx: Context = None) -> dict:
    """Attach a note to a run, such as a conclusion or what to try next. Humans see it on the run page."""
    return append_note(run_folder(run_id), agent_origin(agent_name, ctx), text)


# Authoring tools

def authoring_root():
    return ROOT / "authoring"


@mcp.tool()
def query_authoring(days: float = 30, filters: dict[str, str] | None = None, text: str | None = None,
                    group_by: list[str] | None = None, limit: int = 25, offset: int = 0) -> dict:
    """Compare everyday authoring turns. Filters and group_by (up to two) take client, model, effort,
    surface, change, tool, prompt, instruction, target, status, contract, day or week; text matches the
    prompt excerpt. Filtering or grouping by change, target, status or contract narrows each turn to its
    matching revisions. Each group reports turns, views, revision check statuses and pass rate, seconds,
    token and tool-call distributions, tool error rate and top tools. breakdown counts the selection by every
    dimension; turns pages through matching turns, newest first. group_by defaults to client; pass [] for none."""
    return authoring_report.query(authoring_root(), days, filters, text,
                                  ["client"] if group_by is None else group_by, limit, offset)


@mcp.tool()
def authoring_failures(days: float = 30, filters: dict[str, str] | None = None, text: str | None = None,
                       limit: int = 20) -> dict:
    """Cluster check diagnostics of authoring revisions into recurring patterns, ranked by revisions
    affected, with stage, error code, affected views, clients, models and example messages. Takes the same
    filters as query_authoring. A cluster spanning unrelated views often points at the checker, not the work."""
    return authoring_report.failures(authoring_root(), days, filters, text, limit)


@mcp.tool()
def get_authoring_view(surface: str, target: str) -> dict:
    """One view's authoring history (surface checkout or workshop, target the view slug): statistics, the
    sequence of check statuses, the first passing turn with the turns, time, tokens and tool calls it took,
    commits, notes and the full timeline."""
    return authoring_report.view_history(authoring_root(), surface, target)


@mcp.tool()
def get_authoring_turn(turn_id: str) -> dict:
    """Everything recorded for one turn: prompt excerpt and fingerprints, instruction files, models, effort,
    usage, views read and in the baseline, every tool call with timing, sizes and status, and each revision
    with its check stages, diagnostics and the files you can read with read_authoring_check_file."""
    return authoring_report.turn_detail(authoring_root(), turn_id)


@mcp.tool()
def read_authoring_transcript(turn_id: str, offset: int = 0, limit: int = 40, max_chars: int = 1500,
                              kinds: list[str] | None = None) -> dict:
    """Read a turn's conversation from the client's own transcript, condensed into events: user, assistant,
    thinking, context, tool_call and tool_result. Each event's text is clipped to max_chars, with chars giving
    the full length; to read one event in full, pass its index as offset, limit 1 and a larger max_chars.
    kinds keeps only those event kinds. Transcripts are read on demand and never stored."""
    return authoring_report.transcript(authoring_root(), turn_id, offset, limit, max_chars, kinds)


@mcp.tool()
def read_authoring_check_file(check_key: str, name: str, offset: int = 0) -> dict:
    """Read up to 8,000 characters of a checked revision: the captured view.yml, activity.html, activity.css,
    activity.js, _shared.js or _frame.css, or the checker's check.json and snapshot.json. Pass next_offset
    to continue."""
    return read_window(authoring_report.check_file(authoring_root(), check_key, name), offset)


@mcp.tool()
def add_authoring_note(surface: str, target: str, text: str, agent_name: str = "", ctx: Context = None) -> dict:
    """Attach a note to a view's authoring history, such as a finding or what to change in the workflow.
    Humans see it on the view's Authoring page, and get_authoring_view returns theirs."""
    return authoring_report.add_note(authoring_root(), surface, target, agent_origin(agent_name, ctx), text, now())


def request_cancel(folder):
    if jobs.active_job(ROOT) != folder.name or jobs.job_state(folder).get("status") not in jobs.ACTIVE:
        raise ValueError("This run is not active.")
    (folder / "cancel.request").touch()


# Human pages

def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_hex(32)
    return session["csrf"]


def check_csrf():
    token = session.get("csrf")
    if not token or not secrets.compare_digest(token, request.form.get("csrf", "")):
        abort(403)


@flask.context_processor
def shared_context():
    if "active_job" not in g:
        g.active_job = jobs.active_job(ROOT)
    return {"active_job": g.active_job, "tiers": TIERS, "csrf": csrf_token()}


@flask.get("/")
def runs_page():
    origin = request.args.get("origin", "all")
    runs = list(all_runs())
    current = [run for run in runs if not run["legacy"]
               and (origin == "all" or (run.get("origin") or {}).get("kind") == origin)]
    return render_template("runs.html", runs=current, legacy=[run for run in runs if run["legacy"]], origin=origin)


def form_defaults(options, models, source=None):
    preferred = next((model for model in ("qwen3.5:4b", "qwen3.5:9b") if model in models), models[0] if models else "")
    defaults = options["armDefaults"]
    arms = [{**defaults, "model": preferred, "enabled": True},
            {**defaults, "model": preferred, "examples": "retrieved", "enabled": True},
            {**defaults, "model": preferred, "enabled": False},
            {**defaults, "model": "checked-in", "enabled": False}]
    form = {"hypothesis": "", "target": "fixtures", "fixtures": [item["name"] for item in options["fixtures"]],
            "brief": "", "arms": arms}
    if source:
        form["hypothesis"] = source.get("hypothesis", "")
        form["target"] = "brief" if source.get("brief") else "fixtures"
        form["fixtures"] = source.get("fixtures", form["fixtures"])
        form["brief"] = source.get("brief", "")
        for index in range(4):
            given = source.get("arms", [])[index] if index < len(source.get("arms", [])) else None
            form["arms"][index] = {**defaults, **(given or {}), "enabled": given is not None}
            if not given:
                form["arms"][index]["model"] = preferred
    return form


def form_spec(form):
    def number(value, kind):
        try:
            return kind(value)
        except (TypeError, ValueError):
            return value
    arms = []
    for index in range(4):
        prefix = f"arm-{index}-"
        if not form.get(prefix + "enabled"):
            continue
        arms.append({"model": form.get(prefix + "model", ""), "examples": form.get(prefix + "examples"),
                     "samples": number(form.get(prefix + "samples"), int),
                     "temperature": number(form.get(prefix + "temperature"), float),
                     "repair": form.get(prefix + "repair"), "format": form.get(prefix + "format")})
    spec = {"hypothesis": form.get("hypothesis", ""), "arms": arms}
    if form.get("target") == "brief":
        spec["brief"] = form.get("brief", "")
    else:
        spec["fixtures"] = form.getlist("fixture")
    return spec


def render_new(form, error=None, status=200):
    models, model_error = jobs.models()
    try:
        options = jobs.describe()
    except (OSError, ValueError, subprocess.SubprocessError) as failure:
        abort(500, f"The runner is unavailable: {failure}")
    return render_template("new.html", options=options, models=models, model_error=model_error,
                           form=form or form_defaults(options, models), error=error), status


@flask.get("/authoring")
def authoring_page():
    return render_authoring(**authoring_report.overview(authoring_root(), request.args))


@flask.get("/authoring/<surface>/<target>")
def authoring_view(surface, target):
    if surface not in ("checkout", "workshop"):
        abort(404)
    _, turns = authoring_report.read_activity(authoring_root(), surface=surface, target=target)
    if not turns:
        abort(404)
    first_pass = next((turn for turn in reversed(turns)
                       if any(item["status"] == "pass" for item in turn["revisions"])), None)
    return render_authoring(turns=turns, target=target, surface=surface, first_pass=first_pass,
                            notes=authoring_report.read_notes(authoring_root(), surface, target))


@flask.post("/authoring/<surface>/<target>/notes")
def authoring_note_page(surface, target):
    check_csrf()
    try:
        authoring_report.add_note(authoring_root(), surface, target, {"kind": "human", "name": "dashboard"},
                                  request.form.get("text", ""), now())
    except LookupError:
        abort(404)
    except ValueError as error:
        abort(400, str(error))
    return redirect(url_for("authoring_view", surface=surface, target=target) + "#notes", code=303)


def render_authoring(**context):
    response = flask.make_response(render_template("authoring.html", **context))
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
    return response


@flask.get("/new")
def new_page():
    source = None
    if request.args.get("from"):
        try:
            source = read_json(run_folder(request.args["from"]) / "experiment.json", {})
        except FileNotFoundError:
            abort(404)
    models, _ = jobs.models()
    form = form_defaults(jobs.describe(), models, source) if source else None
    return render_new(form)


@flask.post("/runs")
def create_run():
    check_csrf()
    spec = form_spec(request.form)
    echo = {"hypothesis": spec["hypothesis"], "target": request.form.get("target", "fixtures"),
            "fixtures": request.form.getlist("fixture"), "brief": request.form.get("brief", ""),
            "arms": [{"enabled": bool(request.form.get(f"arm-{index}-enabled")),
                      **{key: request.form.get(f"arm-{index}-{key}") for key in
                         ("model", "examples", "samples", "temperature", "repair", "format")}} for index in range(4)]}
    try:
        run_id, started = start(spec, {"kind": "human", "name": "dashboard"})
    except jobs.SpecError as error:
        return render_new(echo, str(error).removeprefix("Invalid run spec: "), 400)
    if not started:
        return render_new(echo, "Another run is active. Wait for it to finish or cancel it first.", 409)
    return redirect(url_for("run_page", run_id=run_id), code=303)


def run_log(folder):
    try:
        with (folder / "runner.log").open("rb") as log:
            log.seek(max(0, log.seek(0, 2) - 12000))
            return log.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


@flask.get("/runs/<run_id>")
def run_page(run_id):
    try:
        folder = run_folder(run_id)
    except FileNotFoundError:
        abort(404)
    run = load_run(folder)
    if run["legacy"]:
        return render_template("legacy.html", run=run)
    active = run["status"] in jobs.ACTIVE
    return render_template("run.html", run=run, active=active, log=run_log(folder))


@flask.get("/runs/<run_id>/samples/<arm>/<fixture>/<int:sample>")
def sample_page(run_id, arm, fixture, sample):
    try:
        folder, item = find_sample(run_id, arm, fixture, sample)
    except FileNotFoundError:
        abort(404)
    spec = read_json(folder / "experiment.json", {})
    arm_spec = next((value for value in spec.get("arms", []) if value.get("id") == arm), {})
    return render_template("sample.html", run_id=run_id, sample=item, arm=arm_spec, spec=spec)


@flask.post("/runs/<run_id>/cancel")
def cancel_page(run_id):
    check_csrf()
    try:
        request_cancel(run_folder(run_id))
    except FileNotFoundError:
        abort(404)
    except ValueError as error:
        abort(409, str(error))
    return redirect(url_for("run_page", run_id=run_id), code=303)


@flask.post("/runs/<run_id>/notes")
def note_page(run_id):
    check_csrf()
    try:
        append_note(run_folder(run_id), {"kind": "human", "name": "dashboard"}, request.form.get("text", ""))
    except FileNotFoundError:
        abort(404)
    except ValueError as error:
        abort(400, str(error))
    return redirect(url_for("run_page", run_id=run_id) + "#notes", code=303)


# JSON API, mirroring the agent tools

def json_body():
    if not request.is_json:
        abort(415, "Send application/json")
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        abort(400, "Expected a JSON object")
    return body


@flask.get("/api/options")
def api_options():
    return jsonify(describe_options())


@flask.get("/api/runs")
def api_runs():
    try:
        return jsonify(list_runs(request.args.get("origin", "all"), int(request.args.get("limit", "20")),
                                 request.args.get("include_legacy") == "true"))
    except ValueError as error:
        return jsonify(error=str(error)), 400


@flask.post("/api/runs")
def api_start():
    body = json_body()
    try:
        run_id, started = start({key: body.get(key) for key in ("hypothesis", "arms", "fixtures", "brief")},
                                agent_origin(body.get("agent_name")))
    except jobs.SpecError as error:
        return jsonify(error=str(error)), 400
    if not started:
        return jsonify(error=f"Run {run_id} is active", active_run=run_id), 409
    return jsonify(run_id=run_id, url=f"/runs/{run_id}"), 201


@flask.get("/api/runs/<run_id>")
def api_run(run_id):
    try:
        return jsonify(get_run(run_id))
    except FileNotFoundError:
        return jsonify(error="Run not found"), 404


@flask.get("/api/runs/<run_id>/samples/<arm>/<fixture>/<int:sample>")
def api_sample(run_id, arm, fixture, sample):
    try:
        return jsonify(get_sample(run_id, arm, fixture, sample))
    except FileNotFoundError:
        return jsonify(error="Sample not found"), 404


@flask.post("/api/runs/<run_id>/notes")
def api_note(run_id):
    body = json_body()
    try:
        return jsonify(append_note(run_folder(run_id), agent_origin(body.get("agent_name")), body.get("text"))), 201
    except FileNotFoundError:
        return jsonify(error="Run not found"), 404
    except ValueError as error:
        return jsonify(error=str(error)), 400


@flask.post("/api/runs/<run_id>/cancel")
def api_cancel(run_id):
    json_body()
    try:
        return jsonify(cancel_run(run_id))
    except FileNotFoundError:
        return jsonify(error="Run not found"), 404
    except ValueError as error:
        return jsonify(error=str(error)), 409


@flask.get("/api/runs/<run_id>/artifacts/<attempt>/<name>")
def download(run_id, attempt, name):
    try:
        path = artifact_path(run_folder(run_id), attempt, name)
    except FileNotFoundError:
        return jsonify(error="Artifact not found"), 404
    inline = name == "preview.png" or request.args.get("view") == "1"
    response = send_file(
        path, mimetype="image/png" if name == "preview.png" else "text/plain" if inline else "application/octet-stream",
        as_attachment=not inline, download_name=name,
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'"
    return response


def authoring_api(call, *args, **kwargs):
    try:
        return jsonify(call(*args, **kwargs))
    except LookupError as error:
        return jsonify(error=str(error)), 404
    except (ValueError, TypeError) as error:
        return jsonify(error=str(error)), 400


def query_args():
    args = request.args
    names = authoring_report.ANALYSIS_FIELDS
    group = args.get("group_by")
    return {"days": float(args.get("days", 30)), "text": args.get("text") or None,
            "filters": {name: args[name] for name in names if args.get(name)},
            "group_by": None if group is None else [item for item in group.split(",") if item]}


@flask.get("/api/authoring")
def api_authoring():
    try:
        options = query_args()
        options |= {"limit": int(request.args.get("limit", 25)), "offset": int(request.args.get("offset", 0))}
    except ValueError:
        return jsonify(error="days, limit and offset must be numbers"), 400
    return authoring_api(query_authoring, **options)


@flask.get("/api/authoring/failures")
def api_authoring_failures():
    try:
        options = query_args()
        options.pop("group_by")
        options["limit"] = int(request.args.get("limit", 20))
    except ValueError:
        return jsonify(error="days and limit must be numbers"), 400
    return authoring_api(authoring_failures, **options)


@flask.get("/api/authoring/views/<surface>/<target>")
def api_authoring_view(surface, target):
    return authoring_api(get_authoring_view, surface, target)


@flask.post("/api/authoring/views/<surface>/<target>/notes")
def api_authoring_note(surface, target):
    body = json_body()
    try:
        note = authoring_report.add_note(authoring_root(), surface, target, agent_origin(body.get("agent_name")),
                                         body.get("text"), now())
    except LookupError as error:
        return jsonify(error=str(error)), 404
    except ValueError as error:
        return jsonify(error=str(error)), 400
    return jsonify(note), 201


@flask.get("/api/authoring/turns/<turn_id>")
def api_authoring_turn(turn_id):
    return authoring_api(get_authoring_turn, turn_id)


@flask.get("/api/authoring/turns/<turn_id>/transcript")
def api_authoring_transcript(turn_id):
    try:
        options = {key: int(request.args[key]) for key in ("offset", "limit", "max_chars") if key in request.args}
    except ValueError:
        return jsonify(error="offset, limit and max_chars must be numbers"), 400
    if request.args.get("kinds"):
        options["kinds"] = request.args["kinds"].split(",")
    return authoring_api(read_authoring_transcript, turn_id, **options)


@flask.get("/api/authoring/checks/<check_key>/<name>")
def api_authoring_check_file(check_key, name):
    try:
        path = authoring_report.check_file(authoring_root(), check_key, name)
    except LookupError as error:
        return jsonify(error=str(error)), 404
    response = send_file(path, mimetype="text/plain", download_name=name)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "default-src 'none'"
    return response


mcp_app = mcp.streamable_http_app()
app = TrustedHostMiddleware(
    Starlette(routes=[Route("/mcp", mcp_app, methods=["GET", "POST", "DELETE"]), Mount("/", WSGIMiddleware(flask))],
              lifespan=mcp_app.router.lifespan_context),
    allowed_hosts=["127.0.0.1", "localhost"],
)


def main():
    parser = argparse.ArgumentParser(description="Serve the local evaluation dashboard and agent API.")
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
            parser.exit(1, "Admin port unavailable. Use ADMIN_PORT=PORT mise run dev.\n")

        security = mcp.settings.transport_security
        security.allowed_hosts = [f"{host}:{port}" for host in ("127.0.0.1", "localhost")]
        security.allowed_origins = [f"http://{host}" for host in security.allowed_hosts]
        print(f"View evaluations: http://127.0.0.1:{port}", flush=True)
        print(f"Agent MCP endpoint: http://127.0.0.1:{port}/mcp", flush=True)
        config = uvicorn.Config(app, host="127.0.0.1", port=port)
        stopping = threading.Event()
        worker = threading.Thread(target=authoring.worker, args=(ROOT / "authoring", stopping), daemon=True)
        worker.start()
        try:
            uvicorn.Server(config).run(sockets=[listener])
        finally:
            stopping.set()
            worker.join(timeout=1)


if __name__ == "__main__":
    main()
