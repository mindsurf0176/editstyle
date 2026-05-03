"""Speed adjustment using FFmpeg.

Applies SpeedOperation by changing the playback rate of video and audio
using setpts and atempo filters.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from cutai.config import ensure_ffmpeg, ensure_ffprobe
from cutai.models.types import SpeedOperation

logger = logging.getLogger(__name__)


def apply_speed(
    video_path: str,
    operation: SpeedOperation,
    output_path: str,
) -> str:
    """Apply speed adjustment to a video.

    For whole-video speed changes (start_time=0 and end_time >= duration),
    applies the filter to the entire video. For partial speed changes,
    splits the video into segments, adjusts speed on the target segment,
    and concatenates.

    Args:
        video_path: Path to the source video.
        operation: SpeedOperation with factor, start_time, end_time.
        output_path: Path for the output video.

    Returns:
        Path to the speed-adjusted output video.
    """
    factor = operation.factor

    if abs(factor - 1.0) < 0.01:
        logger.info("Speed factor ≈ 1.0 — no change needed.")
        import shutil
        shutil.copy2(video_path, output_path)
        return output_path

    if factor <= 0:
        logger.warning("Invalid speed factor %.2f. Skipping.", factor)
        import shutil
        shutil.copy2(video_path, output_path)
        return output_path

    video_duration = _get_duration(video_path)
    if video_duration <= 0:
        logger.warning("Could not determine video duration. Skipping speed adjustment.")
        import shutil
        shutil.copy2(video_path, output_path)
        return output_path

    if operation.end_time - operation.start_time < 0.05:
        logger.warning("Speed region too short (%.1f-%.1f). Skipping.", operation.start_time, operation.end_time)
        import shutil
        shutil.copy2(video_path, output_path)
        return output_path

    # Determine if this is a whole-video or partial speed change
    is_whole_video = (
        operation.start_time <= 0.05
        and operation.end_time >= video_duration - 0.05
    )

    if is_whole_video:
        return _apply_speed_whole(video_path, factor, output_path)
    else:
        return _apply_speed_partial(
            video_path, factor, operation.start_time, operation.end_time,
            video_duration, output_path,
        )


def _apply_speed_whole(
    video_path: str,
    factor: float,
    output_path: str,
) -> str:
    """Apply speed change to the entire video.

    Args:
        video_path: Path to the source video.
        factor: Speed multiplier (>1 = faster, <1 = slower).
        output_path: Path for the output.

    Returns:
        Path to the output video.
    """
    ffmpeg = ensure_ffmpeg()

    # Video: setpts scales presentation timestamps
    pts_factor = 1.0 / factor
    vf = f"setpts={pts_factor:.6f}*PTS"

    # Audio: atempo (supports 0.5-2.0 range, chain for extremes)
    af = _build_atempo_chain(factor)

    cmd = [
        ffmpeg,
        "-y",
        "-i", video_path,
        "-filter:v", vf,
        "-filter:a", af,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "18",
        output_path,
    ]

    logger.info("Applying speed ×%.2f to entire video", factor)

    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=600)
    except subprocess.CalledProcessError as exc:
        error_msg = exc.stderr.decode() if isinstance(exc.stderr, bytes) else str(exc.stderr)
        logger.error("Speed adjustment failed: %s", error_msg)
        raise RuntimeError(f"Failed to apply speed change: {error_msg}") from exc

    logger.info("Speed adjusted → %s", output_path)
    return output_path


def _apply_speed_partial(
    video_path: str,
    factor: float,
    start_time: float,
    end_time: float,
    video_duration: float,
    output_path: str,
) -> str:
    """Apply speed change to a portion of the video.

    Splits into up to 3 segments: before, speed-changed, after.
    Then concatenates them.

    Args:
        video_path: Path to the source video.
        factor: Speed multiplier.
        start_time: Start of the speed-change region (seconds).
        end_time: End of the speed-change region (seconds).
        video_duration: Total video duration.
        output_path: Path for the output.

    Returns:
        Path to the output video.
    """
    ffmpeg = ensure_ffmpeg()

    with tempfile.TemporaryDirectory(prefix="cutai_speed_") as tmpdir:
        segments: list[str] = []

        # Part 1: Before the speed-change region
        if start_time > 0.05:
            before_path = str(Path(tmpdir) / "before.mp4")
            _extract_segment(ffmpeg, video_path, 0, start_time, before_path)
            segments.append(before_path)

        # Part 2: Speed-changed segment
        middle_raw = str(Path(tmpdir) / "middle_raw.mp4")
        _extract_segment(ffmpeg, video_path, start_time, end_time, middle_raw)

        middle_fast = str(Path(tmpdir) / "middle_fast.mp4")
        _apply_speed_whole(middle_raw, factor, middle_fast)
        segments.append(middle_fast)

        # Part 3: After the speed-change region
        if end_time < video_duration - 0.05:
            after_path = str(Path(tmpdir) / "after.mp4")
            _extract_segment(ffmpeg, video_path, end_time, video_duration, after_path)
            segments.append(after_path)

        if len(segments) == 1:
            import shutil
            shutil.copy2(segments[0], output_path)
        else:
            _concat_segments(ffmpeg, segments, output_path, tmpdir)

    logger.info("Partial speed adjusted → %s", output_path)
    return output_path


def _build_atempo_chain(factor: float) -> str:
    """Build a chain of atempo filters for the given speed factor.

    FFmpeg's atempo only supports the range [0.5, 2.0]. For values
    outside this range, chain multiple atempo filters.

    Examples:
        factor=4.0 → "atempo=2.0,atempo=2.0"
        factor=0.25 → "atempo=0.5,atempo=0.5"
        factor=1.5 → "atempo=1.5"

    Args:
        factor: Speed multiplier.

    Returns:
        FFmpeg audio filter string.
    """
    if 0.5 <= factor <= 2.0:
        return f"atempo={factor}"

    parts: list[str] = []
    remaining = factor

    if factor > 2.0:
        while remaining > 2.0 + 1e-9:
            parts.append("atempo=2.0")
            remaining /= 2.0
        if abs(remaining - 1.0) > 0.01:
            parts.append(f"atempo={remaining}")
    else:  # factor < 0.5
        while remaining < 0.5 - 1e-9:
            parts.append("atempo=0.5")
            remaining *= 2.0
        if abs(remaining - 1.0) > 0.01:
            parts.append(f"atempo={remaining}")

    return ",".join(parts) if parts else "atempo=1.0"


def _extract_segment(
    ffmpeg: str,
    video_path: str,
    start: float,
    end: float,
    output_path: str,
) -> None:
    """Extract a segment from the video with re-encoding for clean cuts."""
    duration = end - start
    cmd = [
        ffmpeg,
        "-y",
        "-ss", f"{start:.3f}",
        "-i", video_path,
        "-t", f"{duration:.3f}",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "18",
        "-c:a", "aac",
        "-avoid_negative_ts", "make_zero",
        output_path,
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=300)
    except subprocess.CalledProcessError as exc:
        error_msg = exc.stderr.decode() if isinstance(exc.stderr, bytes) else str(exc.stderr)
        logger.error("Segment extraction [%.1f-%.1f] failed: %s", start, end, error_msg)
        raise


def _concat_segments(
    ffmpeg: str,
    segments: list[str],
    output_path: str,
    tmpdir: str,
) -> None:
    """Concatenate multiple video segments."""
    list_path = str(Path(tmpdir) / "concat_list.txt")
    with open(list_path, "w") as f:
        for seg in segments:
            f.write(f"file '{seg}'\n")

    cmd = [
        ffmpeg,
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", list_path,
        "-c", "copy",
        output_path,
    ]

    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=600)
    except subprocess.CalledProcessError as exc:
        error_msg = exc.stderr.decode() if isinstance(exc.stderr, bytes) else str(exc.stderr)
        logger.error("Concat failed: %s", error_msg)
        raise


def _get_duration(video_path: str) -> float:
    """Get media file duration using FFprobe."""
    ffprobe = ensure_ffprobe()
    cmd = [
        ffprobe,
        "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0
