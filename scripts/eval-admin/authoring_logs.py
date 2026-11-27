"""Read the client formats at the boundary. Callers persist only selected fields."""
import json
import re
from datetime import datetime

CHECK_COMMAND = re.compile(r"(?:^|&&\s*)(?:[A-Z_][A-Z_0-9]*=\S+\s+)*(?:node|bun|tsx)\s+(?:\./)?check\.ts(?:\s|$)")


def clock(value):
    if isinstance(value, (float, int)):
        return value
    try:
        return datetime.fromisoformat(value).timestamp()
    except (ValueError, TypeError):
        return 0


def records(path):
    with path.open("rb") as stream:
        for line in stream:
            if not line.endswith(b"\n"):
                break
            try:
                value = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(value, dict):
                yield value


def text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(item.get("text", "") for item in value
                         if isinstance(item, dict) and item.get("type") in ("text", "input_text"))
    return ""


def is_check(value):
    command = value.get("command") if isinstance(value, dict) else None
    return bool(isinstance(command, str) and CHECK_COMMAND.search(command.strip()))


def checked(value, error=False):
    output = text(value).strip().splitlines()
    if error or any(line.strip() == "FAILED" for line in output):
        return "fail"
    if any(line.strip() == "passed" for line in output):
        return "pass"
    return None


def new_turn(key, at, prompt=""):
    return {"native": key, "start": at, "prompt": prompt, "tools": {}, "models": [], "efforts": [], "usage": {}}


def add_unique(values, value):
    if isinstance(value, str) and value and value not in values and not value.startswith("<"):
        values.append(value)


def codex(rows, scope):
    turns = []
    current = None
    totals = {}
    cwd = ""
    keys = {"input": "input_tokens", "output": "output_tokens", "cache_read": "cached_input_tokens",
            "cache_write": "cache_write_input_tokens", "reasoning": "reasoning_output_tokens"}
    for row in rows:
        payload = row.get("payload") or {}
        kind = payload.get("type")
        at = clock(row.get("timestamp"))
        if row.get("type") == "session_meta":
            cwd = payload.get("cwd", "")
            if not scope(cwd):
                return []
        elif kind in ("task_started", "turn_started"):
            current = new_turn(payload.get("turn_id"), at)
            current["cwd"] = cwd
            current["baseline"] = totals
            turns.append(current)
        elif row.get("type") == "turn_context":
            if current and payload.get("turn_id") in (None, current["native"]):
                add_unique(current["models"], payload.get("model"))
                add_unique(current["efforts"], payload.get("effort"))
        elif kind == "token_count":
            observed = (payload.get("info") or {}).get("total_token_usage")
            if isinstance(observed, dict):
                totals = {key: observed[source] for key, source in keys.items() if isinstance(observed.get(source), int)}
                if current and not current.get("end"):
                    current["usage"] = {key: value - current["baseline"].get(key, 0)
                                        for key, value in totals.items() if value >= current["baseline"].get(key, 0)}
        elif current is not None:
            if kind == "user_message":
                current["prompt"] = payload.get("message", "")
            elif kind == "message" and payload.get("role") == "user":
                metadata = payload.get("internal_chat_message_metadata_passthrough") or {}
                item_kinds = metadata.get("content_item_kinds", [])
                content = payload.get("content") or []
                if metadata.get("turn_id") in (None, current["native"]):
                    prompt = text([item for item, tag in zip(content, item_kinds) if tag == "user.text"])
                    if prompt:
                        current["prompt"] = prompt
            elif kind in ("task_complete", "turn_complete", "turn_aborted"):
                current["end"] = at
                if isinstance(payload.get("duration_ms"), (int, float)):
                    current["seconds"] = payload["duration_ms"] / 1000
            elif kind in ("function_call", "custom_tool_call") and payload.get("call_id"):
                name = payload.get("name", "")
                arguments = payload.get("arguments") or payload.get("input")
                try:
                    parsed = json.loads(arguments) if isinstance(arguments, str) else arguments
                except ValueError:
                    parsed = None
                current["tools"][payload["call_id"]] = {
                    "name": name, "at": at, "check": is_check(parsed),
                    "argument_bytes": len(json.dumps(arguments).encode()),
                }
            elif kind in ("function_call_output", "custom_tool_call_output"):
                tool = current["tools"].get(payload.get("call_id"))
                if tool is not None:
                    output = payload.get("output")
                    tool["result_bytes"] = len(json.dumps(output).encode())
                    if tool.get("check"):
                        tool["check_status"] = checked(output)
            elif kind == "mcp_tool_call_end":
                tool = current["tools"].setdefault(payload.get("call_id"), {"at": at})
                invocation = payload.get("invocation") or {}
                if invocation.get("server") and invocation.get("tool"):
                    tool["name"] = f"mcp__{invocation['server']}__{invocation['tool']}"
                duration = payload.get("duration") or {}
                if isinstance(duration, dict):
                    tool["duration"] = duration.get("secs", 0) + duration.get("nanos", 0) / 1e9
                if isinstance(payload.get("result"), dict):
                    tool["status"] = "error" if "Err" in payload["result"] else "ok"
    return turns


def claude(rows, scope):
    turns = []
    current = None
    owners = {}
    seen = set()
    keys = {"input": "input_tokens", "output": "output_tokens", "cache_read": "cache_read_input_tokens",
            "cache_write": "cache_creation_input_tokens", "reasoning": "thinking_tokens"}
    for row in rows:
        if row.get("isSidechain") or not scope(row.get("cwd", "")):
            continue
        kind = row.get("type")
        message = row.get("message") or {}
        blocks = message.get("content", [])
        blocks = blocks if isinstance(blocks, list) else []
        at = clock(row.get("timestamp"))
        if kind == "user" and not row.get("isMeta") and not any(b.get("type") == "tool_result" for b in blocks):
            prompt = text(message.get("content"))
            if prompt:
                if current and not current.get("end"):
                    current["end"] = current.get("last", current["start"])
                current = new_turn(row.get("uuid") or row.get("promptId"), at, prompt)
                current["cwd"] = row["cwd"]
                turns.append(current)
        elif current and kind == "assistant":
            usage = message.get("usage") or {}
            message_id = message.get("id") or row.get("requestId")
            if message_id and message_id not in seen and usage:
                seen.add(message_id)
                counts = {key: usage[field] for key, field in keys.items() if isinstance(usage.get(field), int)}
                if "input" in counts:
                    counts["input"] += counts.get("cache_read", 0) + counts.get("cache_write", 0)
                for key, value in counts.items():
                    current["usage"][key] = current["usage"].get(key, 0) + value
            add_unique(current["models"], message.get("model"))
            add_unique(current["efforts"], row.get("perTurnEffort") or row.get("effort"))
            for block in blocks:
                if block.get("type") == "tool_use" and block.get("id"):
                    arg = block.get("input", {})
                    tool = {"name": block.get("name"), "at": at, "check": is_check(arg),
                            "argument_bytes": len(json.dumps(arg).encode())}
                    current["tools"][block["id"]] = tool
                    owners[block["id"]] = tool
            current["last"] = at
        elif current and kind == "system" and row.get("subtype") == "turn_duration":
            current["end"] = at
            current["seconds"] = row.get("durationMs", 0) / 1000
        elif current and kind == "user":
            for block in blocks:
                tool = owners.get(block.get("tool_use_id"))
                if tool is None:
                    continue
                tool["status"] = "error" if block.get("is_error") else "ok"
                output = block.get("content")
                tool["result_bytes"] = len(json.dumps(output).encode())
                if tool.get("check"):
                    tool["check_status"] = checked(output, block.get("is_error"))
    return turns


def parse(path, client, scope):
    return (codex if client == "codex" else claude)(records(path), scope)
