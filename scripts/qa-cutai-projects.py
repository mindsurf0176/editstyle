"""Verify saved projects with real media and two isolated, owned backend processes."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
import signal
import socket
import subprocess
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, redirect_stdout, suppress
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier

import httpx

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("editor_qa", ROOT / "scripts/qa-cutai-editor.py")
assert spec is not None and spec.loader is not None
editor_qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(editor_qa)


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def expect(response: httpx.Response, status: int = 200):
    if response.status_code != status:
        raise AssertionError(f"{response.request.method} {response.request.url}: "
                             f"expected {status}, got {response.status_code}: {response.text}")
    return response.json()


@contextmanager
def backend(listener: socket.socket, output: Path, generation: int, report: dict):
    """The inherited socket reserves our port; the process group owns FFmpeg children."""
    environment = {**os.environ, "CUTAI_DATA_DIR": str(output / "data"),
                   "TMPDIR": str(output / "tmp"), "PYTHONUNBUFFERED": "1"}
    log_path = output / f"backend-{generation}.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "cutai.server:app", "--fd", str(listener.fileno())],
            cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT,
            pass_fds=(listener.fileno(),), start_new_session=True,
        )
        record = {"pid": process.pid, "log": str(log_path)}
        report["processes"].append(record)
        try:
            with httpx.Client(base_url=report["url"], timeout=30, trust_env=False) as client:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f"Backend exited during startup; see {log_path}")
                    try:
                        expect(client.get("/api/health", timeout=0.5))
                        break
                    except (httpx.TransportError, AssertionError):
                        time.sleep(0.1)
                else:
                    raise TimeoutError(f"Backend was not ready within 30s; see {log_path}")
                yield client
        finally:
            # Only signal the new session created above, never an existing server.
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            # A crashed backend can leave its own worker child alive.
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            record["returncode"] = process.returncode
            record["stopped"] = process.poll() is not None


def finish_job(client: httpx.Client, started: dict, timeout: float) -> dict:
    with redirect_stdout(sys.stderr):
        return editor_qa.wait_for_job(client, started["job_id"], timeout=timeout)


def render_media(client: httpx.Client, snapshot: dict, output: Path,
                 timeout: float, source_video: dict) -> dict:
    state = snapshot["state"]
    results = {}
    for kind, options in (
        ("preview", {"resolution": state["preview_resolution"]}),
        ("render", {"render_preset": state["render_preset"],
                    "subtitle_export_mode": state["subtitle_export_mode"]}),
    ):
        path = output / f"{kind}.mp4"
        started = expect(client.post(f"/api/{kind}", json={
            "video_id": snapshot["video_id"], "plan": state["edit_plan"],
            "output_path": str(path), **options,
        }))
        job = finish_job(client, started, timeout)
        response = client.get(f"/api/{kind}/{job['job_id']}/download")
        response.raise_for_status()
        assert hashlib.sha256(response.content).hexdigest() == digest(path)
        height = state["preview_resolution"] if kind == "preview" else min(source_video["height"], 720)
        result = editor_qa.verify_media(path, 8, height, needs_audio=True)
        width = math.floor(source_video["width"] * height / source_video["height"] / 2 + 0.5) * 2
        assert result["width"] == width, result
        results[kind] = {**result, "job_id": job["job_id"], "download_matches_file": True}
    return results


def acceptance(source: Path, output: Path, timeout: float, report: dict) -> None:
    metadata = editor_qa.probe(source)
    source_video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    assert float(metadata["format"]["duration"]) >= 18, "Source must be at least 18 seconds"
    assert any(stream["codec_type"] == "audio" for stream in metadata["streams"]), "Source needs audio"
    source_hash = digest(source)
    report.update(source=str(source), source_sha256=source_hash)
    data_dir = output / "data"
    (output / "tmp").mkdir()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        report["url"] = f"http://127.0.0.1:{listener.getsockname()[1]}"
        with backend(listener, output, 1, report) as client:
            assert expect(client.get("/api/projects/current")) is None
            with source.open("rb") as media:
                info = expect(client.post("/api/videos/upload", files={
                    "file": (source.name, media, "video/mp4"),
                }))
            video_id = info["video_id"]
            managed_source = Path(info["path"]).resolve()
            assert managed_source.is_relative_to(data_dir / "media")
            assert digest(managed_source) == source_hash
            report["video_id"] = video_id
            report["managed_source"] = str(managed_source)
            initial = expect(client.get("/api/projects/current"))
            assert initial["revision"] == 0 and initial["analysis"] is None
            analysis_job = finish_job(client, expect(client.post(
                f"/api/videos/{video_id}/analyze", json={"skip_transcription": True},
            )), timeout)
            analysis = analysis_job["result"]
            assert analysis["scenes"] and analysis["transcript"] == []
            report["scene_count"] = len(analysis["scenes"])
            plan = expect(client.post("/api/plan", json={
                "video_id": video_id, "instruction": "따뜻한 톤으로", "use_llm": False,
            }))
            assert any(op["type"] == "colorgrade" and op["preset"] == "warm" for op in plan["operations"])
            plan["operations"].extend([
                {"type": "cut", "action": "keep", "start_time": 0, "end_time": 12, "reason": "Keep first 12s"},
                {"type": "cut", "action": "remove", "start_time": 4, "end_time": 8, "reason": "Remove middle 4s"},
            ])
            plan.update(estimated_duration=8, summary="Keep 0–12s minus 4–8s; warm color grade")
            undo_plan = copy.deepcopy(plan)
            undo_plan["operations"].pop()
            undo_plan.update(estimated_duration=12, summary="Before middle removal")
            state = {"edit_plan": plan, "undo_stack": [None, undo_plan],
                     "preview_resolution": 480, "render_preset": "draft",
                     "subtitle_export_mode": "burned", "transcribe_on_import": True,
                     "playhead_time": 0,
                     "planning_style_preset": {"name": "QA warm", "description": "Saved planning preference",
                                               "style": {"color_grading": {"preset": "warm"}}}}
            update = {"schema_version": 1, "expected_revision": 0, "state": state}
            barrier = Barrier(2)

            def competing_save():
                with httpx.Client(base_url=report["url"], timeout=30, trust_env=False) as concurrent:
                    barrier.wait(timeout=10)
                    return concurrent.put(f"/api/projects/{video_id}", json=update)

            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda _: competing_save(), range(2)))
            assert sorted(response.status_code for response in responses) == [200, 409]
            saved = next(response.json() for response in responses if response.status_code == 200)
            assert saved["revision"] == 1 and saved["state"] == state and saved["analysis"] == analysis
            expect(client.put(f"/api/projects/{video_id}", json=update), 409)
            report["checks"].append("revision 0 -> 1; concurrent and stale saves rejected with 409")

            expect(client.put(f"/api/projects/{video_id}", json={**update, "expected_revision": 1},
                              headers={"Origin": "https://hostile.example"}), 403)
            report["checks"].append("hostile Origin mutation rejected with 403")
            protected = [managed_source, data_dir / "projects.sqlite3"]
            before = {str(path): digest(path) for path in protected}
            for kind in ("preview", "render"):
                for destination in protected:
                    expect(client.post(f"/api/{kind}", json={
                        "video_id": video_id, "plan": plan, "output_path": str(destination),
                    }), 422)
            assert before == {str(path): digest(path) for path in protected}
            invalid = copy.deepcopy(plan)
            invalid["operations"][-1]["end_time"] = float(info["duration"]) + 1
            for kind in ("preview", "render"):
                expect(client.post(f"/api/{kind}", json={
                    "video_id": video_id, "plan": invalid, "output_path": str(output / f"invalid-{kind}.mp4"),
                }), 422)
                assert not (output / f"invalid-{kind}.mp4").exists()
            report["checks"].append("source/database overwrite and invalid source ranges rejected with 422")
            assert expect(client.get(f"/api/projects/{video_id}")) == saved
            report["before_restart"] = saved

            # Confirm a real in-flight job before terminating its owned backend and children.
            running = expect(client.post("/api/render", json={
                "video_id": video_id, "plan": plan, "render_preset": "high",
                "output_path": str(output / "interrupted.mp4"),
            }))
            running_status = expect(client.get(f"/api/jobs/{running['job_id']}"))
            assert running_status["status"] == "running", running_status
            report["old_jobs"] = {analysis_job["job_id"]: "completed", running["job_id"]: "running"}

        with backend(listener, output, 2, report) as client:
            reopened = expect(client.get("/api/projects/current"))
            assert reopened == saved
            assert expect(client.post(f"/api/projects/{video_id}/open")) == saved
            assert expect(client.get(f"/api/videos/{video_id}/analysis")) == analysis
            listed = expect(client.get("/api/projects"))
            assert len(listed) == 1 and listed[0]["video_id"] == video_id and listed[0]["revision"] == 1
            assert digest(managed_source) == source_hash
            for job_id in report["old_jobs"]:
                expect(client.get(f"/api/jobs/{job_id}"), 404)
            report["checks"].append("source, analysis, plan, undo and preferences survive process restart; old jobs return 404")
            report["media"] = render_media(client, reopened, output, timeout, source_video)
            report["checks"].append("reopened mixed cut preview/render: 8s, dimensions, audio, full decode and downloads")

            missing_copy = managed_source.with_suffix(managed_source.suffix + ".qa-missing")
            assert not missing_copy.exists()
            managed_source.rename(missing_copy)
            try:
                missing = expect(client.post(f"/api/projects/{video_id}/open"))
                assert missing["media_status"] == "missing"
                assert missing["state"] == state and missing["analysis"] == analysis
                for kind in ("preview", "render"):
                    expect(client.post(f"/api/{kind}", json={"video_id": video_id, "plan": plan}), 409)
            finally:
                missing_copy.rename(managed_source)
            assert expect(client.get("/api/projects/current")) == saved
            report["checks"].append("missing managed copy preserves project and blocks media jobs with 409; copy restored")
            assert digest(source) == source_hash and digest(managed_source) == source_hash
            report["checks"].append("input and managed source SHA-256 unchanged")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Optional source with audio, at least 18 seconds")
    parser.add_argument("--output", type=Path, help="Fresh evidence directory (default: out/cutai-projects-qa-TIMESTAMP)")
    parser.add_argument("--job-timeout", type=float, default=180, help="Deadline per media job, in seconds")
    args = parser.parse_args()
    if args.job_timeout <= 0:
        parser.error("--job-timeout must be positive")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = (args.output or ROOT / "out" / f"cutai-projects-qa-{timestamp}").resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {"passed": False, "timestamp_utc": timestamp, "evidence": str(output),
              "processes": [], "checks": [], "transcription": "skipped explicitly", "llm": "disabled explicitly"}
    try:
        source = args.source.resolve(strict=True) if args.source else output / "source.mp4"
        if args.source is None:
            subprocess.run([
                "ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=960x540:rate=24:duration=20",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
                "-shortest", str(source),
            ], check=True, capture_output=True, timeout=60)
        acceptance(source, output, args.job_timeout, report)
        report["passed"] = True
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
        traceback.print_exc(file=sys.stderr)
    finally:
        serialized = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        (output / "report.json").write_text(serialized, encoding="utf-8")
        print(serialized, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
