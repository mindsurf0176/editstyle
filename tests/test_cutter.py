"""Actual-media regression for cuts between H.264 keyframes."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from array import array
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import cutai.preview as preview
import cutai.server as server
from cutai.editor.cutter import apply_cuts
from cutai.editor.renderer import render
from cutai.models.types import CutOperation, EditPlan, VideoAnalysis
from cutai.preview import render_preview

pytestmark = pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="FFmpeg and FFprobe are required for actual-media checks",
)


def _frame(path, index):
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"select=eq(n\\,{index})",
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        check=True, capture_output=True, timeout=30,
    ).stdout


@pytest.fixture(params=[False, True], ids=["silent", "audio"])
def source_video(tmp_path, request):
    with_audio = request.param
    source = tmp_path / "long-gop.mp4"
    command = [
        "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
        "testsrc2=size=160x90:rate=24:duration=10",
    ]
    if with_audio:
        # Each source second has its own tone, so removed audio is observable.
        command += ["-f", "lavfi", "-i", "aevalsrc=sin(2*PI*(220+110*floor(t))*t):s=48000:d=10"]
    command += [
        "-c:v", "libx264", "-g", "240", "-keyint_min", "240", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
    ]
    subprocess.run(command, check=True, capture_output=True, timeout=30)
    return source, with_audio


@pytest.mark.parametrize("operations", [
    [CutOperation(action="keep", start_time=1, end_time=3),
     CutOperation(action="keep", start_time=7, end_time=9)],
    [CutOperation(action="remove", start_time=3, end_time=7),
     CutOperation(action="keep", start_time=1, end_time=9)],
], ids=["keeps", "mixed"])
@pytest.mark.parametrize("pipeline", ["cut", "render", "preview"])
def test_non_keyframe_cuts_preserve_duration_content_and_audio(
    tmp_path, source_video, operations, pipeline,
):
    source, with_audio = source_video
    output = tmp_path / "cut.mp4"
    if pipeline == "cut":
        apply_cuts(str(source), operations, str(output))
    else:
        analysis = VideoAnalysis(file_path=str(source), duration=10, fps=24, width=160, height=90)
        plan = EditPlan(instruction="source cuts", operations=operations, estimated_duration=4)
        if pipeline == "render":
            render(str(source), plan, analysis, str(output))
        else:
            render_preview(str(source), plan, analysis, str(output), resolution=90)

    metadata = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(output)],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout)
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    assert abs(float(metadata["format"]["duration"]) - 4) < 0.15
    assert int(video["nb_frames"]) == 96
    assert any(stream["codec_type"] == "audio" for stream in metadata["streams"]) == with_audio
    for output_frame, source_frame in [(0, 24), (47, 71), (48, 168), (95, 215)]:
        expected = _frame(source, source_frame)
        actual = _frame(output, output_frame)
        assert len(actual) == len(expected) == 160 * 90 * 3
        assert sum(abs(a - b) for a, b in zip(actual, expected, strict=True)) / len(actual) < 8
    if with_audio:
        samples = array("h", subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(output), "-vn", "-ac", "1", "-ar", "48000",
             "-f", "s16le", "-"], check=True, capture_output=True, timeout=30,
        ).stdout)
        assert abs(len(samples) / 48000 - 4) < 0.15
        for start, frequency in [(0.5, 330), (2.5, 990)]:
            window = samples[int(start * 48000):int((start + 0.25) * 48000)]
            crossings = sum(left <= 0 < right for left, right in zip(window, window[1:], strict=False))
            assert abs(crossings / 0.25 - frequency) < 20
    subprocess.run(
        ["ffmpeg", "-v", "error", "-xerror", "-i", str(output), "-f", "null", "-"],
        check=True, capture_output=True, timeout=30,
    )


@pytest.mark.parametrize("operations", [
    [CutOperation(action="remove", start_time=0, end_time=10)],
    [CutOperation(action="keep", start_time=1, end_time=9),
     CutOperation(action="remove", start_time=0, end_time=10)],
    [CutOperation(action="keep", start_time=7, end_time=12)],
])
def test_invalid_cuts_do_not_create_output_from_actual_source(tmp_path, source_video, operations):
    source, _ = source_video
    output = tmp_path / "invalid.mp4"
    with pytest.raises(ValueError, match="entire video|Cut ranges"):
        apply_cuts(str(source), operations, str(output))
    assert not output.exists()


def test_fractional_end_survives_import_analysis_save_reopen_render_and_preview(monkeypatch, tmp_path):
    source = tmp_path / "fractional.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
        "testsrc2=size=160x90:rate=30000/1001:duration=10.01",
        "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=10.010667",
        "-c:v", "libx264", "-c:a", "aac", "-movie_timescale", "48000", str(source),
    ], check=True, capture_output=True, timeout=30)
    raw_duration = float(subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(source),
    ], check=True, capture_output=True, text=True, timeout=30).stdout)
    # The rounded API end really exceeds the physical container end in this case.
    assert raw_duration == pytest.approx(10.010667, abs=0.000001)
    assert round(raw_duration, 3) > raw_duration

    client = TestClient(server.app)
    uploaded = client.post("/api/videos/upload", files={"file": (source.name, source.read_bytes())})
    assert uploaded.status_code == 200, uploaded.text
    info = uploaded.json()
    duration = info["duration"]
    assert duration == round(raw_duration, 3)
    job_id = server._create_job("analysis")
    asyncio.run(server._run_analysis(job_id, info["video_id"], info["path"], "base", True))
    assert server.jobs[job_id]["status"] == "completed", server.jobs[job_id]
    analysis_data = client.get(f"/api/videos/{info['video_id']}/analysis").json()
    assert analysis_data["duration"] == duration
    plan = EditPlan(instruction="retain the source end", operations=[
        CutOperation(action="keep", start_time=1.001, end_time=duration),
        CutOperation(action="remove", start_time=3.003, end_time=5.005),
    ], estimated_duration=duration - 3.003, summary="Fractional source boundary")
    snapshot = client.get(f"/api/projects/{info['video_id']}").json()
    snapshot["state"]["edit_plan"] = plan.model_dump()
    saved = client.put(f"/api/projects/{info['video_id']}", json={
        "schema_version": 1, "expected_revision": 0, "state": snapshot["state"],
    })
    assert saved.status_code == 200, saved.text
    server.videos.clear()
    restored = client.post(f"/api/projects/{info['video_id']}/open").json()
    assert restored["state"]["edit_plan"] == plan.model_dump()
    assert restored["analysis"]["duration"] == duration

    proxy_durations = []
    downscale = preview._downscale_video

    def inspect_proxy(*args, **kwargs):
        downscale(*args, **kwargs)
        proxy_durations.append(float(subprocess.run([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", args[1],
        ], check=True, capture_output=True, text=True, timeout=30).stdout))

    monkeypatch.setattr(preview, "_downscale_video", inspect_proxy)
    original_bytes = Path(info["path"]).read_bytes()
    for pipeline in ("cut", "render", "preview"):
        output = tmp_path / f"fractional-{pipeline}.mp4"
        if pipeline == "cut":
            apply_cuts(info["path"], plan.operations, str(output))
        else:
            job_id = server._create_job(pipeline)
            if pipeline == "render":
                asyncio.run(server._run_render(
                    job_id, info["path"], restored["analysis"], restored["state"]["edit_plan"],
                    str(output), "balanced", "burned", None,
                ))
            else:
                asyncio.run(server._run_preview(
                    job_id, info["path"], restored["analysis"], restored["state"]["edit_plan"],
                    str(output), 90,
                ))
            assert server.jobs[job_id]["status"] == "completed", server.jobs[job_id]
        metadata = json.loads(subprocess.run([
            "ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(output),
        ], check=True, capture_output=True, text=True, timeout=30).stdout)
        video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
        assert int(video["nb_frames"]) == 210
        assert abs(float(metadata["format"]["duration"]) - plan.estimated_duration) < 0.15
        assert any(stream["codec_type"] == "audio" for stream in metadata["streams"])
        expected, actual = _frame(source, 299), _frame(output, 209)
        assert len(expected) == len(actual) == 160 * 90 * 3
        assert sum(abs(a - b) for a, b in zip(actual, expected, strict=True)) / len(actual) < 8
    assert proxy_durations and proxy_durations[0] != raw_duration
    assert Path(info["path"]).read_bytes() == original_bytes

    # Millisecond quantization is not an allowance for out-of-source cut times.
    invalid = plan.model_copy(deep=True)
    invalid.operations[0].end_time = duration + 0.001
    for endpoint in ("/api/render", "/api/preview"):
        response = client.post(endpoint, json={"video_id": info["video_id"], "plan": invalid.model_dump()})
        assert response.status_code == 422, response.text
        assert "Cut ranges" in response.json()["detail"]
    with pytest.raises(ValueError, match="Cut ranges"):
        apply_cuts(info["path"], invalid.operations, str(tmp_path / "invalid-end.mp4"))
