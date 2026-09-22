"""CutAI Analyzer — video analysis orchestrator.

Combines scene detection, transcription, and quality analysis
into a single VideoAnalysis result.
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

from cutai.config import ensure_ffmpeg, ensure_ffprobe
from cutai.config import load_config as load_config
from cutai.models.types import VideoAnalysis

if TYPE_CHECKING:
    from cutai.models.types import EngagementReport

logger = logging.getLogger(__name__)


def _extract_audio_cached(video_path: str, tmpdir: str) -> str:
    """Extract audio once to a temp WAV file for reuse by transcriber + quality analyzer.

    This avoids extracting audio twice (once for transcription, once for quality analysis).
    """
    ffmpeg = ensure_ffmpeg()
    audio_path = os.path.join(tmpdir, "audio_cached.wav")
    cmd = [
        ffmpeg, "-y", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        audio_path,
    ]
    logger.info("Extracting audio track (shared by transcriber + quality analyzer)...")
    subprocess.run(cmd, capture_output=True, check=True, timeout=600)
    logger.info("Shared audio extracted to %s", audio_path)
    return audio_path


def analyze_video(
    video_path: str,
    whisper_model: str = "base",
    thumbnail_dir: str | None = None,
    skip_transcription: bool = False,
) -> VideoAnalysis:
    """Run full analysis pipeline on a video file.

    Args:
        video_path: Path to the video file.
        whisper_model: Whisper model size for transcription.
        thumbnail_dir: Directory to save scene thumbnails.
        skip_transcription: If True, skip Whisper transcription.

    Returns:
        Complete VideoAnalysis with scenes, transcript, and quality data.

    Raises:
        FileNotFoundError: If the video file does not exist.
        ValueError: If the file is not a valid video.
    """
    path = Path(video_path)
    if not path.exists():
        raise FileNotFoundError(f"Video file not found: {video_path}")

    # Check cache first
    from cutai.analyzer.cache import get_cached, save_cache
    cached = get_cached(
        str(path), whisper_model=whisper_model, skip_transcription=skip_transcription
    )
    if cached is not None:
        logger.info("Using cached analysis for %s", path.name)
        return cached

    # Get video metadata
    meta = _get_video_metadata(str(path))

    logger.info(
        "Analyzing video: %s (%.1fs, %dx%d @ %.1ffps)",
        path.name,
        meta["duration"],
        meta["width"],
        meta["height"],
        meta["fps"],
    )

    # 1. Scene detection
    from cutai.analyzer.scene_detector import detect_scenes

    scenes = detect_scenes(str(path), thumbnail_dir=thumbnail_dir)
    logger.info("Scene detection complete: %d scenes", len(scenes))

    # 2 & 3. Extract audio ONCE for both transcription and quality analysis
    with tempfile.TemporaryDirectory(prefix="cutai_audio_shared_") as audio_tmpdir:
        audio_file: str | None = None
        try:
            audio_file = _extract_audio_cached(str(path), audio_tmpdir)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            logger.warning("Shared audio extraction failed (%s), modules will extract individually", exc)

        # 2. Transcription (optional — can be slow)
        transcript = []
        if not skip_transcription:
            from cutai.analyzer.transcriber import transcribe

            # Use cached audio if available, otherwise transcriber will handle the video directly
            transcribe_input = audio_file if audio_file else str(path)
            transcript = transcribe(transcribe_input, model_name=whisper_model)
            logger.info("Transcription complete: %d segments", len(transcript))

            # Annotate scenes with speech info
            for scene in scenes:
                scene_segments = [
                    seg
                    for seg in transcript
                    if seg.start_time < scene.end_time and seg.end_time > scene.start_time
                ]
                scene.has_speech = len(scene_segments) > 0
                if scene_segments:
                    scene.transcript = " ".join(seg.text for seg in scene_segments)

        # 3. Quality analysis (uses cached audio to skip re-extraction)
        from cutai.analyzer.quality_analyzer import analyze_quality

        logger.info("Starting quality analysis")
        quality = analyze_quality(
            str(path),
            scenes=scenes,
            audio_path=audio_file,
        )
        logger.info(
            "Quality analysis complete: %d silent segments, silence ratio=%.1f%%",
            len(quality.silent_segments),
            quality.overall_silence_ratio * 100,
        )

    # Annotate scenes with silence info
    for i, scene in enumerate(scenes):
        scene.is_silent = _is_scene_silent(scene, quality)
        if i < len(quality.audio_energy):
            scene.avg_energy = quality.audio_energy[i]

    analysis = VideoAnalysis(
        file_path=str(path.resolve()),
        duration=meta["duration"],
        fps=meta["fps"],
        width=meta["width"],
        height=meta["height"],
        scenes=scenes,
        transcript=transcript,
        quality=quality,
    )

    # Save to cache for next time
    save_cache(
        str(path), analysis, whisper_model=whisper_model, skip_transcription=skip_transcription
    )

    return analysis


def _get_video_metadata(video_path: str) -> dict:
    """Extract video metadata using FFprobe."""
    ffprobe = ensure_ffprobe()

    cmd = [
        ffprobe,
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        video_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"Failed to read video metadata: {exc}") from exc

    import json

    data = json.loads(result.stdout)

    # Find video stream
    video_stream = None
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            video_stream = stream
            break

    if video_stream is None:
        raise ValueError(f"No video stream found in {video_path}")

    # Parse FPS from r_frame_rate (e.g., "30000/1001")
    fps_str = video_stream.get("r_frame_rate", "30/1")
    try:
        num, den = fps_str.split("/")
        fps = float(num) / float(den)
    except (ValueError, ZeroDivisionError):
        fps = 30.0

    duration = float(data.get("format", {}).get("duration", 0))

    return {
        "duration": round(duration, 3),
        "fps": round(fps, 2),
        "width": int(video_stream.get("width", 0)),
        "height": int(video_stream.get("height", 0)),
    }


def analyze_with_engagement(
    video_path: str,
    **kwargs,
) -> tuple[VideoAnalysis, EngagementReport]:
    """Run full analysis plus engagement scoring.

    Convenience wrapper that chains ``analyze_video`` with
    ``compute_engagement_scores``.

    Args:
        video_path: Path to the video file.
        **kwargs: Forwarded to ``analyze_video`` (whisper_model, etc.).

    Returns:
        A tuple of (VideoAnalysis, EngagementReport).
    """
    analysis = analyze_video(video_path, **kwargs)

    from cutai.analyzer.engagement import compute_engagement_scores

    engagement = compute_engagement_scores(analysis, video_path)
    return analysis, engagement


def _is_scene_silent(scene, quality) -> bool:
    """Check if a scene overlaps significantly with silent segments."""
    scene_duration = scene.duration
    if scene_duration <= 0:
        return True

    silent_overlap = 0.0
    for seg in quality.silent_segments:
        overlap_start = max(scene.start_time, seg.start)
        overlap_end = min(scene.end_time, seg.end)
        if overlap_end > overlap_start:
            silent_overlap += overlap_end - overlap_start

    # Scene is "silent" if >80% overlaps with silence
    return bool((silent_overlap / scene_duration) > 0.8)
