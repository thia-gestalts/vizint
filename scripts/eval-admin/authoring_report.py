"""Observed authoring activity, shared by the dashboard pages and the agent tools."""
import json
import os
import re
import statistics
import time
from collections import Counter, defaultdict
from datetime import datetime
from itertools import product
from pathlib import Path

import authoring_logs as logs
from authoring import database, dump, fingerprint

FIELDS = {"client": "Client", "model": "Model", "effort": "Effort", "surface": "Workspace",
          "change": "Change", "tool": "Tool used", "prompt": "Prompt fingerprint", "instruction": "Instruction fingerprint"}
# Agents can also slice by view, check outcome and time.
ANALYSIS_FIELDS = FIELDS | {"target": "View", "status": "Check status", "contract": "Check contract",
                            "day": "Day", "week": "Week"}
# Filtering or grouping on these narrows a turn to its matching revisions.
REVISION_FIELDS = {"change", "target", "status", "contract"}
CONTRACTS = {"Checkout", "Checkout with fixture", "Workshop"}
UNKNOWN = "Unknown"
SURFACES = ("checkout", "workshop")
TURN_ID = re.compile(r"[0-9a-f]{32}|[0-9a-f]{64}")
CHECK_KEY = re.compile(r"[0-9a-f]{64}")
CHECK_FILES = ("check.json", "snapshot.json", "view.yml", "activity.html", "activity.css", "activity.js",
               "_shared.js", "_frame.css")
NOTE_LIMIT = 4000
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def read_activity(root, start=None, surface=None, target=None):
    if not (root / "authoring.sqlite").exists():
        return False, []
    conditions = []
    values = []
    if start is not None:
        conditions.append("t.started>=?")
        values.append(start)
    if surface is not None:
        conditions.append("t.surface=?")
        values.append(surface)
    if target is not None:
        conditions.append("r.target=?")
        values.append(target)
    where = " WHERE " + " AND ".join(conditions) if conditions else ""
    with database(root) as db:
        enabled = bool(db.execute("SELECT 1 FROM settings WHERE key='enabled' AND value='1'").fetchone())
        rows = db.execute("""SELECT t.id,t.client,t.surface,t.started,t.ended,t.seconds,t.prompt,t.prompt_hash,t.instructions,
            t.models,t.efforts,t.usage,t.tools,t.uncertain,t.origin,r.target,r.revision,r.change,r.commit_hash,r.check_key,
            c.status,c.contract,c.diagnostics,
            (SELECT COUNT(*) FROM revisions AS linked WHERE linked.turn=t.id) AS linked FROM turns t
            JOIN revisions r ON r.turn=t.id LEFT JOIN checks c ON c.key=r.check_key"""
            + where + " ORDER BY t.started DESC,r.target", values).fetchall()
    turns = {}
    for row in rows:
        if row["id"] not in turns:
            turns[row["id"]] = turn_record(row)
        turns[row["id"]]["revisions"].append(revision_record(row))
    return enabled, list(turns.values())


def turn_record(row):
    item = {key: row[key] for key in ("id", "client", "surface", "started", "ended", "seconds",
                                      "prompt", "prompt_hash", "uncertain", "origin", "linked")}
    item |= {key: json.loads(row[key] or "{}") for key in ("usage", "tools", "instructions")}
    item["models"] = json.loads(row["models"])
    item["efforts"] = json.loads(row["efforts"])
    item["date"] = datetime.fromtimestamp(item["started"]).strftime("%Y-%m-%d %H:%M")
    item["revisions"] = []
    return item


def revision_record(row):
    revision = {key: row[key] for key in ("target", "revision", "change", "commit_hash", "check_key", "status", "contract")}
    revision["diagnostics"] = [{**item, "message": ANSI.sub("", item.get("message") or "")}
                               for item in json.loads(row["diagnostics"] or "[]") if isinstance(item, dict)]
    return revision


# Slicing

def revision_value(item, name):
    if name == "status":
        return item["status"] or ("unverified" if item["revision"] else "unchanged")
    if name == "contract":
        return item["contract"] or UNKNOWN
    return item[name]


def field_values(turn, name):
    if name in REVISION_FIELDS:
        return sorted({revision_value(item, name) for item in turn["revisions"]}) or [UNKNOWN]
    if name == "model":
        return turn["models"] or [UNKNOWN]
    if name == "effort":
        return turn["efforts"] or [UNKNOWN]
    if name == "tool":
        return sorted({tool["name"] for tool in turn["tools"].values() if tool.get("name")}) or [UNKNOWN]
    if name == "prompt":
        return [turn["prompt_hash"] or UNKNOWN]
    if name == "instruction":
        return [fingerprint(dump(turn["instructions"])) if turn["instructions"] else UNKNOWN]
    if name == "day":
        return [datetime.fromtimestamp(turn["started"]).strftime("%Y-%m-%d")]
    if name == "week":
        return [datetime.fromtimestamp(turn["started"]).strftime("%G-W%V")]
    return [turn[name]]


def narrow(turn, name, value):
    if name not in REVISION_FIELDS:
        return turn
    return {**turn, "revisions": [item for item in turn["revisions"] if revision_value(item, name) == value]}


def select(turns, filters, text=None):
    selected = []
    needle = text.casefold() if text else None
    for turn in turns:
        if needle and needle not in (turn["prompt"] or "").casefold():
            continue
        for name, value in filters.items():
            if value not in field_values(turn, name):
                break
            turn = narrow(turn, name, value)
        else:
            selected.append(turn)
    return selected


def dimensions(turns, names=FIELDS):
    return {name: sorted({value for turn in turns for value in field_values(turn, name)}) for name in names}


def bucket(turns, group_by):
    buckets = defaultdict(list)
    for turn in turns:
        for key in product(*(field_values(turn, name) for name in group_by)):
            narrowed = turn
            for name, value in zip(group_by, key):
                narrowed = narrow(narrowed, name, value)
            buckets[key].append(narrowed)
    return buckets


# Statistics

def count_median(values):
    samples = [value for value in values if value is not None]
    return {"median": round(statistics.median(samples), 1) if samples else None, "n": len(samples)}


def spread(values):
    samples = sorted(value for value in values if value is not None)
    if not samples:
        return {"n": 0}
    result = {"n": len(samples), "median": round(statistics.median(samples), 1), "total": round(sum(samples), 1),
              "max": samples[-1]}
    if len(samples) > 1:
        result["p90"] = round(statistics.quantiles(samples, n=10, method="inclusive")[-1], 1)
    return result


def unique_revisions(turns):
    """The latest record of each distinct revision; a revision can recur across turns."""
    revisions = {}
    for turn in reversed(turns):
        for item in turn["revisions"]:
            if item["revision"]:
                revisions[turn["surface"], item["target"], item["revision"]] = item
    return revisions


def summarize(turns):
    revisions = unique_revisions(turns)
    rate = {}
    for contract in sorted(CONTRACTS):
        surface = "workshop" if contract == "Workshop" else "checkout"
        subset = [row for (origin, _target, _revision), row in revisions.items()
                  if origin == surface and (row["contract"] or ("Workshop" if origin == "workshop" else "Checkout")) == contract]
        if subset:
            checked = [item for item in subset if item["status"] in ("pass", "fail")]
            rate[contract] = {"passed": sum(item["status"] == "pass" for item in checked),
                              "checked": len(checked), "observed": len(subset)}
    return {"turns": len(turns), "views": len({(turn["surface"], item["target"])
                                            for turn in turns for item in turn["revisions"]}),
            "rate": rate, "seconds": count_median(turn["seconds"] for turn in turns),
            "input": count_median(turn["usage"].get("input") for turn in turns),
            "output": count_median(turn["usage"].get("output") for turn in turns)}


def analyze(turns):
    """summarize plus the distributions an agent needs to compare groups."""
    revisions = unique_revisions(turns)
    statuses = Counter(revision_value(item, "status") for item in revisions.values())
    checked = statuses["pass"] + statuses["fail"]
    tools = [tool for turn in turns for tool in turn["tools"].values()]
    finished = [tool for tool in tools if tool.get("status")]
    stats = summarize(turns)
    stats.update({
        "revisions": len(revisions),
        "statuses": dict(statuses.most_common()),
        "pass_rate": round(statuses["pass"] / checked, 3) if checked else None,
        "committed_revisions": sum(bool(item["commit_hash"]) for item in revisions.values()),
        "uncertain_turns": sum(bool(turn["uncertain"]) for turn in turns),
        "seconds": spread(turn["seconds"] for turn in turns),
        "tokens": {key: spread(turn["usage"].get(key) for turn in turns)
                   for key in ("input", "output", "cache_read", "cache_write", "reasoning")},
        "tool_calls": spread(len(turn["tools"]) for turn in turns),
        "tool_error_rate": round(sum(tool["status"] == "error" for tool in finished) / len(finished), 3)
        if finished else None,
        "check_calls": sum(bool(tool.get("check") or tool.get("check_status")) for tool in tools),
        "top_tools": dict(Counter(tool.get("name") or UNKNOWN for tool in tools).most_common(8)),
    })
    del stats["input"], stats["output"]
    return stats


def compact(turn):
    tools = turn["tools"].values()
    return {
        "id": turn["id"], "date": turn["date"], "client": turn["client"], "surface": turn["surface"],
        "models": turn["models"], "efforts": turn["efforts"], "seconds": turn["seconds"], "usage": turn["usage"],
        "prompt": turn["prompt"], "origin": turn["origin"], "uncertain": bool(turn["uncertain"]),
        "usage_shared_across_views": turn["linked"] if turn["linked"] > 1 else None,
        "tool_calls": len(turn["tools"]), "tool_errors": sum(tool.get("status") == "error" for tool in tools),
        "revisions": [{"target": item["target"], "change": item["change"], "status": revision_value(item, "status"),
                       "contract": item["contract"], "revision": (item["revision"] or "")[:12] or None,
                       "check_key": item["check_key"], "commit": (item["commit_hash"] or "")[:12] or None,
                       "diagnostics": len(item["diagnostics"])} for item in turn["revisions"]],
    }


# Dashboard

def overview(root, query):
    enabled, turns = read_activity(root, start=time.time() - 30 * 86400)
    choices = dimensions(turns)
    filters = {name: query.get(name) for name in FIELDS if query.get(name) in choices[name]}
    filtered = select(turns, filters)
    group = query.get("group", "client")
    if group not in FIELDS:
        group = "client"
    groups = bucket(filtered, (group,))
    return {"enabled": enabled, "filters": filters, "group": group, "fields": FIELDS, "choices": choices,
            "summary": summarize(filtered),
            "groups": [(key[0], summarize(items)) for key, items in sorted(groups.items())],
            "turns": filtered[:100]}


# Agent analysis

def check_window(days):
    if not isinstance(days, (int, float)) or not 0 < days <= 3650:
        raise ValueError("days must be between 0 and 3650.")
    return time.time() - days * 86400


def check_filters(filters, allowed=ANALYSIS_FIELDS):
    filters = dict(filters or {})
    unknown = sorted(set(filters) - set(allowed))
    if unknown or not all(isinstance(value, str) for value in filters.values()):
        raise ValueError(f"Filters take string values for: {', '.join(allowed)}. Unknown: {', '.join(unknown) or 'none'}.")
    return filters


def query(root, days=30, filters=None, text=None, group_by=("client",), limit=25, offset=0):
    start = check_window(days)
    filters = check_filters(filters)
    group_by = list(group_by or [])
    if len(group_by) > 2 or not set(group_by) <= set(ANALYSIS_FIELDS):
        raise ValueError(f"Group by up to two of: {', '.join(ANALYSIS_FIELDS)}.")
    if not 1 <= limit <= 200 or offset < 0:
        raise ValueError("Use a limit from 1 to 200 and a nonnegative offset.")
    enabled, turns = read_activity(root, start=start)
    selected = select(turns, filters, text)
    # Counts of the selection by each dimension show what else is worth slicing by.
    breakdown = {name: dict(Counter(value for turn in selected for value in field_values(turn, name)).most_common(25))
                 for name in ANALYSIS_FIELDS if name not in ("prompt", "instruction")}
    groups = [{"key": dict(zip(group_by, key)), **analyze(items)}
              for key, items in bucket(selected, group_by).items()] if group_by else []
    groups.sort(key=lambda group: (-group["turns"], list(group["key"].values())))
    return {
        "tracking_enabled": enabled,
        "window": {"days": days, "since": datetime.fromtimestamp(start).isoformat(timespec="seconds")},
        "filters": filters, "text": text, "group_by": group_by,
        "summary": analyze(selected), "groups": groups, "breakdown": breakdown,
        "turns": {"total": len(selected), "offset": offset,
                  "next_offset": offset + limit if offset + limit < len(selected) else None,
                  "items": [compact(turn) for turn in selected[offset:offset + limit]]},
    }


def view_history(root, surface, target):
    if surface not in SURFACES:
        raise LookupError("surface must be checkout or workshop.")
    _, turns = read_activity(root, surface=surface, target=target)
    if not turns:
        raise LookupError(f"No authoring activity for {surface}/{target}.")
    timeline = list(reversed(turns))
    first = next((index for index, turn in enumerate(timeline)
                  if any(item["status"] == "pass" for item in turn["revisions"])), None)
    revisions = [item for turn in timeline for item in turn["revisions"] if item["revision"]]

    def effort(span):
        return {"turns": len(span), "seconds": round(sum(turn["seconds"] or 0 for turn in span), 1),
                "input": sum(turn["usage"].get("input", 0) for turn in span),
                "output": sum(turn["usage"].get("output", 0) for turn in span),
                "tool_calls": sum(len(turn["tools"]) for turn in span)}

    return {
        "surface": surface, "target": target, "stats": analyze(turns), "effort": effort(timeline),
        "first_pass": None if first is None else {"turn": timeline[first]["id"], "date": timeline[first]["date"],
                                                  "effort_until": effort(timeline[:first + 1])},
        "status_sequence": [revision_value(item, "status") for item in revisions],
        "latest_revision": (compact(timeline[-1])["revisions"] or [None])[0],
        "commits": sorted({item["commit_hash"] for item in revisions if item["commit_hash"]}),
        "notes": read_notes(root, surface, target),
        "timeline": [compact(turn) for turn in timeline],
    }


def turn_row(db, turn_id):
    if not isinstance(turn_id, str) or not TURN_ID.fullmatch(turn_id):
        raise LookupError("Unknown turn.")
    row = db.execute("SELECT * FROM turns WHERE id=?", (turn_id,)).fetchone()
    if not row:
        raise LookupError("Unknown turn.")
    return row


def turn_detail(root, turn_id):
    with database(root) as db:
        row = turn_row(db, turn_id)
        revisions = db.execute("""SELECT r.*,c.status,c.contract,c.diagnostics FROM revisions r
                                  LEFT JOIN checks c ON c.key=r.check_key WHERE r.turn=? ORDER BY r.target""",
                               (turn_id,)).fetchall()
    turn = turn_record({**dict(row), "linked": len(revisions)})
    tools = sorted(({"id": key, **value} for key, value in turn.pop("tools").items()), key=lambda tool: tool.get("at", 0))
    for tool in tools:
        if "at" in tool:
            tool["after_seconds"] = round(tool.pop("at") - turn["started"], 2)
    baseline = json.loads(row["baseline"] or "{}")
    details = []
    for revision in revisions:
        item = revision_record(revision)
        item["status"] = revision_value(item, "status")
        if item["check_key"]:
            folder = check_folder(root, item["check_key"])
            result = read_json(folder / "check.json")
            item["checks"] = result.get("checks") if isinstance(result, dict) else None
            item["check_files"] = [name for name in CHECK_FILES if (folder / name).is_file()]
        details.append(item)
    return {
        **{key: turn[key] for key in ("id", "client", "surface", "date", "started", "ended", "seconds", "prompt",
                                      "prompt_hash", "models", "efforts", "usage", "instructions", "origin")},
        "uncertain": bool(turn["uncertain"]), "session": row["session"], "native_turn": row["native"],
        "workspace": row["workspace"], "views_read": json.loads(row["reads"] or "[]"),
        "views_in_baseline": {name: len(files) for name, files in baseline.items()},
        "transcript_available": transcript_path(row) is not None,
        "revisions": details, "tools": tools,
    }


def check_folder(root, key):
    if not isinstance(key, str) or not CHECK_KEY.fullmatch(key):
        raise LookupError("Unknown check.")
    folder = root / "authoring-checks" / key
    if folder.is_symlink() or not folder.is_dir():
        raise LookupError("Unknown check.")
    return folder


def check_file(root, key, name):
    if name not in CHECK_FILES:
        raise LookupError(f"Check files are: {', '.join(CHECK_FILES)}.")
    path = check_folder(root, key) / name
    if path.is_symlink() or not path.is_file():
        raise LookupError(f"{name} is not part of this check.")
    return path


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def transcript_roots():
    home = Path.home()
    return (Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude")) / "projects",
            Path(os.environ.get("CODEX_HOME", home / ".codex")) / "sessions")


def transcript_path(row):
    if not row["transcript"]:
        return None
    path = Path(row["transcript"])
    # Read only client logs in their usual folders, never an arbitrary recorded path.
    resolved = path.resolve()
    if path.suffix != ".jsonl" or path.is_symlink() or not resolved.is_file():
        return None
    if not any(resolved.is_relative_to(base.resolve()) for base in transcript_roots()):
        return None
    return resolved


def transcript(root, turn_id, offset=0, limit=40, max_chars=1500, kinds=None):
    if offset < 0 or not 1 <= limit <= 200 or not 100 <= max_chars <= 50000:
        raise ValueError("Use a nonnegative offset, a limit from 1 to 200 and max_chars from 100 to 50000.")
    with database(root) as db:
        row = turn_row(db, turn_id)
        following = db.execute("""SELECT MIN(started) FROM turns WHERE client=? AND session=? AND started>?""",
                               (row["client"], row["session"], row["started"])).fetchone()[0]
    path = transcript_path(row)
    if path is None:
        raise LookupError("No readable client transcript was recorded for this turn.")
    end = row["ended"] or following or row["started"] + 6 * 3600
    if following:
        end = min(end, following)
    events = [event for event in logs.events(path, row["client"], row["started"] - 1, end + 1, max_chars)
              if not kinds or event["kind"] in kinds]
    for event in events:
        event["after_seconds"] = round(event.pop("at") - row["started"], 2)
    return {"client": row["client"], "path": str(path), "total": len(events), "offset": offset,
            "next_offset": offset + limit if offset + limit < len(events) else None,
            "events": [{"index": index, **event} for index, event in enumerate(events)][offset:offset + limit]}


PATHS = re.compile(r"(?:activity-source:)?/\S*/authoring-checks/[0-9a-f]{64}/")


def diagnostic_lines(message):
    message = PATHS.sub("", message)
    lines = [line.strip() for line in message.splitlines() if line.strip()]
    if lines and re.match(r"Build failed with \d+ errors?:", lines[0]):
        lines = [line for line in lines[1:] if "ERROR" in line] or lines
        return message, lines
    return message, lines[:1]


def pattern_of(line):
    line = re.sub(r"\([\d,]+\)|:\d+:\d+", "", line)
    line = re.sub(r'"[^"]*"|\'[^\']*\'', "…", line)
    return re.sub(r"\d+", "N", line)[:240]


def failures(root, days=30, filters=None, text=None, limit=20):
    start = check_window(days)
    filters = check_filters(filters)
    if not 1 <= limit <= 100:
        raise ValueError("Use a limit from 1 to 100.")
    _, turns = read_activity(root, start=start)
    clusters = {}
    affected = 0
    for turn in select(turns, filters, text):
        for item in turn["revisions"]:
            if not item["diagnostics"]:
                continue
            affected += 1
            for diagnostic in item["diagnostics"]:
                message, lines = diagnostic_lines(diagnostic.get("message"))
                for line in lines or [""]:
                    key = (diagnostic.get("stage"), diagnostic.get("code"), pattern_of(line))
                    cluster = clusters.setdefault(key, {
                        "stage": key[0], "code": key[1], "pattern": key[2], "occurrences": 0,
                        "revisions": set(), "views": Counter(), "clients": Counter(), "models": Counter(),
                        "statuses": Counter(), "first": turn["date"], "examples": []})
                    cluster["occurrences"] += diagnostic.get("count", 1)
                    cluster["revisions"].add((turn["id"], item["target"]))
                    cluster["views"][f"{turn['surface']}/{item['target']}"] += 1
                    cluster["clients"][turn["client"]] += 1
                    cluster["models"].update(turn["models"] or [UNKNOWN])
                    cluster["statuses"][revision_value(item, "status")] += 1
                    cluster["first"] = turn["date"]
                    if len(cluster["examples"]) < 3:
                        cluster["examples"].append({"turn": turn["id"], "date": turn["date"], "target": item["target"],
                                                    "check_key": item["check_key"], "message": message[:1500]})
    ranked = sorted(clusters.values(), key=lambda cluster: (-len(cluster["revisions"]), -cluster["occurrences"]))
    for cluster in ranked:
        cluster["revisions"] = len(cluster["revisions"])
        cluster["latest"] = cluster["examples"][0]["date"]
        for key in ("views", "clients", "models", "statuses"):
            cluster[key] = dict(cluster[key].most_common(10))
    return {"window": {"days": days}, "filters": filters, "text": text,
            "revisions_with_diagnostics": affected, "patterns": len(ranked), "clusters": ranked[:limit]}


# Notes on a view's authoring history

def read_notes(root, surface, target):
    if not (root / "authoring.sqlite").exists():
        return []
    with database(root) as db:
        rows = db.execute("SELECT at,author,text FROM notes WHERE surface=? AND target=? ORDER BY id",
                          (surface, target)).fetchall()
    return [{"at": row["at"], "author": json.loads(row["author"]), "text": row["text"]} for row in rows]


def add_note(root, surface, target, author, text, at):
    text = text.strip() if isinstance(text, str) else ""
    if not text or len(text) > NOTE_LIMIT:
        raise ValueError(f"A note needs 1–{NOTE_LIMIT} characters.")
    if surface not in SURFACES:
        raise LookupError("surface must be checkout or workshop.")
    with database(root) as db:
        known = db.execute("""SELECT 1 FROM revisions r JOIN turns t ON t.id=r.turn
                              WHERE t.surface=? AND r.target=? LIMIT 1""", (surface, target)).fetchone()
        if not known:
            raise LookupError(f"No authoring activity for {surface}/{target}.")
        db.execute("INSERT INTO notes(surface,target,at,author,text) VALUES(?,?,?,?,?)",
                   (surface, target, at, dump(author), text))
    return {"at": at, "author": author, "text": text}
