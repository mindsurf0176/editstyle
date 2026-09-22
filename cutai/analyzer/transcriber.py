"""Audio transcription with automatic backend selection.

Backend priority (highest first):
1. **mlx-whisper** — Apple Silicon native, 3-5x faster (macOS arm64)
2. **faster-whisper** — CTranslate2, 4-8x faster than openai-whisper on CPU
3. **openai-whisper** — original, slowest

Falls through automatically if a backend is not installed.
"""

from __future__ import annotations

import logging
import platform

from cutai.models.types import TranscriptSegment

logger = logging.getLogger(__name__)

VALID_MODELS = ("tiny", "base", "small", "medium", "large")

# ── Backend detection ────────────────────────────────────────────────────────

_BACKEND: str = "none"

# 1. Try mlx-whisper (Apple Silicon only)
_MLX_AVAILABLE = False
if platform.system() == "Darwin" and platform.machine() == "arm64":
    try:
        import mlx_whisper as _mlx_whisper_mod  # type: ignore[import-untyped]
        _MLX_AVAILABLE = True
        _BACKEND = "mlx-whisper"
    except ImportError:
        _mlx_whisper_mod = None  # type: ignore[assignment]

# 2. Try faster-whisper
_FASTER_AVAILABLE = False
if _BACKEND == "none":
    try:
        from faster_whisper import WhisperModel as _FasterWhisperModel
        _FASTER_AVAILABLE = True
        _BACKEND = "faster-whisper"
    except ImportError:
        _FasterWhisperModel = None  # type: ignore[assignment, misc]

# 3. openai-whisper is the final fallback (checked at call time)
if _BACKEND == "none":
    _BACKEND = "openai-whisper"


def transcribe(
    video_path: str,
    model_name: str = "base",
    language: str | None = None,
) -> list[TranscriptSegment]:
    """Transcribe audio from a video file.

    Automatically selects the fastest available backend:
    mlx-whisper > faster-whisper > openai-whisper.

    Args:
        video_path: Path to the video (or audio) file.
        model_name: Whisper model size (tiny/base/small/medium/large).
        language: Force a specific language, or None for auto-detection.

    Returns:
        List of TranscriptSegment with start/end times, text, and confidence.
    """
    if model_name not in VALID_MODELS:
        logger.warning(
            "Unknown Whisper model '%s', falling back to 'base'", model_name
        )
        model_name = "base"

    logger.info("Transcription backend: %s", _BACKEND)

    if _MLX_AVAILABLE:
        return _transcribe_mlx_whisper(video_path, model_name, language)
    elif _FASTER_AVAILABLE:
        return _transcribe_faster_whisper(video_path, model_name, language)
    else:
        logger.info("No accelerated backend found, using openai-whisper (slower)")
        return _transcribe_openai_whisper(video_path, model_name, language)


def _transcribe_mlx_whisper(
    video_path: str,
    model_name: str,
    language: str | None,
) -> list[TranscriptSegment]:
    """Transcribe using mlx-whisper (Apple Silicon native, 3-5x faster)."""
    logger.info("Loading mlx-whisper model '%s' (Apple Silicon accelerated)...", model_name)

    # mlx-whisper uses HuggingFace model names
    model_map = {
        "tiny": "mlx-community/whisper-tiny",
        "base": "mlx-community/whisper-base",
        "small": "mlx-community/whisper-small",
        "medium": "mlx-community/whisper-medium",
        "large": "mlx-community/whisper-large-v3",
    }
    hf_model = model_map.get(model_name, f"mlx-community/whisper-{model_name}")

    logger.info("Transcribing %s with mlx-whisper...", video_path)
    kwargs: dict = {"path_or_hf_repo": hf_model}
    if language:
        kwargs["language"] = language

    result = _mlx_whisper_mod.transcribe(video_path, **kwargs)  # type: ignore[union-attr]

    segments: list[TranscriptSegment] = []
    for seg in result.get("segments", []):
        raw_logprob = float(seg.get("avg_logprob", -1.0))
        confidence = max(0.0, min(1.0, 1.0 + raw_logprob))
        segments.append(
            TranscriptSegment(
                start_time=round(float(seg["start"]), 3),
                end_time=round(float(seg["end"]), 3),
                text=seg["text"].strip(),
                confidence=round(confidence, 4),
            )
        )

    logger.info(
        "mlx-whisper: transcribed %d segments (language=%s)",
        len(segments),
        result.get("language", "auto"),
    )
    return segments


def _transcribe_faster_whisper(
    video_path: str,
    model_name: str,
    language: str | None,
) -> list[TranscriptSegment]:
    """Transcribe using faster-whisper (CTranslate2, 4-8x faster on CPU)."""
    logger.info("Loading faster-whisper model '%s'...", model_name)

    # Use int8 quantization on CPU for speed; float16 if CUDA is available
    model = _FasterWhisperModel(model_name, device="cpu", compute_type="int8")

    logger.info("Transcribing %s with faster-whisper...", video_path)
    kwargs: dict = {"beam_size": 5, "vad_filter": True}
    if language:
        kwargs["language"] = language

    raw_segments, info = model.transcribe(video_path, **kwargs)

    segments: list[TranscriptSegment] = []
    for seg in raw_segments:
        # faster-whisper provides avg_logprob directly
        raw_logprob = float(seg.avg_logprob) if seg.avg_logprob else -1.0
        confidence = max(0.0, min(1.0, 1.0 + raw_logprob))
        segments.append(
            TranscriptSegment(
                start_time=round(float(seg.start), 3),
                end_time=round(float(seg.end), 3),
                text=seg.text.strip(),
                confidence=round(confidence, 4),
            )
        )

    logger.info(
        "Transcribed %d segments (language=%s, prob=%.2f)",
        len(segments),
        info.language,
        info.language_probability,
    )
    return segments


def _transcribe_openai_whisper(
    video_path: str,
    model_name: str,
    language: str | None,
) -> list[TranscriptSegment]:
    """Transcribe using openai-whisper (original, slower)."""
    logger.info("Loading Whisper model '%s'...", model_name)

    try:
        import whisper
    except ImportError as exc:
        raise RuntimeError(
            "Audio transcription is not installed. Install the cutai-transcription extra "
            "(uv sync --extra cutai --extra cutai-transcription), or analyze without "
            "transcription (--no-transcript / skip_transcription=true)."
        ) from exc

    model = whisper.load_model(model_name)

    logger.info("Transcribing %s...", video_path)
    options: dict = {"verbose": False}
    if language:
        options["language"] = language

    result = model.transcribe(video_path, **options)

    segments: list[TranscriptSegment] = []
    for seg in result.get("segments", []):
        # Convert log probability to approximate confidence (0-1)
        raw_logprob = float(seg.get("avg_logprob", -1.0))
        confidence = max(0.0, min(1.0, 1.0 + raw_logprob))
        segments.append(
            TranscriptSegment(
                start_time=round(float(seg["start"]), 3),
                end_time=round(float(seg["end"]), 3),
                text=seg["text"].strip(),
                confidence=round(confidence, 4),
            )
        )

    logger.info("Transcribed %d segments", len(segments))
    return segments
