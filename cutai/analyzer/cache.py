"""Analysis result caching — avoid re-analyzing the same video.

Cache key is based on file path + file size + modification time.
Cache is stored in ``.cutai-cache/`` next to the video or in a global
directory at ``~/.cutai/cache/``.

Usage:
    from cutai.analyzer.cache import get_cached, save_cache

    cached = get_cached(video_path, whisper_model="base")
    if cached:
        return cached  # Skip analysis

    analysis = analyze_video(video_path, ...)
    save_cache(video_path, analysis, whisper_model="base")
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path

from cutai.models.types import VideoAnalysis

logger = logging.getLogger(__name__)

CACHE_DIR_NAME = ".cutai-cache"
GLOBAL_CACHE_DIR = Path.home() / ".cutai" / "cache"


def _cache_key(
    video_path: str, whisper_model: str = "base", skip_transcription: bool = False
) -> str:
    """Generate a stable cache key from file metadata.

    Uses path + file size + mtime + transcription settings to avoid
    stale cache hits when the file changes.
    """
    p = Path(video_path).resolve()
    stat = p.stat()
    raw = f"{p}:{stat.st_size}:{stat.st_mtime_ns}:{whisper_model}:{skip_transcription}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _cache_dir(video_path: str) -> Path:
    """Get the cache directory — local (.cutai-cache/) or global."""
    local = Path(video_path).resolve().parent / CACHE_DIR_NAME
    if local.exists() or _can_create(local):
        local.mkdir(parents=True, exist_ok=True)
        return local
    # Fall back to global cache
    GLOBAL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return GLOBAL_CACHE_DIR


def _can_create(path: Path) -> bool:
    """Check if we can create a directory at this path."""
    try:
        path.mkdir(parents=True, exist_ok=True)
        return True
    except OSError:
        return False


def get_cached(
    video_path: str,
    whisper_model: str = "base",
    skip_transcription: bool = False,
) -> VideoAnalysis | None:
    """Look up a cached analysis result.

    Args:
        video_path: Path to the video file.
        whisper_model: Whisper model used (affects cache key).
        skip_transcription: Whether transcription was disabled (affects cache key).

    Returns:
        VideoAnalysis if a valid cache entry exists, None otherwise.
    """
    try:
        key = _cache_key(video_path, whisper_model, skip_transcription)
        cache_file = _cache_dir(video_path) / f"{key}.json"

        if not cache_file.exists():
            return None

        data = json.loads(cache_file.read_text(encoding="utf-8"))
        analysis = VideoAnalysis.model_validate(data)
        logger.info("Cache hit for %s (key=%s)", Path(video_path).name, key)
        return analysis
    except Exception as exc:
        logger.debug("Cache miss (error): %s", exc)
        return None


def save_cache(
    video_path: str,
    analysis: VideoAnalysis,
    whisper_model: str = "base",
    skip_transcription: bool = False,
) -> None:
    """Save an analysis result to the cache.

    Args:
        video_path: Path to the video file.
        analysis: The analysis to cache.
        whisper_model: Whisper model used (affects cache key).
        skip_transcription: Whether transcription was disabled (affects cache key).
    """
    try:
        key = _cache_key(video_path, whisper_model, skip_transcription)
        cache_file = _cache_dir(video_path) / f"{key}.json"
        cache_file.write_text(
            analysis.model_dump_json(indent=2),
            encoding="utf-8",
        )
        logger.info("Cached analysis for %s (key=%s)", Path(video_path).name, key)
    except Exception as exc:
        logger.warning("Failed to cache analysis: %s", exc)


def clear_cache(video_path: str | None = None) -> int:
    """Clear cached analyses.

    Args:
        video_path: If provided, clear cache for this video's directory only.
            If None, clear the global cache.

    Returns:
        Number of cache entries removed.
    """
    count = 0

    if video_path:
        cache = Path(video_path).resolve().parent / CACHE_DIR_NAME
    else:
        cache = GLOBAL_CACHE_DIR

    if cache.exists():
        for f in cache.glob("*.json"):
            f.unlink()
            count += 1
        logger.info("Cleared %d cache entries from %s", count, cache)

    return count
