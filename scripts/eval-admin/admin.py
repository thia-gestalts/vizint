import argparse
import errno
import json
import socket
import re
from pathlib import Path

import uvicorn
from a2wsgi import WSGIMiddleware
from flask import Flask, abort, jsonify, render_template, request, send_file
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Mount, Route

ROOT = Path(__file__).resolve().parents[2] / ".view-generation"
RUN_ID = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}")
ATTEMPT = re.compile(r"case-[1-9]\d*-attempt-[1-9]\d*")
ARTIFACTS = ("result.json", "request.json", "response.json", "activity.html",
             "activity.css", "activity.js", "view.yml", "preview.png")
flask = Flask(__name__)
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
            outcome = "passed" if attempts[-1].get("passed") is True else "failed"
        rows.append({**row, "attempts": attempts, "status": outcome})
    return {
        "id": folder.name, "settings": read_json(folder / "run.json", {}),
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


@flask.get("/")
def dashboard():
    model = request.args.get("model") or None
    status = request.args.get("status", "all")
    try:
        runs = list_runs(model, status, 100)["runs"]
    except ValueError as error:
        abort(400, str(error))
    return render_template("index.html", runs=runs, model=model, status=status)


@flask.get("/runs/<run_id>")
def detail(run_id):
    try:
        run = get_run(run_id)
    except FileNotFoundError:
        abort(404)
    return render_template("detail.html", run=run)


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
