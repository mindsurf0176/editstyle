"""Exercise a running local CutAI backend with real media, without a model or API key."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import httpx


def probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
        capture_output=True, text=True, check=True, timeout=30,
    )
    return json.loads(result.stdout)


def wait_for_job(client: httpx.Client, job_id: str, timeout: float = 180) -> dict:
    deadline = time.monotonic() + timeout
    previous = None
    while time.monotonic() < deadline:
        response = client.get(f"/api/jobs/{job_id}")
        response.raise_for_status()
        job = response.json()
        status = (job["status"], job["progress"])
        if status != previous:
            print(f"{job['type']}: {status}", flush=True)
            previous = status
        if job["status"] == "failed":
            raise RuntimeError(f"{job['type']} failed: {job['error']}")
        if job["status"] == "completed":
            return job
        time.sleep(0.5)
    raise TimeoutError(f"Job {job_id} did not complete within {timeout}s")


def post(client: httpx.Client, path: str, body: dict) -> dict:
    response = client.post(path, json=body)
    response.raise_for_status()
    return response.json()


def verify_media(path: Path, expected_duration: float, height: int, needs_audio: bool) -> dict:
    metadata = probe(path)
    duration = float(metadata["format"]["duration"])
    if not math.isfinite(duration) or abs(duration - expected_duration) > 0.15:
        raise AssertionError(f"{path.name}: expected {expected_duration}s, got {duration}s")
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    if video["height"] != height:
        raise AssertionError(f"{path.name}: expected height {height}, got {video['height']}")
    has_audio = any(stream["codec_type"] == "audio" for stream in metadata["streams"])
    if needs_audio and not has_audio:
        raise AssertionError(f"{path.name}: source audio was lost")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-f", "null", "-"],
        check=True, capture_output=True, timeout=120,
    )
    return {"duration": duration, "width": video["width"], "height": height,
            "has_audio": has_audio, "full_decode": "passed", "bytes": path.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Existing video longer than 18 seconds")
    parser.add_argument("--url", default="http://127.0.0.1:18910")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    endpoint = urlparse(args.url)
    if endpoint.scheme != "http" or endpoint.hostname not in {"localhost", "127.0.0.1", "::1"}:
        parser.error("QA uploads media only to an HTTP loopback backend")
    source = args.source.resolve(strict=True)
    metadata = probe(source)
    if float(metadata["format"]["duration"]) <= 18:
        parser.error("Use a source longer than 18 seconds for two separated six-second cuts")
    source_video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    has_audio = any(stream["codec_type"] == "audio" for stream in metadata["streams"])
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = args.output or Path("out") / f"cutai-qa-{timestamp}"
    output.mkdir(parents=True, exist_ok=False)

    with httpx.Client(base_url=args.url, timeout=120, trust_env=False) as client:
        client.get("/api/health").raise_for_status()
        with source.open("rb") as media:
            response = client.post("/api/videos/upload", files={"file": (source.name, media, "video/mp4")})
        response.raise_for_status()
        video_id = response.json()["video_id"]
        started = post(client, f"/api/videos/{video_id}/analyze", {"skip_transcription": True})
        analysis = wait_for_job(client, started["job_id"])["result"]
        if not analysis["scenes"]:
            raise AssertionError("Real scene analysis produced no scenes")
        plan = post(client, "/api/plan", {
            "video_id": video_id, "instruction": "따뜻한 톤으로", "use_llm": False,
        })
        if not any(op["type"] == "colorgrade" and op["preset"] == "warm" for op in plan["operations"]):
            raise AssertionError("Rule-based warm-color planning did not produce a color operation")
        plan["operations"] += [
            {"type": "cut", "action": "keep", "start_time": 0, "end_time": 6, "reason": "Manual first cut"},
            {"type": "cut", "action": "keep", "start_time": 12, "end_time": 18, "reason": "Manual second cut"},
        ]
        plan["estimated_duration"] = 12
        plan["summary"] = "Keep 0–6s and 12–18s; warm color grade"
        (output / "plan.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n")
        results = {}
        for kind, options in (("preview", {"resolution": 360}), ("render", {"render_preset": "balanced"})):
            started = post(client, f"/api/{kind}", {"video_id": video_id, "plan": plan, **options})
            job = wait_for_job(client, started["job_id"])
            response = client.get(f"/api/{kind}/{job['job_id']}/download")
            response.raise_for_status()
            path = output / f"{kind}.mp4"
            path.write_bytes(response.content)
            height = 360 if kind == "preview" else min(source_video["height"], 1080)
            results[kind] = verify_media(path, 12, height, has_audio)
            results[kind]["job_id"] = job["job_id"]
        report = {
            "passed": True, "timestamp_utc": timestamp, "source": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "video_id": video_id, "scene_count": len(analysis["scenes"]),
            "transcription": "skipped explicitly", "llm": "disabled explicitly",
            "media": results,
        }
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        print(f"Evidence: {output.resolve()}")


if __name__ == "__main__":
    main()
