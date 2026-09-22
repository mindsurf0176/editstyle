"""Video cutting using FFmpeg.

Applies CutOperations by extracting segments and concatenating them.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from cutai.config import ensure_ffmpeg
from cutai.models.types import CutOperation

logger = logging.getLogger(__name__)


def apply_cuts(
    video_path: str,
    operations: list[CutOperation],
    output_path: str,
    force_reencode: bool = True,
) -> str:
    """Apply cut operations to a video.

    Strategy:
    1. Convert remove operations to keep operations (invert).
    2. Extract each "keep" segment as a temp file.
    3. Concatenate all segments.

    Re-encodes by default so cuts honor the requested times even between
    keyframes. Explicit ``force_reencode=False`` opts into faster, approximate
    stream-copy cuts which can retain content before the requested start.

    Args:
        video_path: Path to the source video.
        operations: List of CutOperations.
        output_path: Path for the output video.
        force_reencode: Re-encode for accurate cuts (default True).

    Returns:
        Path to the output video.
    """
    ffmpeg = ensure_ffmpeg()

    if not operations:
        logger.info("No cut operations — copying input to output")
        _copy_video(ffmpeg, video_path, output_path)
        return output_path

    # Get video duration
    duration = _get_duration(video_path)
    if duration <= 0.0:
        raise RuntimeError(
            f"Failed to determine video duration for '{video_path}'. "
            "FFprobe returned 0.0 — the file may be corrupt or unsupported."
        )

    # Compute keep ranges by inverting remove ranges
    keep_ranges = _compute_keep_ranges(operations, duration)

    if not keep_ranges:
        logger.warning("All content would be removed! Keeping original.")
        _copy_video(ffmpeg, video_path, output_path)
        return output_path

    logger.info("Extracting %d segments...", len(keep_ranges))

    with tempfile.TemporaryDirectory(prefix="cutai_cut_") as tmpdir:
        segment_files: list[str] = []

        for i, (start, end) in enumerate(keep_ranges):
            seg_path = str(Path(tmpdir) / f"seg_{i:04d}.mp4")
            _extract_segment(ffmpeg, video_path, start, end, seg_path, stream_copy=not force_reencode)
            segment_files.append(seg_path)

        if len(segment_files) == 1:
            # Just copy/remux the single segment
            _copy_video(ffmpeg, segment_files[0], output_path)
        else:
            # Concatenate all segments
            _concat_segments(ffmpeg, segment_files, output_path, tmpdir)

    logger.info("Cut complete → %s", output_path)
    return output_path


def _compute_keep_ranges(
    operations: list[CutOperation],
    total_duration: float,
) -> list[tuple[float, float]]:
    """Convert cut operations into a list of (start, end) ranges to keep.

    Handles both 'keep' and 'remove' actions.
    """
    # Separate keep and remove operations
    keeps = [(op.start_time, op.end_time) for op in operations if op.action == "keep"]
    removes = [(op.start_time, op.end_time) for op in operations if op.action == "remove"]

    if keeps and not removes:
        # Explicit keep ranges
        keeps.sort()
        return _merge_ranges(keeps)

    if removes:
        # Invert remove ranges to get keep ranges
        removes.sort()
        merged_removes = _merge_ranges(removes)
        return _invert_ranges(merged_removes, total_duration)

    return [(0.0, total_duration)]


def _merge_ranges(ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Merge overlapping time ranges."""
    if not ranges:
        return []
    merged: list[tuple[float, float]] = [ranges[0]]
    for start, end in ranges[1:]:
        if start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _invert_ranges(
    removes: list[tuple[float, float]],
    total_duration: float,
) -> list[tuple[float, float]]:
    """Given a list of remove ranges, return the complementary keep ranges."""
    keeps: list[tuple[float, float]] = []
    cursor = 0.0

    for start, end in removes:
        if cursor < start:
            keeps.append((cursor, start))
        cursor = end

    if cursor < total_duration:
        keeps.append((cursor, total_duration))

    return keeps


def _extract_segment(
    ffmpeg: str,
    video_path: str,
    start: float,
    end: float,
    output_path: str,
    stream_copy: bool = False,
) -> None:
    """Extract a single segment from the video.

    Args:
        stream_copy: If True, use approximate ``-c copy`` extraction.
            The default False re-encodes to honor the requested start and end.
    """
    duration = end - start
    cmd = [
        ffmpeg,
        "-y",
        "-ss", f"{start:.3f}",
        "-i", video_path,
        "-t", f"{duration:.3f}",
    ]
    if stream_copy:
        cmd += ["-c", "copy"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac"]
    cmd += ["-avoid_negative_ts", "make_zero", output_path]

    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=300)
    except subprocess.CalledProcessError as exc:
        logger.error("Failed to extract segment [%.1f-%.1f]: %s", start, end, exc.stderr)
        raise


def _concat_segments(
    ffmpeg: str,
    segment_files: list[str],
    output_path: str,
    tmpdir: str,
) -> None:
    """Concatenate multiple video segments using FFmpeg concat demuxer."""
    list_path = str(Path(tmpdir) / "concat_list.txt")
    with open(list_path, "w") as f:
        for seg in segment_files:
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
        logger.error("Concat failed: %s", exc.stderr)
        raise


def _copy_video(ffmpeg: str, src: str, dst: str) -> None:
    """Copy/remux a video file."""
    cmd = [ffmpeg, "-y", "-i", src, "-c", "copy", dst]
    subprocess.run(cmd, capture_output=True, check=True, timeout=300)


def _get_duration(video_path: str) -> float:
    """Get video duration using FFprobe."""
    from cutai.config import ensure_ffprobe

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
