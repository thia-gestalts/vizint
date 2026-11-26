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


class SpecError(ValueError):
    pass


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
            names = sorted({item["name"] for item in json.load(response)["models"]})
            return [name for name in names if "embed" not in name], None
    except (OSError, URLError, ValueError, KeyError, TypeError):
        return [], "Ollama is unavailable. Only checked-in control arms can run."


def describe():
    result = subprocess.run(["node", str(RUNNER), "describe"], cwd=PROJECT,
                            capture_output=True, check=True, timeout=10)
    return json.loads(result.stdout)


def validate(spec):
    """Normalize a spec with the runner's own validation; raise SpecError with its message."""
    result = subprocess.run(["node", str(RUNNER), "validate"], cwd=PROJECT, input=json.dumps(spec).encode(),
                            capture_output=True, timeout=10)
    try:
        value = json.loads(result.stdout)
    except ValueError:
        raise SpecError(result.stderr.decode(errors="replace").strip() or "The runner could not validate the spec")
    if result.returncode or "error" in value:
        raise SpecError(value.get("error", "Invalid run spec"))
    installed, _ = models()
    missing = sorted({arm["model"] for arm in value["arms"]
                      if arm["model"] != "checked-in" and arm["model"] not in installed})
    if missing:
        raise SpecError("Model is not installed: " + ", ".join(missing))
    return value


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


def launch(root, spec):
    """Start a validated spec. Returns (run_id, started); run_id is the active run when busy."""
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
        (folder / "experiment.json").write_text(json.dumps(spec, indent=2))
        lock.seek(0)
        lock.truncate()
        lock.write(run_id)
        lock.flush()
        state = {"status": "queued", "queuedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        save_job(folder, state)
        args = ["run", "--spec", str(folder / "experiment.json")]
        try:
            with (folder / "runner.log").open("ab") as log:
                subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(folder), str(lock.fileno()), *args],
                                 cwd=PROJECT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 start_new_session=True, pass_fds=(lock.fileno(),))
        except OSError as error:
            save_job(folder, {**state, "status": "failed", "error": str(error)})
        return run_id, True


def worker(folder, args, lock_fd=None):
    state = {**job_state(folder), "status": "running",
             "startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    save_job(folder, state)
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
        # The runner exits nonzero only for infrastructure errors; draft outcomes are results.
        status = "cancelled" if cancelled else "completed" if process.returncode == 0 else "failed"
    except OSError as error:
        status = "failed"
        result["error"] = str(error)
    save_job(folder, {**state, **result, "status": status,
                      "finishedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")})


if __name__ == "__main__":
    worker(Path(sys.argv[1]), sys.argv[3:], int(sys.argv[2]))
