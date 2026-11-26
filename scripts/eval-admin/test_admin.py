import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import admin
import jobs


class AdminTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        root_patch = patch.object(admin, "ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)
        self.client = admin.flask.test_client()
        with self.client.session_transaction() as session:
            session["csrf"] = "test-token"

    def post(self, action, **fields):
        return self.client.post("/evaluations", data={"action": action, "csrf": "test-token", **fields})

    def test_form_renders_and_rejects_invalid_or_cross_site_requests(self):
        with patch.object(jobs, "models", return_value=(["qwen3.5:4b"], None)),                 patch.object(jobs, "fixtures", return_value=["bezier"]):
            self.assertIn(b"Compare JavaScript and TypeScript", self.client.get("/evaluate").data)
            self.assertEqual(self.client.post("/evaluations", data={"action": "control"}).status_code, 403)
            self.assertEqual(self.post("eval", model="--help").status_code, 400)
            self.assertEqual(self.post("compare", model="qwen3.5:4b", fixture="../../etc").status_code, 400)
            self.assertEqual(self.post("replay", run_id="../etc").status_code, 400)

    def test_global_navigation_and_legacy_history_links(self):
        run_id = "2026-01-01T00-00-00.000Z-12345678"
        (self.root / run_id).mkdir()
        with patch.object(jobs, "models", return_value=(["qwen3.5:4b"], None)) as models, \
                patch.object(jobs, "fixtures", return_value=["bezier"]), \
                patch.object(jobs, "active_job", return_value=run_id):
            self.assertEqual(self.client.get("/").location, "/evaluate")
            self.assertEqual(self.client.get("/?status=failed").location, "/runs?status=failed")
            for path in ("/runs?status=failed", f"/runs/{run_id}"):
                page = self.client.get(path)
                self.assertEqual(page.status_code, 200)
                self.assertIn(b'aria-label="Admin navigation"', page.data)
                self.assertIn(b'href="/evaluate">Evaluate', page.data)
                self.assertIn(b'href="/runs" aria-current="page">Run history', page.data)
                self.assertIn(f'href="/runs/{run_id}">Active evaluation'.encode(), page.data)
            models.assert_not_called()
            page = self.client.get("/evaluate")
            self.assertIn(b'href="/evaluate" aria-current="page">Evaluate', page.data)
            for tool in (b"compare", b"eval", b"control", b"replay"):
                self.assertIn(b'href="#' + tool + b'"', page.data)
                self.assertIn(b'id="' + tool + b'"', page.data)

    def test_all_workflows_launch_with_fixed_arguments(self):
        run_id = "2026-01-01T00-00-00.000Z-12345678"
        (self.root / run_id).mkdir()
        with patch.object(jobs, "models", return_value=(["qwen3.5:4b", "qwen3.5:9b"], None)),                 patch.object(jobs, "fixtures", return_value=["bezier"]),                 patch.object(jobs, "launch", return_value=(run_id, True)) as launch:
            cases = [
                ("control", {}, ["eval", "--control"]),
                ("eval", {"model": ["qwen3.5:4b", "qwen3.5:9b"], "fixture": "bezier", "repair": "once"},
                 ["eval", "--model", "qwen3.5:4b", "--model", "qwen3.5:9b", "--fixture", "bezier",
                  "--repair-policy", "once"]),
                ("compare", {"model": "qwen3.5:4b"}, ["compare", "--model", "qwen3.5:4b"]),
                ("replay", {"run_id": run_id}, ["replay", run_id]),
            ]
            for action, fields, argv in cases:
                response = self.post(action, **fields)
                self.assertEqual(response.location, f"/runs/{run_id}")
                launch.assert_called_with(self.root, argv, action)
                self.assertEqual(self.client.get(response.location).status_code, 200)

    def test_lock_recovery_cancel_and_startup_failure(self):
        with patch.object(jobs.subprocess, "Popen", side_effect=OSError("Node unavailable")):
            run, started = jobs.launch(self.root, ["eval", "--control"], "control")
        self.assertTrue(started)
        folder = self.root / run
        self.assertEqual(jobs.job_state(folder)["status"], "failed")
        self.assertIn(b"Node unavailable", self.client.get(f"/runs/{run}").data)
        jobs.save_job(folder, {"action": "control", "status": "running"})
        self.assertIsNone(jobs.active_job(self.root))
        self.assertEqual(jobs.job_state(folder)["status"], "interrupted")

        with (self.root / ".admin.lock").open("w+") as lock:
            jobs.fcntl.flock(lock, jobs.fcntl.LOCK_EX)
            lock.write(run)
            lock.flush()
            jobs.save_job(folder, {"action": "control", "status": "running"})
            self.assertEqual(jobs.launch(self.root, ["eval", "--control"], "control"), (run, False))
            self.assertTrue(self.post("control").location.endswith("?busy=1"))
            self.assertEqual(self.client.post(f"/runs/{run}/cancel", data={"csrf": "test-token"}).status_code, 303)
            self.assertTrue((folder / "cancel.request").exists())

    def test_worker_cancels_a_running_process(self):
        folder = self.root / "job"
        folder.mkdir()
        runner = self.root / "runner.mjs"
        runner.write_text("setInterval(() => {}, 1000);")
        jobs.save_job(folder, {"action": "compare", "status": "queued"})
        (folder / "cancel.request").touch()
        with patch.object(jobs, "RUNNER", runner):
            jobs.worker(folder, ["compare"])
        self.assertEqual(jobs.job_state(folder)["status"], "cancelled")
        self.assertLess(jobs.job_state(folder)["exitCode"], 0)

    def test_comparison_artifacts_and_incomplete_pair(self):
        run_id = "2026-01-01T00-00-00.000Z-12345678"
        folder = self.root / run_id
        attempt = folder / "case-1-attempt-1"
        attempt.mkdir(parents=True)
        for name in ("activity.ts", "activity.bundle.js"):
            (attempt / name).write_text("const x = 1;")
        (folder / "run.json").write_text(
            '{"command":"compare","cases":[{"pairId":"1","fixture":"bezier","order":["typescript","javascript"]}]}')
        (folder / "results.json").write_text(
            '[{"pairId":"1","name":"bezier","language":"typescript","working":true,"finished":true,'
            '"attempts":[{"path":"case-1-attempt-1","seconds":1,"passed":false}]}]')
        run = admin.get_run(run_id)
        self.assertEqual(admin.language_summary(run)["incomplete"], 1)
        self.assertIn(b"Incomplete pairs 1", self.client.get(f"/runs/{run_id}").data)
        for name, url in run["cases"][0]["attempts"][0]["artifacts"].items():
            self.assertEqual(admin.read_attempt_artifact(run_id, "case-1-attempt-1", name)["text"], "const x = 1;")
            response = self.client.get(url)
            self.assertEqual(response.data, b"const x = 1;")
            response.close()


if __name__ == "__main__":
    unittest.main()
