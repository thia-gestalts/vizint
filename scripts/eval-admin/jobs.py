import fcntl
import json
import os
import signal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
RUNNER = PROJECT / "scripts/view-generation.mjs"
ACTIVE = ("queued", "running", "cancelling")


def job_state(folder):
    try:
        file = folder / "job.json"
        if file.is_symlink():
            return {}
        value = json.loads(file.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_job(folder, state):
    temporary = folder / ("job-" + uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(state))
    temporary.replace(folder / "job.json")


def models():
    endpoint = os.environ.get("VIZINT_OLLAMA_URL", "http://localhost:11434")
    try:
        with urlopen(endpoint.rstrip("/") + "/api/tags", timeout=2) as response:
            return sorted({item["name"] for item in json.load(response)["models"]}), None
    except (OSError, URLError, ValueError, KeyError, TypeError):
        return [], "Ollama models are unavailable. The Bézier control can still run."


def fixtures():
    result = subprocess.run(["node", str(RUNNER), "describe"], cwd=PROJECT,
                            capture_output=True, check=True, timeout=5)
    return json.loads(result.stdout)["fixtures"]


def recover_abandoned(root):
    for file in root.glob("*/job.json"):
        if file.parent.is_symlink() or file.is_symlink():
            continue
        state = job_state(file.parent)
        if state.get("status") in ACTIVE:
            save_job(file.parent, {**state, "status": "interrupted"})


def active_job(root):
    root.mkdir(exist_ok=True)
    with (root / ".admin.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.seek(0)
            return lock.read().strip() or None
        recover_abandoned(root)
        return None


def launch(root, args, action):
    root.mkdir(exist_ok=True)
    with (root / ".admin.lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.seek(0)
            return lock.read().strip() or None, False
        recover_abandoned(root)
        run_id = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z").replace(":", "-") + "-" + uuid4().hex[:8]
        folder = root / run_id
        folder.mkdir()
        lock.seek(0)
        lock.truncate()
        lock.write(run_id)
        lock.flush()
        state = {"action": action, "status": "queued"}
        save_job(folder, state)
        try:
            with (folder / "runner.log").open("ab") as log:
                subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(folder), str(lock.fileno()), *args],
                                 cwd=PROJECT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 start_new_session=True, pass_fds=(lock.fileno(),))
        except OSError as error:
            save_job(folder, {**state, "status": "failed", "error": str(error)})
        return run_id, True


def worker(folder, args, lock_fd=None):
    state = job_state(folder)
    save_job(folder, {**state, "status": "running"})
    result = {}
    try:
        env = {**os.environ, "VIZINT_EVAL_RUN_ID": folder.name}
        process = subprocess.Popen(["node", str(RUNNER), *args], cwd=PROJECT, env=env, start_new_session=True,
                                   pass_fds=() if lock_fd is None else (lock_fd,))
        cancelled = False
        while process.poll() is None:
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                if not (folder / "cancel.request").exists():
                    continue
                cancelled = True
                save_job(folder, {**state, "status": "cancelling"})
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                except ProcessLookupError:
                    process.wait()
        result["exitCode"] = process.returncode
        if cancelled:
            status = "cancelled"
        elif process.returncode == 0:
            status = "completed"
        elif state["action"] in ("eval", "control") and process.returncode == 1:
            rows = json.loads((folder / "results.json").read_text())
            planned = json.loads((folder / "run.json").read_text())["cases"]
            status = "completed" if rows and len(rows) == len(planned) and all(
                row.get("finished") and row.get("stopReason") != "infrastructure-error" for row in rows
            ) else "failed"
        else:
            status = "failed"
    except (OSError, ValueError, KeyError) as error:
        status = "failed"
        result["error"] = str(error)
    save_job(folder, {**state, **result, "status": status})


if __name__ == "__main__":
    worker(Path(sys.argv[1]), sys.argv[3:], int(sys.argv[2]))
