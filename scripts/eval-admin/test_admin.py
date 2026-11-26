import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import admin
import jobs

RUN_ID = "2026-01-01T00-00-00.000Z-12345678"
LEGACY_ID = "2025-12-31T00-00-00.000Z-87654321"


def write_run(root, run_id=RUN_ID, rows=None, origin=None):
    folder = root / run_id
    attempt = folder / "case-1-attempt-1"
    attempt.mkdir(parents=True)
    (attempt / "activity.js").write_text("const x = 1;")
    spec = {"hypothesis": "Retrieval helps", "origin": origin or {"kind": "agent", "name": "codex"},
            "fixtures": ["spring", "bezier"],
            "arms": [{"id": "A", "label": "4b · none", "model": "qwen3.5:4b", "examples": "none", "samples": 2,
                      "temperature": 0.7, "repair": "none", "format": "fenced"},
                     {"id": "B", "label": "4b · retrieved", "model": "qwen3.5:4b", "examples": "retrieved",
                      "samples": 1, "temperature": 0.7, "repair": "none", "format": "fenced"}]}
    cases = [{"arm": "A", "fixture": "spring", "sample": 1}, {"arm": "A", "fixture": "spring", "sample": 2},
             {"arm": "B", "fixture": "spring", "sample": 1}, {"arm": "A", "fixture": "bezier", "sample": 1},
             {"arm": "A", "fixture": "bezier", "sample": 2}, {"arm": "B", "fixture": "bezier", "sample": 1}]
    checks = {"syntax": "pass", "startup": "pass", "fixture": "pass", "type": "fail", "typeErrorsRaw": 9, "typeErrors": 2}
    rows = rows if rows is not None else [
        {"arm": "A", "fixture": "spring", "sample": 1, "tier": "working", "passed": False, "finished": True,
         "typeErrorsRaw": 9, "typeErrors": 2, "elapsedSeconds": 30, "selectedAttempt": "case-1-attempt-1",
         "attempts": [{"path": "case-1-attempt-1", "checks": checks, "diagnostics": [{"stage": "type", "message": "TS2322"}],
                       "example": {"mode": "none"}}]},
        {"arm": "A", "fixture": "spring", "sample": 2, "tier": "broken", "passed": False, "finished": True, "attempts": []},
        {"arm": "B", "fixture": "spring", "sample": 1, "tier": "publishable", "passed": True, "finished": True,
         "typeErrorsRaw": 4, "typeErrors": 0, "attempts": []},
    ]
    (folder / "experiment.json").write_text(json.dumps(spec))
    (folder / "run.json").write_text(json.dumps({"command": "run", "cases": cases, "order": {"spring": ["A", "B"]}}))
    (folder / "results.json").write_text(json.dumps(rows))
    return folder


class AdminTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for target, value in ((admin, self.root),):
            patcher = patch.object(target, "ROOT", value)
            patcher.start()
            self.addCleanup(patcher.stop)
        models = patch.object(jobs, "models", return_value=(["qwen3.5:4b", "qwen3.5:9b"], None))
        models.start()
        self.addCleanup(models.stop)
        self.client = admin.flask.test_client()
        with self.client.session_transaction() as session:
            session["csrf"] = "test-token"

    def form(self, **fields):
        data = {"csrf": "test-token", "hypothesis": "Retrieval helps", "target": "fixtures", "fixture": ["spring"],
                "arm-0-enabled": "1", "arm-0-model": "qwen3.5:4b", "arm-0-examples": "none", "arm-0-samples": "2",
                "arm-0-temperature": "0.7", "arm-0-repair": "none", "arm-0-format": "fenced"}
        data.update(fields)
        return self.client.post("/runs", data=data)

    def test_scoreboard_counts_tiers_per_arm_and_fixture(self):
        write_run(self.root)
        run = admin.get_run(RUN_ID)
        self.assertEqual(run["status"], "incomplete")
        self.assertEqual(run["progress"], {"done": 3, "planned": 6})
        arm_a, arm_b = run["scoreboard"]["arms"]
        self.assertEqual(arm_a["tally"], {"publishable": 0, "working": 1, "starts": 0, "broken": 1})
        self.assertEqual(arm_a["cells"][0]["best"], "working")
        self.assertEqual(arm_a["cells"][1], {"fixture": "bezier", "planned": 2, "done": 0,
                                             "tally": dict.fromkeys(admin.TIERS, 0), "best": None})
        self.assertEqual((arm_b["accepted"], arm_b["medianTypeErrorsRaw"], arm_b["medianTypeErrors"]), (1, 4, 0))
        self.assertEqual(run["headline"], ["A 1/2 working · 0/2 publishable", "B 1/1 working · 1/1 publishable"])
        self.assertEqual(run["originLabel"], "Agent · codex")
        sample = admin.get_sample(RUN_ID, "A", "spring", 1)
        self.assertEqual(sample["firstDiagnostic"]["stage"], "type")
        self.assertIn("activity.js", sample["attempts"][0]["artifacts"])

    def test_pages_render_scoreboard_notes_and_origin(self):
        write_run(self.root)
        page = self.client.get(f"/runs/{RUN_ID}").data.decode()
        for text in ("Retrieval helps", "Agent · codex", "Scoreboard", "1 working, 1 broken", "Add note", "Run again"):
            self.assertIn(text, page)
        listing = self.client.get("/").data.decode()
        self.assertIn("Agent · codex", listing)
        self.assertIn("A 1/2 working", listing)
        self.assertNotIn("Retrieval helps", self.client.get("/?origin=human").data.decode())
        self.assertEqual(self.client.get(f"/runs/{RUN_ID}/samples/A/spring/1").status_code, 200)
        self.assertEqual(self.client.get(f"/runs/{RUN_ID}/samples/A/spring/9").status_code, 404)
        self.assertEqual(self.client.get("/runs/../etc").status_code, 404)

    def test_notes_flow_between_humans_and_agents(self):
        write_run(self.root)
        self.assertEqual(self.client.post(f"/runs/{RUN_ID}/notes", data={"text": "Try 9b"}).status_code, 403)
        response = self.client.post(f"/runs/{RUN_ID}/notes", data={"csrf": "test-token", "text": "Try 9b next"})
        self.assertEqual(response.status_code, 303)
        admin.add_note(RUN_ID, "Retrieval did not help on spring.", agent_name="claude-code")
        notes = admin.get_run(RUN_ID)["notes"]
        self.assertEqual([(note["author"]["kind"], note["text"]) for note in notes],
                         [("human", "Try 9b next"), ("agent", "Retrieval did not help on spring.")])
        page = self.client.get(f"/runs/{RUN_ID}").data.decode()
        self.assertIn("Agent · claude-code", page)
        self.assertIn("Try 9b next", page)
        self.assertEqual(self.client.post(f"/api/runs/{RUN_ID}/notes", data="x").status_code, 415)
        self.assertEqual(self.client.post(f"/api/runs/{RUN_ID}/notes", json={"text": "  "}).status_code, 400)
        self.assertEqual(self.client.post(f"/api/runs/{RUN_ID}/notes", json={"text": "ok", "agent_name": "codex"}).status_code, 201)

    def test_form_and_agent_starts_record_their_origin(self):
        with patch.object(jobs, "launch", return_value=(RUN_ID, True)) as launch:
            response = self.form()
            self.assertEqual(response.status_code, 303)
            self.assertEqual(response.location, f"/runs/{RUN_ID}")
            spec = launch.call_args.args[1]
            self.assertEqual(spec["origin"], {"kind": "human", "name": "dashboard"})
            self.assertEqual(spec["arms"][0]["samples"], 2)
            self.assertEqual(spec["fixtures"], ["spring"])

            result = admin.start_run("Fixed beats none", [{"model": "qwen3.5:9b", "examples": "fixed"}],
                                     fixtures=["bezier"], agent_name="codex")
            self.assertEqual(result["run_id"], RUN_ID)
            spec = launch.call_args.args[1]
            self.assertEqual(spec["origin"], {"kind": "agent", "name": "codex"})
            self.assertEqual(spec["arms"][0]["label"], "qwen3.5:9b · fixed examples")

            response = self.client.post("/api/runs", json={"hypothesis": "h", "brief": "Teach friction",
                                                           "arms": [{"model": "qwen3.5:4b"}]})
            self.assertEqual(response.status_code, 201)
            self.assertEqual(launch.call_args.args[1]["origin"], {"kind": "agent", "name": "agent"})

    def test_invalid_specs_are_rejected_with_the_runner_message(self):
        with patch.object(jobs, "launch") as launch:
            self.assertEqual(self.form(csrf="wrong").status_code, 403)
            for fields, message in (
                ({"arm-0-model": "qwen9:missing"}, "Model is not installed: qwen9:missing"),
                ({"arm-0-samples": "9"}, "arm A samples must be 1–5"),
                ({"fixture": ["../etc"]}, "fixtures must be unique names"),
                ({"arm-0-enabled": ""}, "arms must list 1–4 arms"),
                ({"hypothesis": ""}, "hypothesis must be"),
            ):
                response = self.form(**fields)
                self.assertEqual(response.status_code, 400, fields)
                self.assertIn(message, response.data.decode())
            with self.assertRaisesRegex(ValueError, "checked-in arms need fixtures"):
                admin.start_run("h", [{"model": "checked-in"}], brief="Teach friction")
            launch.assert_not_called()

    def test_busy_dashboard_names_the_active_run(self):
        with patch.object(jobs, "launch", return_value=(RUN_ID, False)):
            self.assertEqual(self.form().status_code, 409)
            with self.assertRaisesRegex(ValueError, f"Run {RUN_ID} is active"):
                admin.start_run("h", [{"model": "qwen3.5:4b"}], fixtures=["spring"])
            self.assertEqual(self.client.post("/api/runs", json={"hypothesis": "h", "fixtures": ["spring"],
                                                                 "arms": [{"model": "qwen3.5:4b"}]}).status_code, 409)

    def test_run_again_prefills_the_form(self):
        write_run(self.root, origin={"kind": "human", "name": "dashboard"})
        page = self.client.get(f"/new?from={RUN_ID}").data.decode()
        self.assertIn('value="Retrieval helps"', page)
        self.assertIn('name="arm-1-enabled" value="1" checked', page)
        self.assertIn('<option selected>retrieved</option>', page)

    def test_legacy_runs_render_with_recomputed_tiers(self):
        folder = self.root / LEGACY_ID
        (folder / "case-1-attempt-1").mkdir(parents=True)
        (folder / "run.json").write_text('{"command":"eval"}')
        (folder / "results.json").write_text(json.dumps([{"model": "qwen3.5:4b", "name": "spring", "attempts": [
            {"path": "case-1-attempt-1", "checks": {"syntax": "pass", "startup": "pass", "fixture": "pass", "type": "fail"}}]}]))
        run = admin.get_run(LEGACY_ID)
        self.assertTrue(run["legacy"])
        self.assertEqual(run["cases"][0]["tier"], "working")
        self.assertIn("Legacy runs (1)", self.client.get("/").data.decode())
        self.assertIn("predates arms", self.client.get(f"/runs/{LEGACY_ID}").data.decode())
        self.assertEqual(admin.list_runs()["runs"], [])
        self.assertEqual(len(admin.list_runs(include_legacy=True)["runs"]), 1)

    def test_artifacts_download_and_read_safely(self):
        write_run(self.root)
        self.assertEqual(admin.read_attempt_artifact(RUN_ID, "case-1-attempt-1", "activity.js")["text"], "const x = 1;")
        response = self.client.get(f"/api/runs/{RUN_ID}/artifacts/case-1-attempt-1/activity.js?view=1")
        self.assertEqual((response.data, response.mimetype), (b"const x = 1;", "text/plain"))
        response.close()
        self.assertEqual(self.client.get(f"/api/runs/{RUN_ID}/artifacts/case-1-attempt-1/..%2Frun.json").status_code, 404)
        with self.assertRaises(FileNotFoundError):
            admin.read_attempt_artifact(RUN_ID, "../x", "activity.js")

    def test_launch_lock_cancel_and_startup_failure(self):
        spec = {"hypothesis": "h", "fixtures": ["spring"], "arms": []}
        with patch.object(jobs.subprocess, "Popen", side_effect=OSError("Node unavailable")):
            run, started = jobs.launch(self.root, spec)
        self.assertTrue(started)
        folder = self.root / run
        self.assertEqual(json.loads((folder / "experiment.json").read_text()), spec)
        self.assertEqual(jobs.job_state(folder)["status"], "failed")
        jobs.save_job(folder, {"status": "running"})
        self.assertIsNone(jobs.active_job(self.root))
        self.assertEqual(jobs.job_state(folder)["status"], "interrupted")

        with (self.root / ".admin.lock").open("w+") as lock:
            jobs.fcntl.flock(lock, jobs.fcntl.LOCK_EX)
            lock.write(run)
            lock.flush()
            jobs.save_job(folder, {"status": "running"})
            self.assertEqual(jobs.launch(self.root, spec), (run, False))
            self.assertEqual(self.client.post(f"/runs/{run}/cancel", data={"csrf": "test-token"}).status_code, 303)
            self.assertTrue((folder / "cancel.request").exists())
        self.assertEqual(self.client.post(f"/runs/{run}/cancel", data={"csrf": "test-token"}).status_code, 409)

    def test_worker_cancels_a_running_process(self):
        folder = self.root / "job"
        folder.mkdir()
        runner = self.root / "runner.mjs"
        runner.write_text("setInterval(() => {}, 1000);")
        jobs.save_job(folder, {"status": "queued"})
        (folder / "cancel.request").touch()
        with patch.object(jobs, "RUNNER", runner):
            jobs.worker(folder, [])
        self.assertEqual(jobs.job_state(folder)["status"], "cancelled")
        self.assertLess(jobs.job_state(folder)["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
