"""Actual-media regression for cuts between H.264 keyframes."""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from cutai.editor.cutter import apply_cuts
from cutai.models.types import CutOperation

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


@pytest.mark.parametrize("with_audio", [False, True])
def test_non_keyframe_cuts_preserve_duration_content_and_audio(tmp_path, with_audio):
    source = tmp_path / "long-gop.mp4"
    output = tmp_path / "cut.mp4"
    command = [
        "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
        "testsrc2=size=160x90:rate=24:duration=10",
    ]
    if with_audio:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=10"]
    command += [
        "-c:v", "libx264", "-g", "240", "-keyint_min", "240", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
    ]
    subprocess.run(command, check=True, capture_output=True, timeout=30)

    apply_cuts(str(source), [
        CutOperation(action="keep", start_time=1, end_time=3),
        CutOperation(action="keep", start_time=7, end_time=9),
    ], str(output))

    metadata = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(output)],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout)
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    assert abs(float(metadata["format"]["duration"]) - 4) < 0.15
    assert int(video["nb_frames"]) == 96
    assert any(stream["codec_type"] == "audio" for stream in metadata["streams"]) == with_audio
    for output_frame, source_frame in [(0, 24), (48, 168)]:
        expected = _frame(source, source_frame)
        actual = _frame(output, output_frame)
        assert len(actual) == len(expected) == 160 * 90 * 3
        assert sum(abs(a - b) for a, b in zip(actual, expected, strict=True)) / len(actual) < 8
    subprocess.run(
        ["ffmpeg", "-v", "error", "-xerror", "-i", str(output), "-f", "null", "-"],
        check=True, capture_output=True, timeout=30,
    )
