"""Audio mixer for CutAI narrator.

Mixes generated narration audio onto video using FFmpeg.
Supports voiceover mode (mix with original) and replace mode (replace original).
"""

from __future__ import annotations

import json
import logging
import subprocess
import tempfile
from pathlib import Path

from cutai.config import ensure_ffmpeg

logger = logging.getLogger(__name__)


def mix_voiceover(
    video_path: str,
    narration_segments: list[dict],
    output_path: str,
    original_volume: float = 0.3,
    narration_volume: float = 1.0,
) -> str:
    """Mix narration audio onto video as a voiceover (original audio kept, lowered).

    Args:
        video_path: Path to the source video.
        narration_segments: List of dicts with "id", "audio_path", and "start_time".
        output_path: Path for the output video.
        original_volume: Volume level for original audio (0.0-1.0).
        narration_volume: Volume level for narration audio (0.0-1.0).

    Returns:
        Path to the output video.
    """
    if not narration_segments:
        logger.warning("No narration segments to mix")
        return video_path

    ffmpeg = ensure_ffmpeg()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="cutai_narration_") as tmpdir:
        silent_narration = str(Path(tmpdir) / "narration_full.mp3")
        _create_silent_narration(narration_segments, video_path, silent_narration)

        cmd = [
            ffmpeg, "-y",
            "-i", video_path,
            "-i", silent_narration,
            "-filter_complex",
            f"[0:a]volume={original_volume}[bg];"
            f"[1:a]volume={narration_volume}[fg];"
            f"[bg][fg]amix=inputs=2:duration=longest[aout]",
            "-map", "0:v",
            "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            output_path,
        ]

        logger.info("Mixing voiceover onto video: %d segments", len(narration_segments))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)

        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg voiceover mixing failed: {result.stderr[-500:]}")

    return output_path


def replace_audio(
    video_path: str,
    narration_segments: list[dict],
    output_path: str,
    narration_volume: float = 1.0,
) -> str:
    """Replace original video audio with narration audio.

    Args:
        video_path: Path to the source video.
        narration_segments: List of dicts with "id", "audio_path", and "start_time".
        output_path: Path for the output video.
        narration_volume: Volume level for narration audio (0.0-1.0).

    Returns:
        Path to the output video.
    """
    if not narration_segments:
        logger.warning("No narration segments to mix")
        return video_path

    ffmpeg = ensure_ffmpeg()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="cutai_narration_") as tmpdir:
        silent_narration = str(Path(tmpdir) / "narration_full.mp3")
        _create_silent_narration(narration_segments, video_path, silent_narration)

        cmd = [
            ffmpeg, "-y",
            "-i", video_path,
            "-i", silent_narration,
            "-map", "0:v",
            "-map", "1:a",
            "-c:v", "copy",
            "-af", f"volume={narration_volume}",
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            output_path,
        ]

        logger.info("Replacing audio with narration: %d segments", len(narration_segments))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)

        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg audio replacement failed: {result.stderr[-500:]}")

    return output_path


def _create_silent_narration(
    segments: list[dict],
    video_path: str,
    output_path: str,
) -> str:
    """Create a single audio file with narration at the correct timestamps.

    Builds a full-duration silent audio track, then places each narration
    segment at its correct position using ffmpeg concat filter.

    Args:
        segments: List of dicts with "audio_path" and "start_time" keys.
        video_path: Source video (used to get duration).
        output_path: Path for the output audio file.
    """
    ffmpeg = ensure_ffmpeg()

    duration = _get_duration(video_path)

    if not segments:
        cmd = [
            ffmpeg, "-y",
            "-f", "lavfi",
            "-i", f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={duration}",
            "-t", str(duration),
            "-c:a", "libmp3lame",
            "-q:a", "2",
            output_path,
        ]
        subprocess.run(cmd, capture_output=True, check=True, timeout=60)
        return output_path

    filter_parts = [f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={duration}[bg]"]
    n = len(segments)

    for i, seg in enumerate(segments):
        audio_path = seg["audio_path"]
        start = float(seg.get("start_time", 0))
        delay_ms = int(start * 1000)
        filter_parts.append(f"[{i+1}:a]adelay={delay_ms}|{delay_ms}[d{i}];[bg][d{i}][bg{i}]")

    filter_parts.append(f"[bg{n}]")

    inputs = ["-f", "lavfi", "-i", f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={duration}"]
    for seg in segments:
        inputs.extend(["-i", seg["audio_path"]])

    cmd = [
        ffmpeg, "-y",
        *inputs,
        "-filter_complex",
        ";".join(filter_parts),
        "-map", f"[bg{n}]",
        "-c:a", "libmp3lame",
        "-q:a", "2",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        logger.warning("Complex narration mixing failed, trying simple concat: %s", result.stderr[-200:])
        _simple_concat_narration(segments, duration, output_path)
    else:
        logger.debug("Narration audio created: %s", output_path)

    return output_path


def _simple_concat_narration(
    segments: list[dict],
    video_duration: float,
    output_path: str,
) -> str:
    """Simple fallback: create silence + concat narration segments."""
    ffmpeg = ensure_ffmpeg()

    parts: list[str] = []

    prev_end = 0.0
    for seg in segments:
        start = float(seg.get("start_time", 0))
        silence_duration = start - prev_end

        if silence_duration > 0.1:
            silence_path = output_path + f".silence_{prev_end:.0f}.mp3"
            cmd = [
                ffmpeg, "-y",
                "-f", "lavfi",
                "-i", f"anullsrc=channel_layout=mono:sample_rate=44100:duration={silence_duration}",
                "-c:a", "libmp3lame",
                "-q:a", "2",
                silence_path,
            ]
            subprocess.run(cmd, capture_output=True, check=True, timeout=60)
            parts.append(silence_path)

        parts.append(seg["audio_path"])
        prev_end = start + _get_audio_duration(seg["audio_path"])

    remaining = video_duration - prev_end
    if remaining > 0.1:
        silence_path = output_path + f".silence_end.mp3"
        cmd = [
            ffmpeg, "-y",
            "-f", "lavfi",
            "-i", f"anullsrc=channel_layout=mono:sample_rate=44100:duration={remaining}",
            "-c:a", "libmp3lame",
            "-q:a", "2",
            silence_path,
        ]
        subprocess.run(cmd, capture_output=True, check=True, timeout=60)
        parts.append(silence_path)

    concat_path = output_path + ".concat.txt"
    with open(concat_path, "w") as f:
        for p in parts:
            f.write(f"file '{p}'\n")

    cmd = [
        ffmpeg, "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concat_path,
        "-c:a", "libmp3lame",
        "-q:a", "2",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

    for p in parts:
        if p != output_path:
            with open(p, "w"):
                pass
        try:
            Path(p).unlink(missing_ok=True)
        except OSError:
            pass

    try:
        Path(concat_path).unlink(missing_ok=True)
    except OSError:
        pass

    if result.returncode != 0:
        raise RuntimeError(f"Simple concat failed: {result.stderr[-300:]}")

    return output_path


def _get_duration(file_path: str) -> float:
    """Get duration of a media file using ffprobe."""
    from cutai.config import ensure_ffprobe

    ffprobe = ensure_ffprobe()
    cmd = [
        ffprobe, "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        file_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
        data = json.loads(result.stdout)
        return float(data.get("format", {}).get("duration", 0))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError, KeyError):
        return 0.0


def _get_audio_duration(file_path: str) -> float:
    """Get duration of an audio file."""
    return _get_duration(file_path)
