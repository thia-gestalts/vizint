"""Observed authoring activity used by the dashboard."""
import json
import statistics
import time
from collections import defaultdict
from datetime import datetime

from authoring import database, dump, fingerprint

FIELDS = {"client": "Client", "model": "Model", "effort": "Effort", "surface": "Workspace",
          "change": "Change", "tool": "Tool used", "prompt": "Prompt fingerprint", "instruction": "Instruction fingerprint"}
CONTRACTS = {"Checkout", "Checkout with fixture", "Workshop"}
UNKNOWN = "Unknown"


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
            t.models,t.efforts,t.usage,t.tools,t.uncertain,t.origin,r.target,r.revision,r.change,r.commit_hash,
            c.status,c.contract,c.diagnostics,
            (SELECT COUNT(*) FROM revisions AS linked WHERE linked.turn=t.id) AS linked FROM turns t
            JOIN revisions r ON r.turn=t.id LEFT JOIN checks c ON c.key=r.check_key"""
            + where + " ORDER BY t.started DESC,r.target", values).fetchall()
    turns = {}
    for row in rows:
        if row["id"] not in turns:
            item = {key: row[key] for key in ("id", "client", "surface", "started", "ended", "seconds",
                                              "prompt", "prompt_hash", "uncertain", "origin", "linked")}
            item |= {key: json.loads(row[key] or "{}") for key in ("usage", "tools", "instructions")}
            item["models"] = json.loads(row["models"])
            item["efforts"] = json.loads(row["efforts"])
            item["date"] = datetime.fromtimestamp(item["started"]).strftime("%Y-%m-%d %H:%M")
            item["revisions"] = []
            turns[item["id"]] = item
        revision = {key: row[key] for key in ("target", "revision", "change", "commit_hash", "status", "contract")}
        revision["diagnostics"] = json.loads(row["diagnostics"] or "[]")
        turns[row["id"]]["revisions"].append(revision)
    return enabled, list(turns.values())


def field_values(turn, name):
    if name == "model":
        return turn["models"] or [UNKNOWN]
    if name == "effort":
        return turn["efforts"] or [UNKNOWN]
    if name == "change":
        return sorted({item["change"] for item in turn["revisions"]})
    if name == "tool":
        return sorted({tool["name"] for tool in turn["tools"].values() if tool.get("name")}) or [UNKNOWN]
    if name == "prompt":
        return [turn["prompt_hash"] or UNKNOWN]
    if name == "instruction":
        return [fingerprint(dump(turn["instructions"])) if turn["instructions"] else UNKNOWN]
    return [turn[name]]


def dimensions(turns):
    return {name: sorted({value for turn in turns for value in field_values(turn, name)}) for name in FIELDS}


def count_median(values):
    samples = [value for value in values if value is not None]
    return round(statistics.median(samples), 1) if samples else None, len(samples)


def summarize(turns):
    revisions = {}
    for turn in reversed(turns):
        for item in turn["revisions"]:
            if item["revision"]:
                revisions[turn["surface"], item["target"], item["revision"]] = item
    rate = {}
    for contract in sorted(CONTRACTS):
        surface = "workshop" if contract == "Workshop" else "checkout"
        subset = [row for (origin, _target, _revision), row in revisions.items()
                  if origin == surface and (row["contract"] or ("Workshop" if origin == "workshop" else "Checkout")) == contract]
        if subset:
            checked = [item for item in subset if item["status"] in ("pass", "fail")]
            rate[contract] = (sum(item["status"] == "pass" for item in checked), len(checked), len(subset))
    return {"turns": len(turns), "views": len({(turn["surface"], item["target"])
                                            for turn in turns for item in turn["revisions"]}),
            "rate": rate, "seconds": count_median(turn["seconds"] for turn in turns),
            "input": count_median(turn["usage"].get("input") for turn in turns),
            "output": count_median(turn["usage"].get("output") for turn in turns)}


def overview(root, query):
    enabled, turns = read_activity(root, start=time.time() - 30 * 86400)
    choices = dimensions(turns)
    filters = {name: query.get(name) for name in FIELDS if query.get(name) in choices[name]}
    filtered = [turn for turn in turns if all(value in field_values(turn, name) for name, value in filters.items())]
    group = query.get("group", "client")
    if group not in FIELDS:
        group = "client"
    buckets = defaultdict(list)
    for turn in filtered:
        for value in field_values(turn, group):
            buckets[value].append(turn)
    return {"enabled": enabled, "filters": filters, "group": group, "fields": FIELDS, "choices": choices,
            "summary": summarize(filtered), "groups": [(name, summarize(items)) for name, items in sorted(buckets.items())],
            "turns": filtered[:100]}
