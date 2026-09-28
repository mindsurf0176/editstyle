"""Video cutting using FFmpeg.

Applies CutOperations by extracting segments and concatenating them.
"""

from __future__ import annotations

import logging
import math
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
    *,
    source_duration: float | None = None,
) -> str:
    """Apply cut operations to a video.

    Strategy:
    1. Subtract remove ranges from explicit keeps (or the whole source).
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
        source_duration: Original-source duration for a derived preview proxy.
            Only supply after validating the plan against the original media;
            transcoding can change the proxy container's duration through padding.

    Returns:
        Path to the output video.
    """
    _validate_output_path(video_path, output_path)
    duration = _get_duration(video_path) if source_duration is None else source_duration
    keep_ranges = _compute_keep_ranges(operations, duration)
    if not keep_ranges:
        raise ValueError("The cut plan removes the entire video. Keep at least one segment.")

    ffmpeg = ensure_ffmpeg()
    if not operations:
        logger.info("No cut operations — copying input to output")
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


def _validate_output_path(video_path: str, output_path: str) -> None:
    """Protect the source from direct, symlink, or hardlink output aliases."""
    source = Path(video_path)
    output = Path(output_path)
    if source.resolve() == output.resolve() or (
        source.exists() and output.exists() and source.samefile(output)
    ):
        raise ValueError("Output path must not overwrite the source video. Choose a different file.")


def _compute_keep_ranges(
    operations: list[CutOperation],
    total_duration: float,
) -> list[tuple[float, float]]:
    """Validate source times and subtract remove ranges from the union of keeps.

    Without explicit keeps, the base is the entire source. Empty results are
    returned here for callers to inspect; rendering must reject them.
    """
    if not math.isfinite(total_duration) or total_duration <= 0:
        raise ValueError("Source duration must be finite and greater than zero.")
    for op in operations:
        if op.action not in ("keep", "remove"):
            raise ValueError("Cut action must be 'keep' or 'remove'.")
        _validate_source_range(op.start_time, op.end_time, total_duration, "Cut")

    keeps = [(op.start_time, op.end_time) for op in operations if op.action == "keep"]
    removes = [(op.start_time, op.end_time) for op in operations if op.action == "remove"]
    base = _merge_ranges(keeps) if keeps else [(0.0, total_duration)]
    merged_removes = _merge_ranges(removes)
    remaining: list[tuple[float, float]] = []
    for keep_start, keep_end in base:
        cursor = keep_start
        for remove_start, remove_end in merged_removes:
            if remove_end <= cursor:
                continue
            if remove_start >= keep_end:
                break
            if remove_start > cursor:
                remaining.append((cursor, remove_start))
            cursor = max(cursor, remove_end)
            if cursor >= keep_end:
                break
        if cursor < keep_end:
            remaining.append((cursor, keep_end))
    return remaining


def _validate_source_range(start: float, end: float, duration: float, label: str) -> None:
    """Reject invalid source intervals without silently clamping their bounds."""
    if (not math.isfinite(start) or not math.isfinite(end)
            or start < 0 or end <= start or end > duration):
        raise ValueError(
            f"{label} ranges must be finite and satisfy 0 <= start < end <= source duration "
            f"({duration:g} seconds)."
        )


def _merge_ranges(ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Sort and merge overlapping or adjacent time ranges."""
    if not ranges:
        return []
    ranges = sorted(ranges)
    merged: list[tuple[float, float]] = [ranges[0]]
    for start, end in ranges[1:]:
        if start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


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
    """Get the canonical millisecond source boundary used by import and analysis.

    FFprobe can report sub-millisecond container precision. The project/API
    boundary is round(duration, 3), so every original-source cut uses that same
    boundary. This quantizes metadata once; it does not clamp cut intervals.
    """
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
        return round(float(result.stdout.strip()), 3)
    except ValueError:
        return 0.0
