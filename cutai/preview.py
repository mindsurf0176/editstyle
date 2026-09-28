"""CutAI Preview — Low-resolution preview renderer.

Generates fast preview videos by downscaling the source before applying edits.
This is typically 5-10× faster than rendering at full resolution.

Example:
    from cutai.preview import render_preview
    path = render_preview("video.mp4", plan, analysis, resolution=360)
"""

from __future__ import annotations

import hashlib
import logging
import subprocess
import tempfile
from pathlib import Path

from cutai.config import ensure_ffmpeg
from cutai.models.types import EditPlan, VideoAnalysis

logger = logging.getLogger(__name__)


def render_preview(
    video_path: str,
    plan: EditPlan,
    analysis: VideoAnalysis,
    output_path: str | None = None,
    resolution: int = 360,
) -> str:
    """Render a low-resolution preview of the edit plan.

    Creates a fast preview by:
    1. First downscaling the source video to {resolution}p
    2. Then applying the edit plan to the downscaled video

    This is much faster than rendering at full resolution.

    Args:
        video_path: Path to the source video.
        plan: Edit plan to preview.
        analysis: Video analysis data.
        output_path: Output path. Defaults to /tmp/cutai_preview_{hash}.mp4
        resolution: Target height in pixels (default 360).

    Returns:
        Path to the preview video.

    Raises:
        FileNotFoundError: If the source video doesn't exist.
        subprocess.CalledProcessError: If ffmpeg downscaling fails.
    """
    source = Path(video_path)
    if not source.exists():
        raise FileNotFoundError(f"Source video not found: {video_path}")

    # Generate deterministic output path if not provided
    if output_path is None:
        plan_hash = hashlib.md5(
            f"{video_path}:{resolution}:{len(plan.operations)}".encode()
        ).hexdigest()[:8]
        output_path = f"/tmp/cutai_preview_{plan_hash}.mp4"

    from cutai.editor.cutter import _get_duration, _validate_output_path
    from cutai.editor.renderer import render, validate_render_plan

    _validate_output_path(video_path, output_path)
    validate_render_plan(plan, analysis)
    # Validate the original media boundary before transcoding. AAC padding and
    # frame time bases can change the proxy duration without changing source time.
    source_duration = _get_duration(video_path)
    source_analysis = analysis.model_copy(update={"duration": source_duration})
    validate_render_plan(plan, source_analysis)

    logger.info(
        "Generating preview: %s → %dp → %s",
        source.name,
        resolution,
        output_path,
    )

    with tempfile.TemporaryDirectory(prefix="cutai_preview_") as tmpdir:
        # Step 1: Downscale the source video
        proxy_path = str(Path(tmpdir) / "proxy.mp4")
        _downscale_video(video_path, proxy_path, resolution)

        # Step 2: Create a scaled analysis for the proxy
        proxy_analysis = _create_proxy_analysis(source_analysis, resolution)

        # Step 3: Apply the edit plan to the proxy
        if plan.operations:
            result = render(
                proxy_path,
                plan,
                proxy_analysis,
                output_path,
                source_duration=source_duration,
            )
            return result
        else:
            # No operations — just copy the downscaled video as the preview
            import shutil

            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(proxy_path, output_path)
            logger.info("Preview (downscale only, no edits): %s", output_path)
            return output_path


def _downscale_video(
    input_path: str,
    output_path: str,
    resolution: int,
    timeout: int = 600,
) -> None:
    """Downscale a video to the target resolution using ffmpeg.

    Uses ultrafast preset and high CRF for maximum speed.
    The -2 in scale filter ensures width is divisible by 2.

    Args:
        input_path: Path to the source video.
        output_path: Path for the downscaled proxy.
        resolution: Target height in pixels.
        timeout: Maximum time for the ffmpeg process in seconds.
    """
    ffmpeg = ensure_ffmpeg()

    cmd = [
        ffmpeg,
        "-y",
        "-i", input_path,
        "-vf", f"scale=-2:{resolution}",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-c:a", "aac",
        "-b:a", "64k",
        output_path,
    ]

    logger.info("Downscaling to %dp: %s", resolution, " ".join(cmd))

    result = subprocess.run(
        cmd,
        capture_output=True,
        check=True,
        timeout=timeout,
    )

    logger.debug("ffmpeg stderr: %s", result.stderr.decode()[-500:] if result.stderr else "")
    logger.info("Downscaled proxy created: %s", output_path)


def _create_proxy_analysis(
    analysis: VideoAnalysis,
    resolution: int,
) -> VideoAnalysis:
    """Create a modified VideoAnalysis with scaled dimensions for the proxy video.

    Preserves all timing data (scenes, transcript, quality) since only
    spatial dimensions change.

    Args:
        analysis: Original video analysis.
        resolution: Target height in pixels.

    Returns:
        New VideoAnalysis with adjusted width/height.
    """
    scale_factor = 1.0 if analysis.height <= 0 else resolution / analysis.height

    new_width = int(analysis.width * scale_factor)
    # Ensure width is even (required by many codecs)
    if new_width % 2 != 0:
        new_width += 1

    return VideoAnalysis(
        file_path=analysis.file_path,
        duration=analysis.duration,
        fps=analysis.fps,
        width=new_width,
        height=resolution,
        scenes=analysis.scenes,
        transcript=analysis.transcript,
        quality=analysis.quality,
    )
