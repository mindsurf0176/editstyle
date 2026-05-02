"""Edge TTS engine for CutAI narrator.

Uses Microsoft Edge TTS (free, no API key) to generate natural-sounding
speech from narration text. Supports multiple languages and voice styles.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

VOICE_MAP: dict[str, dict[str, str]] = {
    "en": {"default": "en-US-GuyNeural", "male": "en-US-GuyNeural", "female": "en-US-AriaNeural", "documentary": "en-US-DavisNeural"},
    "ja": {"default": "ja-JP-NanamiNeural", "male": "ja-JP-KeitaNeural", "female": "ja-JP-NanamiNeural"},
    "ko": {"default": "ko-KR-SunHiNeural", "male": "ko-KR-InJoonNeural", "female": "ko-KR-SunHiNeural"},
    "zh": {"default": "zh-CN-YunxiNeural", "male": "zh-CN-YunxiNeural", "female": "zh-CN-XiaoxiaoNeural"},
    "es": {"default": "es-ES-AlvaroNeural", "male": "es-ES-AlvaroNeural", "female": "es-ES-ElviraNeural"},
    "fr": {"default": "fr-FR-HenriNeural", "male": "fr-FR-HenriNeural", "female": "fr-FR-DeniseNeural"},
    "de": {"default": "de-DE-ConradNeural", "male": "de-DE-ConradNeural", "female": "de-DE-KatjaNeural"},
    "pt": {"default": "pt-BR-AntonioNeural", "male": "pt-BR-AntonioNeural", "female": "pt-BR-FranciscaNeural"},
    "ar": {"default": "ar-SA-HamedNeural", "male": "ar-SA-HamedNeural", "female": "ar-SA-LailaNeural"},
    "hi": {"default": "hi-IN-MadhurNeural", "male": "hi-IN-MadhurNeural", "female": "hi-IN-SwaraNeural"},
    "ru": {"default": "ru-RU-DmitryNeural", "male": "ru-RU-DmitryNeural", "female": "ru-RU-SvetlanaNeural"},
}

TONE_RATE_MAP: dict[str, str] = {
    "documentary": "-5%",
    "calm": "-10%",
    "excited": "+15%",
    "sad": "-15%",
    "happy": "+10%",
    "serious": "-5%",
    "funny": "+5%",
    "teacher": "0%",
}

TONE_VOLUME_MAP: dict[str, str] = {
    "documentary": "-5%",
    "calm": "-10%",
    "excited": "+10%",
    "sad": "-15%",
    "happy": "+5%",
    "serious": "0%",
    "funny": "+5%",
    "teacher": "0%",
}


def _detect_language(text: str) -> str:
    """Simple language detection based on character ranges."""
    if any("\u3040" <= c <= "\u30ff" for c in text):
        return "ja"
    if any("\u4e00" <= c <= "\u9fff" for c in text):
        return "zh"
    if any("\uac00" <= c <= "\ud7af" for c in text):
        return "ko"
    if any("\u0600" <= c <= "\u06ff" for c in text):
        return "ar"
    if any("\u0900" <= c <= "\u097f" for c in text):
        return "hi"
    if any("\u0400" <= c <= "\u04ff" for c in text):
        return "ru"
    if any("\u00e1" <= c <= "\u00fc" for c in text) or any("\u00c0" <= c <= "\u00ff" for c in text):
        return "es"
    return "en"


def get_voice(language: str = "auto", gender: str = "default", tone: str = "documentary") -> str:
    """Select the best Edge TTS voice for the given parameters.

    Args:
        language: Language code (auto-detect from text if "auto").
        gender: "male", "female", or "default".
        tone: Tone preset name.

    Returns:
        Edge TTS voice short name.
    """
    lang = language if language != "auto" else "en"
    lang_config = VOICE_MAP.get(lang, VOICE_MAP["en"])

    if tone in lang_config:
        return lang_config[tone]
    if gender in lang_config:
        return lang_config[gender]
    return lang_config["default"]


def get_tts_params(tone: str) -> dict[str, str]:
    """Get TTS rate and volume adjustments for a tone preset.

    Args:
        tone: Tone preset name.

    Returns:
        Dict with "rate" and "volume" keys for edge-tts.
    """
    return {
        "rate": TONE_RATE_MAP.get(tone, "0%"),
        "volume": TONE_VOLUME_MAP.get(tone, "0%"),
    }


async def generate_speech(
    text: str,
    output_path: str,
    voice: str | None = None,
    language: str = "auto",
    gender: str = "default",
    tone: str = "documentary",
) -> str:
    """Generate speech audio from text using Edge TTS.

    Args:
        text: Text to convert to speech.
        output_path: Path for the output audio file (.mp3).
        voice: Explicit voice name (overrides auto-detection).
        language: Language code or "auto" to detect from text.
        gender: Voice gender preference.
        tone: Tone preset for rate/volume adjustment.

    Returns:
        Path to the generated audio file.
    """
    import edge_tts

    if voice is None:
        detected_lang = _detect_language(text) if language == "auto" else language
        voice = get_voice(detected_lang, gender, tone)

    params = get_tts_params(tone)

    logger.info("Generating speech: voice=%s, rate=%s, volume=%s, text=%.50s", voice, params["rate"], params["volume"], text)

    communicate = edge_tts.Communicate(text, voice, rate=params["rate"], volume=params["volume"])
    await communicate.save(output_path)

    return output_path


def generate_speech_sync(
    text: str,
    output_path: str,
    voice: str | None = None,
    language: str = "auto",
    gender: str = "default",
    tone: str = "documentary",
) -> str:
    """Synchronous wrapper for generate_speech."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(
            generate_speech(text, output_path, voice, language, gender, tone)
        )
    finally:
        loop.close()


async def generate_speech_segments(
    segments: list[dict[str, Any]],
    output_dir: str,
    voice: str | None = None,
    tone: str = "documentary",
) -> list[dict[str, str]]:
    """Generate speech audio for multiple narration segments.

    Args:
        segments: List of dicts with "text" and "id" keys.
        output_dir: Directory to save audio files.
        voice: Explicit voice name.
        tone: Tone preset.

    Returns:
        List of dicts with "id", "text", and "audio_path" keys.
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    results = []

    for seg in segments:
        if not seg.get("text", "").strip():
            continue

        audio_path = str(Path(output_dir) / f"narration_{seg['id']:03d}.mp3")
        try:
            await generate_speech(
                text=seg["text"],
                output_path=audio_path,
                voice=voice,
                tone=tone,
            )
            results.append({
                "id": seg["id"],
                "text": seg["text"],
                "audio_path": audio_path,
            })
        except Exception as e:
            logger.warning("Failed to generate speech for segment %d: %s", seg["id"], e)

    return results


async def list_voices(language: str | None = None) -> list[dict[str, str]]:
    """List available Edge TTS voices.

    Args:
        language: Optional language filter (e.g. "en", "ja").

    Returns:
        List of voice info dicts.
    """
    import edge_tts

    voices = await edge_tts.list_voices()
    result = []
    for v in voices:
        if language and not v["Locale"].startswith(language):
            continue
        result.append({
            "name": v["ShortName"],
            "locale": v["Locale"],
            "gender": v["Gender"],
        })
    return result
