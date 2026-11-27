"""Local capture hooks and background authoring checks."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path
from uuid import uuid4

import authoring_logs as logs

PROJECT = Path(__file__).resolve().parents[2]
WORKSHOP = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "vizint-workshop/workspaces"
TAG = "vizint-authoring-hook"
CLIENTS = ("codex", "claude")
EVENTS = ("UserPromptSubmit", "PostToolUse", "Stop")
SOURCE = ("view.yml", "activity.html", "activity.css", "activity.js")
WORKSHOP_SOURCE = ("viz.ts", "package.json", "view.tsx", "view.json")
WORKSHOP_DIRS = ("files", "gestalts", "data")
MAX_INPUT_BYTES = 24 * 1024 * 1024
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def source_id(data):
    # Git's blob IDs let the worker compare large asset directories from the tree alone.
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data, usedforsecurity=False).hexdigest() + ":" + digest(header + data)


def fingerprint(value):
    return digest(value.encode())


def git(root, *args):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=5)
    return result.stdout if not result.returncode else b""


def scope(cwd):
    if not cwd:
        return None
    cwd = Path(cwd).resolve()
    if cwd.is_relative_to(WORKSHOP) and cwd != WORKSHOP:
        return "workshop", WORKSHOP / cwd.relative_to(WORKSHOP).parts[0]
    if cwd.is_relative_to(PROJECT):
        return "checkout", PROJECT
    common = PROJECT / ".git/worktrees"
    # Only Git worktrees registered to this repository are eligible outside it.
    for pointer in common.glob("*/gitdir"):
        try:
            root = Path(pointer.read_text().strip()).parent.resolve()
            if root != cwd and not cwd.is_relative_to(root):
                continue
            return "checkout", root
        except OSError:
            continue
    return None


def connect(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(root / "authoring.sqlite", timeout=2)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS turns (
            id TEXT PRIMARY KEY, client TEXT, session TEXT, native TEXT, transcript TEXT,
            surface TEXT, workspace TEXT, started REAL, ended REAL, seconds REAL,
            prompt TEXT, prompt_hash TEXT, instructions TEXT, baseline TEXT, reads TEXT DEFAULT '[]',
            uncertain INTEGER DEFAULT 0, models TEXT DEFAULT '[]', efforts TEXT DEFAULT '[]',
            usage TEXT DEFAULT '{}', tools TEXT DEFAULT '{}', origin TEXT DEFAULT 'hook'
        );
        CREATE INDEX IF NOT EXISTS authoring_session ON turns(client, session, started);
        CREATE TABLE IF NOT EXISTS checks (
            key TEXT PRIMARY KEY, status TEXT, contract TEXT, diagnostics TEXT DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS revisions (
            turn TEXT, target TEXT, revision TEXT, change TEXT, check_key TEXT, commit_hash TEXT,
            PRIMARY KEY (turn, target)
        );
        CREATE TABLE IF NOT EXISTS transcripts (path TEXT PRIMARY KEY, seen TEXT);
    """)
    return db


@contextlib.contextmanager
def database(root):
    with contextlib.closing(connect(root)) as db, db:
        yield db


def read(path):
    if path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_INPUT_BYTES:
        return path.read_bytes()
    return None


def manifest(root, base, names, directories=()):
    paths = [base / name for name in names]
    for name in directories:
        folder = base / name
        if not folder.is_symlink():
            paths.extend(path for path in folder.rglob("*") if not path.is_symlink() and path.is_file())
    return {str(path.relative_to(root)): source_id(data) for path in sorted(paths)
            if path.resolve().is_relative_to(root) and (data := read(path)) is not None}


def sources(surface, work):
    if surface == "workshop":
        return {work.name: manifest(work, work, WORKSHOP_SOURCE, WORKSHOP_DIRS)}
    result = {}
    for folder in (work / "src/views").glob("*"):
        if folder.is_symlink() or not folder.is_dir() or not SLUG.fullmatch(folder.name):
            continue
        config = read(folder / "view.yml")
        asset_dir = manifest_field(config, "assets", rb"[a-z0-9]+(?:-[a-z0-9]+)*")
        files = manifest(work, folder, (*SOURCE, "host.mjs", "content.mjs"), (asset_dir,) if asset_dir else ())
        if config:
            shared = manifest_field(config, "sharedScript", rb"src/[\w-]+\.js")
            if shared and (data := read(work / shared)) is not None:
                files[shared] = source_id(data)
        result[folder.name] = files
    return result


def manifest_field(config, key, pattern):
    if config:
        match = re.search(rb"(?m)^" + key.encode() + rb""":[ \t]*['"]?("""
                          + pattern + rb""")['"]?[ \t]*(?:#[^\n]*)?$""", config)
        if match:
            return match[1].decode()
    return None


def instruction_hashes(work, cwd):
    names = ("AGENTS.md", "CLAUDE.md", "SPEC.md", "AGENTS.override.md")
    here = Path(cwd).resolve()
    if not here.is_relative_to(work):
        here = work
    return {str(path.relative_to(work)): digest(data)
            for directory in [here, *here.parents] if directory.is_relative_to(work)
            for name in names if (data := read(path := directory / name)) is not None}


def checker_version():
    paths = ("authoring-check.mjs", "view-draft-check.mjs", "activity-frame.mjs", "activity-program.mjs",
             "activity-libraries.mjs", "view-generation-fixtures.mjs")
    return fingerprint("".join(digest((PROJECT / "scripts" / path).read_bytes()) for path in paths)
                       + digest((PROJECT / "package-lock.json").read_bytes()))


def prepare_check(root, work, target, files, revision):
    frame = read(work / "src/frame.css")
    key = fingerprint(revision + checker_version() + target + (digest(frame) if frame is not None else ""))
    folder = root / "authoring-checks" / key
    snapshot = {"files": files, "view": target}
    config = read(work / "src/views" / target / "view.yml")
    assets = manifest_field(config, "assets", rb"[a-z0-9]+(?:-[a-z0-9]+)*")
    if assets:
        snapshot["assets"] = f"src/views/{target}/{assets}/"
    if (folder / "snapshot.json").exists():
        return key
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    prefix = f"src/views/{target}/"
    if frame is not None:
        (folder / "_frame.css").write_bytes(frame)
    for path, sha in files.items():
        name = path.removeprefix(prefix)
        if name not in SOURCE and not re.fullmatch(r"src/[\w-]+\.js", path):
            continue
        data = read(work / path)
        if data is None or source_id(data) != sha:
            snapshot["changed"] = True
            break
        (folder / (name if name in SOURCE else "_shared.js")).write_bytes(data)
    (folder / "snapshot.json").write_text(json.dumps(snapshot))
    return key


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def target_for_path(work, value):
    if not isinstance(value, str) or not value:
        return None
    path = (work / value).resolve()
    if not path.is_relative_to(work / "src/views"):
        return None
    parts = path.relative_to(work / "src/views").parts
    if parts and SLUG.fullmatch(parts[0]):
        return parts[0]


def hook(root, client, payload):
    cwd = payload.get("cwd")
    location = scope(cwd)
    session = payload.get("session_id")
    if not location or not isinstance(session, str):
        return
    surface, work = location
    event = payload.get("hook_event_name")
    native = payload.get("turn_id")
    at = time.time()
    with database(root) as db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT 1 FROM settings WHERE key='enabled' AND value='1'").fetchone():
            return
        turn = db.execute("""SELECT * FROM turns WHERE client=? AND session=? AND origin='hook'
                            AND (native=? OR ended IS NULL) ORDER BY started DESC LIMIT 1""",
                          (client, session, native)).fetchone()
        if event == "UserPromptSubmit":
            if native and turn and turn["native"] == native:
                return
            # A new prompt supersedes an interrupted prompt in the same session.
            db.execute("UPDATE turns SET ended=?, uncertain=1 WHERE client=? AND session=? AND ended IS NULL",
                       (at, client, session))
            overlap = db.execute("""UPDATE turns SET uncertain=1 WHERE workspace=? AND ended IS NULL
                                  AND started > ?""", (str(work), at - 86400)).rowcount
            prompt = payload.get("prompt") or ""
            db.execute("""INSERT INTO turns (id,client,session,native,transcript,surface,workspace,started,
                       prompt,prompt_hash,instructions,baseline,uncertain,models)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (uuid4().hex, client, session, native, payload.get("transcript_path"), surface, str(work), at,
                        prompt[:300], fingerprint(prompt) if prompt else None, dump(instruction_hashes(work, cwd)),
                        dump(sources(surface, work)), bool(overlap), dump([payload["model"]] if payload.get("model") else [])))
            return
        if not turn or turn["ended"] is not None:
            return
        if event == "PostToolUse":
            observe_tool(db, turn, work, payload, at)
        if event == "Stop":
            stop_turn(db, root, turn, work, at)


def observe_tool(db, turn, work, payload, at):
    tool_input = payload.get("tool_input") or {}
    name = payload.get("tool_name")
    if not isinstance(tool_input, dict):
        tool_input = {}
    reads = set(json.loads(turn["reads"]))
    reads.update(target for key in ("file_path", "path")
                 if (target := target_for_path(work, tool_input.get(key))))
    command = tool_input.get("command")
    if isinstance(command, str):
        reads.update(re.findall(r"(?<![\w-])src/views/([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])", command))
    tools = json.loads(turn["tools"])
    is_workshop_check = turn["surface"] == "workshop" and logs.is_check(tool_input)
    if name:
        tool_id = payload.get("tool_use_id") or payload.get("call_id") or uuid4().hex
        output = payload.get("tool_response")
        tool = {"name": name, "at": at, "argument_bytes": len(dump(tool_input).encode())}
        if output is not None:
            tool["result_bytes"] = len(dump(output).encode())
        if is_workshop_check:
            display = output.get("stdout", "") if isinstance(output, dict) else output
            status = logs.checked(display, isinstance(output, dict) and output.get("interrupted", False))
            if status:
                tool["check_status"] = status
                tool["check_revision"] = fingerprint(dump(sources("workshop", work).get(work.name, {})))
        tools[tool_id] = tool
    db.execute("UPDATE turns SET reads=?,tools=? WHERE id=?", (dump(sorted(reads)), dump(tools), turn["id"]))


def stop_turn(db, root, turn, work, at):
    baseline = json.loads(turn["baseline"])
    latest = sources(turn["surface"], work)
    touched = set(json.loads(turn["reads"]))
    tools = json.loads(turn["tools"])
    for target in sorted(set(baseline) | set(latest) | touched):
        before = baseline.get(target, {})
        after = latest.get(target, {})
        changed = before != after
        if not changed and target not in touched and turn["surface"] != "workshop":
            continue
        revision = fingerprint(dump(after)) if changed else None
        change = ("new" if not before else "existing") if changed else "read"
        key = None
        if changed and turn["surface"] == "checkout" and not turn["uncertain"]:
            key = prepare_check(root, work, target, after, revision)
            db.execute("INSERT OR IGNORE INTO checks(key,status,contract) VALUES(?,'queued','Checkout')", (key,))
        if turn["surface"] == "workshop" and not turn["uncertain"]:
            check_revision = fingerprint(dump(after))
            observed = sorted((tool for tool in tools.values() if tool.get("check_revision") == check_revision),
                              key=lambda tool: tool["at"])
            if observed:
                revision = check_revision
                key = fingerprint(turn["id"] + revision + "workshop")
                db.execute("INSERT OR IGNORE INTO checks(key,status,contract) VALUES(?,?,'Workshop')",
                           (key, observed[-1]["check_status"]))
        db.execute("INSERT OR IGNORE INTO revisions(turn,target,revision,change,check_key) VALUES(?,?,?,?,?)",
                   (turn["id"], target, revision, change, key))
    db.execute("UPDATE turns SET ended=?,seconds=? WHERE id=?", (at, max(0, at - turn["started"]), turn["id"]))


def setup(root, disable=False):
    home = Path.home()
    script = Path(__file__).resolve()
    for client, path in (("codex", Path(os.environ.get("CODEX_HOME", home / ".codex")) / "hooks.json"),
                         ("claude", Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude")) / "settings.json")):
        if not path.exists() and disable:
            continue
        data = json.loads(path.read_text()) if path.exists() else {}
        hooks = data.setdefault("hooks", {})
        for event in EVENTS:
            groups = hooks.get(event, [])
            kept = []
            for group in groups:
                handlers = [handler for handler in group.get("hooks", []) if TAG not in handler.get("command", "")]
                if handlers:
                    kept.append({**group, "hooks": handlers})
            if not disable:
                command = shlex.join([sys.executable, str(script), TAG, client])
                kept.append({"hooks": [{"type": "command", "command": command, "timeout": 5}]})
            if kept:
                hooks[event] = kept
            else:
                hooks.pop(event, None)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = path.resolve()
        temp = path.with_name("." + path.name + "." + uuid4().hex)
        try:
            temp.touch(mode=0o600, exist_ok=False)
            temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            if path.exists():
                temp.chmod(path.stat().st_mode & 0o777)
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)
    with database(root) as db:
        was_enabled = db.execute("SELECT 1 FROM settings WHERE key='enabled' AND value='1'").fetchone()
        db.execute("INSERT OR REPLACE INTO settings VALUES('enabled',?)", ("0" if disable else "1",))
        if not disable and not was_enabled:
            db.execute("INSERT OR REPLACE INTO settings VALUES('enabled_at',?)", (str(time.time()),))
    print("Vizint authoring tracking disabled." if disable else
          "Vizint authoring tracking enabled. Start new client sessions and trust the new hooks if prompted.")


def client_paths(enabled_at, tracked):
    home = Path.home()
    codex = Path(os.environ.get("CODEX_HOME", home / ".codex")) / "sessions"
    claude = Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude")) / "projects"
    paths = {}
    for client, session, path in tracked:
        if path:
            paths.setdefault((client, Path(path)), set()).add(session)
    if WORKSHOP.is_dir():
        prefix = re.sub(r"[^a-zA-Z0-9]", "-", str(WORKSHOP))
        for path in claude.glob(f"{prefix}-*/*.jsonl"):
            paths.setdefault(("claude", path), set()).add(path.stem)
        # Rollout dates cover likely bridge sessions. Verify cwd before parsing a rollout.
        for path in codex.rglob("rollout-*.jsonl"):
            try:
                if path.stat().st_mtime < enabled_at:
                    continue
                with path.open("rb") as stream:
                    payload = json.loads(stream.readline()).get("payload", {})
                cwd = Path(payload.get("cwd") or "/")
                if cwd.is_relative_to(WORKSHOP):
                    paths.setdefault(("codex", path), set()).add(payload.get("id") or payload.get("session_id"))
            except (OSError, ValueError, TypeError):
                continue
    return paths


def match_turn(rows, item):
    rows = list(rows)
    native = item["native"]
    if native:
        found = next((row for row in rows if row["native"] == native), None)
        if found:
            return found
    prompt = item["prompt"]
    checksum = fingerprint(prompt) if isinstance(prompt, str) and prompt else None
    nearby = sorted((row for row in rows if row["prompt_hash"] == checksum
                     and abs(row["started"] - item["start"]) <= 60),
                    key=lambda row: abs(row["started"] - item["start"]))
    return nearby[0] if nearby else None


def merge_tools(hooked, transcript):
    tools = {key: {**value, **hooked.get(key, {})} for key, value in transcript.items()}
    paired = set()
    for key, tool in hooked.items():
        if key in tools:
            continue
        # A hook may omit the call ID. Pair it once with the nearest completed call of that name.
        named = [(known, value) for known, value in tools.items() if known in transcript and known not in hooked and known not in paired
                 and value.get("name") == tool.get("name")]
        if named:
            closest, previous = min(named, key=lambda item: abs(item[1].get("at", 0) - tool.get("at", 0)))
            tools[closest] = {**previous, **tool}
            paired.add(closest)
        else:
            tools[key] = tool
    return tools


def sync_file(root, client, path, sessions, cutoff, mark):
    items = logs.parse(path, client, scope)
    with database(root) as db:
        db.execute("BEGIN IMMEDIATE")
        hooked = defaultdict(list)
        for session in sessions:
            for row in db.execute("""SELECT * FROM turns WHERE client=? AND session=? AND origin='hook'""",
                                  (client, session)):
                hooked[row["session"]].append(row)
        candidates = [row for rows in hooked.values() for row in rows]
        matched = set()
        for item in items:
            if not item["start"] or item["start"] < cutoff:
                continue
            match = match_turn((row for row in candidates if row["id"] not in matched), item)
            if match:
                matched.add(match["id"])
                end = item.get("end")
                # A late transcript can preserve usage for interruptions even if Stop never ran.
                db.execute("""UPDATE turns SET models=?,efforts=?,usage=?,tools=?,native=COALESCE(native,?),
                             seconds=COALESCE(?,seconds) WHERE id=?""",
                           (dump(item["models"]) if item["models"] else match["models"], dump(item["efforts"]),
                            dump(item["usage"]), dump(merge_tools(json.loads(match["tools"]), item["tools"])),
                            item["native"], item.get("seconds") if end else None, match["id"]))
                if item["native"]:
                    for session in sessions:
                        fallback = fingerprint(f"{client}:{session}:{item['native']}")
                        db.execute("DELETE FROM revisions WHERE turn=?", (fallback,))
                        db.execute("DELETE FROM turns WHERE id=? AND origin='log'", (fallback,))
                continue
            location = scope(item["cwd"])
            if not location or location[0] != "workshop" or not item["native"] or not sessions:
                continue
            session = next(iter(sessions))
            work = location[1]
            turn_id = fingerprint(f"{client}:{session}:{item['native']}")
            prompt = item["prompt"] if isinstance(item["prompt"], str) else ""
            db.execute("""INSERT INTO turns(id,client,session,native,transcript,surface,workspace,started,ended,
                         seconds,prompt,prompt_hash,models,efforts,usage,tools,origin)
                         VALUES(?,?,?,?,?,'workshop',?,?,?,?,?,?,?,?,?,?,'log')
                         ON CONFLICT(id) DO UPDATE SET ended=excluded.ended,seconds=excluded.seconds,
                         models=excluded.models,efforts=excluded.efforts,usage=excluded.usage,tools=excluded.tools""",
                       (turn_id, client, session, item["native"], str(path), str(work), item["start"],
                        item.get("end"), item.get("seconds"), prompt[:300], fingerprint(prompt) if prompt else None,
                        dump(item["models"]), dump(item["efforts"]), dump(item["usage"]), dump(item["tools"])))
            db.execute("INSERT OR IGNORE INTO revisions(turn,target,change) VALUES(?,?,'observed')", (turn_id, work.name))
        db.execute("INSERT OR REPLACE INTO transcripts VALUES(?,?)", (str(path), mark))


def sync_transcripts(root):
    with database(root) as db:
        settings = dict(db.execute("SELECT key,value FROM settings"))
        if settings.get("enabled") != "1":
            return
        cutoff = float(settings["enabled_at"])
        tracked = db.execute("SELECT DISTINCT client, session, transcript FROM turns WHERE transcript IS NOT NULL").fetchall()
        seen = dict(db.execute("SELECT path,seen FROM transcripts"))
    for (client, path), sessions in client_paths(cutoff, tracked).items():
        try:
            if not path.is_file():
                continue
            stat = path.stat()
            mark = f"{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}:{','.join(sorted(str(s) for s in sessions))}"
            if seen.get(str(path)) != mark:
                sync_file(root, client, path, sessions - {None}, cutoff, mark)
        except (OSError, ValueError, TypeError):
            continue


def execute_check(root, key):
    folder = root / "authoring-checks" / key
    try:
        snapshot = json.loads((folder / "snapshot.json").read_text())
        if snapshot.get("changed"):
            raise ValueError("The view changed while the revision was being captured.")
        (folder / "check.json").unlink(missing_ok=True)
        command = [shutil.which("node") or "node", str(PROJECT / "scripts/authoring-check.mjs"), str(folder), snapshot["view"]]
        invocation = subprocess.run(command, cwd=PROJECT, capture_output=True, timeout=50)
        if invocation.returncode:
            raise ValueError(invocation.stderr.decode(errors="replace").strip()[-500:] or "Checker exited early.")
        result = json.loads((folder / "check.json").read_text())
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        result = {"status": "unavailable", "contract": "Checkout", "diagnostics": [{"message": str(error)}]}
    with database(root) as db:
        db.execute("UPDATE checks SET status=?,contract=?,diagnostics=? WHERE key=?",
                   (result["status"], result["contract"], dump(result["diagnostics"]), key))


def committed(work, snapshot, revisions):
    """Find an exact source match in commits reached after the turn began."""
    paths = snapshot["files"]
    if not paths or not revisions:
        return None
    view_dir = f"src/views/{snapshot['view']}"
    extra = [path for path in paths if not path.startswith(view_dir + "/")]
    object_format = git(work, "rev-parse", "--show-object-format").strip()
    if object_format not in (b"sha1", b"sha256"):
        return None
    index = 0 if object_format == b"sha1" else 1
    expected = {path: value.split(":")[index] for path, value in paths.items() if ":" in value}
    if len(expected) != len(paths):
        return None
    for rev in revisions:
        tree = git(work, "ls-tree", "-r", "-z", rev, "--", view_dir, *extra)
        entries = {}
        for item in tree.split(b"\0"):
            if not item:
                continue
            header, path = item.split(b"\t", 1)
            kind, object_id = header.split()[1:]
            name = path.decode(errors="replace")
            if kind == b"blob" and (name in paths or relevant_checkout_path(name, snapshot["view"], snapshot.get("assets"))):
                entries[name] = object_id.decode()
        if entries == expected:
            return rev
    return None


def relevant_checkout_path(path, target, assets):
    name = path.removeprefix(f"src/views/{target}/")
    return name in (*SOURCE, "host.mjs", "content.mjs") or (assets and path.startswith(assets))


def update_commits(root, previous):
    with database(root) as db:
        active = db.execute("""SELECT DISTINCT t.workspace FROM revisions r JOIN turns t ON t.id=r.turn
                             WHERE t.surface='checkout' AND r.check_key IS NOT NULL AND r.commit_hash IS NULL""").fetchall()
    for (workspace,) in active:
        work = Path(workspace)
        head = git(work, "rev-parse", "HEAD").decode().strip()
        if not head:
            continue
        with database(root) as db:
            rows = db.execute("""SELECT r.turn,r.target,r.check_key FROM revisions r JOIN turns t ON t.id=r.turn
                               WHERE t.workspace=? AND r.commit_hash IS NULL AND r.check_key IS NOT NULL""",
                              (workspace,)).fetchall()
        pending = set()
        for row in rows:
            key = row["check_key"]
            pending.add(key)
            cache_key = (key, head)
            if cache_key in previous:
                matching = previous[cache_key]
            else:
                snapshot = json.loads((root / "authoring-checks" / key / "snapshot.json").read_text())
                history = git(work, "rev-list", "--max-count=100", head).decode().split()
                matching = committed(work, snapshot, [head, *[rev for rev in history if rev != head]])
                previous[cache_key] = matching
            if matching:
                with database(root) as db:
                    db.execute("UPDATE revisions SET commit_hash=? WHERE turn=? AND target=?",
                               (matching, row["turn"], row["target"]))
        for state in tuple(previous):
            if state[1] != head and state[0] in pending:
                previous.pop(state, None)


def worker(root, stop):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (root / "worker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        previous = {}
        while not stop.is_set():
            queued = None
            try:
                sync_transcripts(root)
                with database(root) as db:
                    queued = db.execute("SELECT key FROM checks WHERE status='queued' ORDER BY rowid LIMIT 1").fetchone()
                if queued:
                    execute_check(root, queued["key"])
                update_commits(root, previous)
            except (OSError, sqlite3.Error, ValueError, TypeError, subprocess.SubprocessError) as error:
                print(f"Authoring background worker: {error}", file=sys.stderr)
            stop.wait(0.25 if queued else 5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("setup", TAG))
    parser.add_argument("client", choices=CLIENTS, nargs="?")
    parser.add_argument("--disable", action="store_true")
    args = parser.parse_args()
    root = PROJECT / ".view-generation/authoring"
    if args.action == "setup":
        setup(root, args.disable)
    else:
        try:
            hook(root, args.client, json.load(sys.stdin))
        except (OSError, sqlite3.Error, ValueError, TypeError, subprocess.SubprocessError) as error:
            # The telemetry hook cannot be allowed to interrupt the client.
            print(f"Vizint authoring capture: {error}", file=sys.stderr)


if __name__ == "__main__":
    main()
