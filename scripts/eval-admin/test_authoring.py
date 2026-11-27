import json
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import admin
import authoring
import authoring_logs as logs
import authoring_report as report


def stamp(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


class AuthoringTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / "data/authoring"
        self.checkout = self.base / "checkout"
        self.workshop = self.base / "vizint-workshop/workspaces"
        self.draft = self.workshop / "demo"
        self.view = self.checkout / "src/views/demo"
        self.view.mkdir(parents=True)
        self.draft.mkdir(parents=True)
        self.source = self.view / "activity.js"
        self.source.write_text("let n = 1;")
        patches = patch.multiple(authoring, PROJECT=self.checkout, WORKSHOP=self.workshop,
                                 checker_version=lambda: "test-checker")
        patches.start()
        self.addCleanup(patches.stop)
        dashboard = patch.object(admin, "ROOT", self.root.parent)
        dashboard.start()
        self.addCleanup(dashboard.stop)
        with authoring.database(self.root) as db:
            db.executemany("INSERT INTO settings VALUES (?,?)", [("enabled", "1"), ("enabled_at", str(time.time() - 30))])

    def send(self, client, event, *, session="session", work=None, native=None, **fields):
        authoring.hook(self.root, client, {"hook_event_name": event, "cwd": str(work or self.checkout),
                                         "session_id": session, "turn_id": native, **fields})

    def test_checkout_snapshot_report_and_commit(self):
        proc = lambda *args: subprocess.run(["git", "-C", str(self.checkout), *args], check=True, capture_output=True)
        proc("init")
        proc("add", ".")
        proc("-c", "user.email=a@b", "-c", "user.name=Author", "commit", "-m", "base")
        self.send("codex", "UserPromptSubmit", native="turn-1", prompt="Change the <value>.", model="codex-model")
        self.send("codex", "UserPromptSubmit", native="turn-1", prompt="Duplicate.")
        self.send("codex", "PostToolUse", native="turn-1", tool_use_id="tool", tool_name="apply_patch")
        self.source.write_text("let n = 2;")
        self.send("codex", "Stop", native="turn-1")
        self.send("codex", "Stop", native="turn-1")
        proc("add", ".")
        proc("-c", "user.email=a@b", "-c", "user.name=Author", "commit", "-m", "view")
        self.source.write_text("let n = 3;")
        authoring.update_commits(self.root, {})
        with authoring.database(self.root) as db:
            row = db.execute("SELECT * FROM revisions").fetchone()
            snapshot = self.root / "authoring-checks" / row["check_key"]
            self.assertTrue(row["commit_hash"])
        self.assertEqual((snapshot / "activity.js").read_text(), "let n = 2;")
        page = admin.flask.test_client().get("/authoring?group=model&client=codex")
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page.headers["Cache-Control"], "no-store")
        self.assertIn(b"Change the &lt;value&gt;.", page.data)
        self.assertIn(b"codex-model", page.data)

    def test_overlap_read_only_and_shared_turn(self):
        self.send("codex", "UserPromptSubmit", native="one")
        self.send("claude", "UserPromptSubmit", session="other")
        self.send("codex", "PostToolUse", native="one", tool_name="Read", tool_input={"path": str(self.source)})
        other = self.checkout / "src/views/other"
        other.mkdir()
        (other / "activity.js").write_text("let n = 0;")
        self.send("codex", "Stop", native="one")
        self.send("claude", "Stop", session="other")
        _, turns = report.read_activity(self.root)
        self.assertTrue(all(turn["uncertain"] for turn in turns))
        self.assertEqual(len(next(turn["revisions"] for turn in turns if turn["client"] == "codex")), 2)
        self.assertEqual(report.summarize(turns)["turns"], 2)
        with authoring.database(self.root) as db:
            self.assertFalse(db.execute("SELECT * FROM checks").fetchone())

    def test_workshop_check_attaches_only_to_equivalent_revision(self):
        source = self.draft / "viz.ts"
        self.send("claude", "UserPromptSubmit", work=self.draft, prompt="Build the draft.")
        source.write_text("export default {}")
        self.send("claude", "PostToolUse", work=self.draft, tool_name="Bash", tool_use_id="call",
                  tool_input={"command": "node check.ts"}, tool_response={"stdout": "ok typecheck\npassed\n"})
        self.send("claude", "Stop", work=self.draft)
        self.send("claude", "UserPromptSubmit", work=self.draft, prompt="Update it.")
        self.send("claude", "PostToolUse", work=self.draft, tool_name="Bash", tool_use_id="next",
                  tool_input={"command": "node check.ts"}, tool_response={"stdout": "passed\n"})
        source.write_text("export default []")
        self.send("claude", "Stop", work=self.draft)
        _, turns = report.read_activity(self.root)
        self.assertEqual([turn["revisions"][0]["status"] for turn in turns], [None, "pass"])
        page = admin.flask.test_client().get("/authoring/workshop/demo")
        self.assertIn(b"First observed passing revision", page.data)
        self.assertIn(b"Workshop check pass", page.data)

    def test_claude_bridge_fallback_and_usage_deduplication(self):
        path = self.base / "transcript.jsonl"
        at = time.time()
        rows = [
            {"type": "user", "uuid": "prompt", "message": {"content": "Create a viz."}},
            {"type": "assistant", "effort": "low", "message": {"id": "response", "model": "sonnet",
                "usage": {"input_tokens": 3, "cache_read_input_tokens": 4, "cache_creation_input_tokens": 2,
                          "output_tokens": 12},
                "content": [{"type": "tool_use", "id": "tool", "name": "Bash", "input": {"command": "node check.ts"}}]}},
            {"type": "assistant", "message": {"id": "response", "usage": {"input_tokens": 3, "output_tokens": 12}}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "tool",
                                                      "content": "ok typecheck\npassed\n"}]}},
            {"type": "system", "subtype": "turn_duration", "durationMs": 500},
        ]
        path.write_text("".join(json.dumps({**row, "cwd": str(self.draft), "timestamp": stamp(at + i / 10)}) + "\n"
                                for i, row in enumerate(rows)))
        for _ in range(2):
            authoring.sync_file(self.root, "claude", path, {"bridge"}, at - 1, "mark")
        _, turns = report.read_activity(self.root)
        turn, = turns
        self.assertEqual(turn["usage"], {"input": 9, "output": 12, "cache_read": 4, "cache_write": 2})
        self.assertEqual(turn["efforts"], ["low"])
        self.assertEqual(turn["tools"]["tool"]["check_status"], "pass")
        self.assertIsNone(turn["revisions"][0]["status"])
        self.assertEqual(turn["seconds"], .5)

    def test_codex_usage_deltas_and_interrupted_turn(self):
        at = time.time()

        def event(kind, **payload):
            return {"type": "event_msg", "timestamp": stamp(at), "payload": {"type": kind, **payload}}

        def tokens(value):
            return event("token_count", info={"total_token_usage": {"input_tokens": value, "output_tokens": value // 2}})

        rows = [{"type": "session_meta", "payload": {"cwd": str(self.checkout)}}, tokens(10),
                event("task_started", turn_id="a"), tokens(16), tokens(36),
                event("task_complete", turn_id="a"), event("task_started", turn_id="b"), tokens(40),
                event("turn_aborted", turn_id="b")]
        first, second = logs.codex(rows, authoring.scope)
        self.assertEqual((first["usage"]["input"], second["usage"]["input"]), (26, 4))
        self.assertEqual(second["efforts"], [])

    def record_checked_turns(self, transcript):
        """Two checkout turns on demo: the first fails a check, the second passes."""
        for index, (body, status) in enumerate((("let n = 2;", "fail"), ("let n = 3;", "pass"))):
            self.send("claude", "UserPromptSubmit", prompt=f"Attempt {index}", model="opus",
                      transcript_path=str(transcript))
            self.send("claude", "PostToolUse", tool_name="Edit", tool_use_id=f"edit-{index}",
                      tool_input={"file_path": str(self.source)}, tool_response="ok")
            self.source.write_text(body)
            self.send("claude", "Stop")
            with authoring.database(self.root) as db:
                key = db.execute("SELECT key FROM checks WHERE status='queued'").fetchone()["key"]
                diagnostics = [{"stage": "bundle", "message": f"Build failed with 1 error:\nactivity-source:"
                                f"{self.root}/authoring-checks/{key}/activity.js:2:28: ERROR: Could not resolve \"./q{index}.mjs\""}]
                db.execute("UPDATE checks SET status=?,diagnostics=? WHERE key=?",
                           (status, json.dumps(diagnostics if status == "fail" else []), key))
            (self.root / "authoring-checks" / key / "check.json").write_text(json.dumps({"checks": {"bundle": status}}))
        return key

    def test_agent_tools_cover_authoring_analysis(self):
        config = self.base / "claude"
        transcript = config / "projects/vizint/session.jsonl"
        transcript.parent.mkdir(parents=True)
        environment = patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(config)})
        environment.start()
        self.addCleanup(environment.stop)
        key = self.record_checked_turns(transcript)
        at = time.time()
        rows = [{"type": "user", "message": {"content": "Attempt 1"}},
                {"type": "assistant", "message": {"content": [
                    {"type": "text", "text": "Fixing the import."},
                    {"type": "tool_use", "id": "edit-1", "name": "Edit", "input": {"file_path": "activity.js"}}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "edit-1",
                                                          "content": [{"type": "text", "text": "x" * 500}]}]}}]
        transcript.write_text("".join(json.dumps({**row, "cwd": str(self.checkout), "timestamp": stamp(at)}) + "\n"
                                      for row in rows))

        result = admin.query_authoring(group_by=["status"])
        self.assertEqual({group["key"]["status"]: group["turns"] for group in result["groups"]}, {"fail": 1, "pass": 1})
        self.assertEqual(result["summary"]["pass_rate"], 0.5)
        self.assertEqual(result["breakdown"]["target"], {"demo": 2})
        narrowed = admin.query_authoring(filters={"status": "pass"}, text="attempt 1", group_by=[])
        self.assertEqual([turn["prompt"] for turn in narrowed["turns"]["items"]], ["Attempt 1"])
        with self.assertRaises(ValueError):
            admin.query_authoring(group_by=["client", "model", "effort"])

        clusters = admin.authoring_failures()["clusters"]
        self.assertEqual([(item["stage"], item["revisions"]) for item in clusters], [("bundle", 1)])
        self.assertEqual(clusters[0]["pattern"], "activity.js: ERROR: Could not resolve …")

        view = admin.get_authoring_view("checkout", "demo")
        self.assertEqual(view["status_sequence"], ["fail", "pass"])
        self.assertEqual(view["first_pass"]["effort_until"]["turns"], 2)
        latest = view["timeline"][-1]["id"]

        turn = admin.get_authoring_turn(latest)
        self.assertTrue(turn["transcript_available"])
        self.assertEqual([tool["name"] for tool in turn["tools"]], ["Edit"])
        self.assertEqual(turn["revisions"][0]["checks"], {"bundle": "pass"})
        self.assertEqual(admin.read_authoring_check_file(key, "activity.js")["text"], "let n = 3;")
        with self.assertRaises(LookupError):
            admin.read_authoring_check_file(key, "../authoring.sqlite")

        events = admin.read_authoring_transcript(latest, max_chars=100)
        self.assertEqual([event["kind"] for event in events["events"]], ["user", "assistant", "tool_call", "tool_result"])
        self.assertEqual(events["events"][3]["chars"], 500)
        only = admin.read_authoring_transcript(latest, kinds=["assistant"])["events"]
        self.assertEqual(only[0]["text"], "Fixing the import.")

        admin.add_authoring_note("checkout", "demo", "Imports break the checker.", "codex")
        with self.assertRaises(LookupError):
            admin.add_authoring_note("checkout", "missing", "x")
        self.assertEqual(admin.get_authoring_view("checkout", "demo")["notes"][0]["author"], {"kind": "agent", "name": "codex"})
        client = admin.flask.test_client()
        self.assertIn(b"Imports break the checker.", client.get("/authoring/checkout/demo").data)
        self.assertEqual(client.get("/api/authoring?group_by=client,status&status=fail").json["turns"]["total"], 1)
        self.assertEqual(client.get("/api/authoring/views/checkout/missing").status_code, 404)
        self.assertEqual(client.get(f"/api/authoring/turns/{latest}/transcript?kinds=user").json["total"], 1)
        response = client.get(f"/api/authoring/checks/{key}/activity.js")
        self.assertEqual((response.data, response.mimetype), (b"let n = 3;", "text/plain"))
        response.close()

    def test_transcripts_outside_client_folders_stay_unread(self):
        outside = self.base / "elsewhere.jsonl"
        outside.write_text("")
        with patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(self.base / "claude")}):
            self.record_checked_turns(outside)
            turn = admin.query_authoring()["turns"]["items"][0]["id"]
            self.assertFalse(admin.get_authoring_turn(turn)["transcript_available"])
            with self.assertRaises(LookupError):
                admin.read_authoring_transcript(turn)

    def test_setup_merges_and_disables_only_our_hooks(self):
        config = self.base / "config"
        config.mkdir()
        claude = config / "settings.json"
        original = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "my-previous-hook"}]}]}, "other": 1}
        claude.write_text(json.dumps(original))
        with patch.dict("os.environ", {"CODEX_HOME": str(config), "CLAUDE_CONFIG_DIR": str(config)}):
            authoring.setup(self.root)
            first = claude.read_text()
            authoring.setup(self.root)
            self.assertEqual(first, claude.read_text())
            authoring.setup(self.root, disable=True)
        self.assertEqual(json.loads(claude.read_text()), original)
        self.assertEqual(json.loads((config / "hooks.json").read_text()), {"hooks": {}})
