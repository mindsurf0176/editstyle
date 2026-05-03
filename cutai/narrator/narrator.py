"""CutAI Narrator — main orchestrator.

Generates AI voiceover narration for video scenes.
"""

from cutai.narrator.audio_mixer import mix_voiceover, replace_audio
from cutai.narrator.script_generator import generate_narration_script
from cutai.narrator.tts_engine import generate_speech_sync


def generate_narration(
    video_path: str,
    analysis,
    tone: str = "documentary",
    language: str = "English",
    custom_prompt: str | None = None,
    voice: str | None = None,
    audio_mode: str = "voiceover",
    output_path: str = "narrated.mp4",
    llm_model: str = "auto",
    use_llm: bool = True,
    use_vision: bool = False,
    vision_model: str | None = None,
) -> dict:
    """Generate narration for a video and apply it.

    Args:
        video_path: Path to the source video.
        analysis: VideoAnalysis object.
        tone: Tone preset.
        language: Language for narration.
        custom_prompt: Custom tone instruction.
        voice: Explicit TTS voice name.
        audio_mode: "voiceover" or "replace".
        output_path: Output video path.
        llm_model: LLM model for script generation.
        use_llm: Whether to use LLM for script generation.
        use_vision: Whether to use vision model for scene understanding.
        vision_model: Vision model name (defaults to gemma4:31b-cloud).

    Returns:
        Dict with "output_path", "narrations_count", "segments" info.
    """
    import logging
    import tempfile

    logger = logging.getLogger(__name__)

    vision_descriptions = None
    if use_vision:
        from cutai.narrator.vision_analyzer import analyze_scenes

        logger.info("Running vision analysis on scenes...")
        vision_descriptions = analyze_scenes(
            video_path=video_path,
            analysis=analysis,
            model=vision_model,
        )

    logger.info("Generating narration script (tone=%s, language=%s, vision=%s)...", tone, language, use_vision)

    narrations = generate_narration_script(
        analysis=analysis,
        tone=tone,
        language=language,
        custom_prompt=custom_prompt,
        llm_model=llm_model,
        use_llm=use_llm,
        vision_descriptions=vision_descriptions,
    )

    narrations = [n for n in narrations if n.get("text", "").strip()]

    if not narrations:
        logger.warning("No narration text generated — skipping TTS")
        return {"output_path": video_path, "narrations_count": 0, "segments": []}

    logger.info("Generated %d narration segments", len(narrations))

    with tempfile.TemporaryDirectory(prefix="cutai_narration_") as tmpdir:
        segments = []
        for narration in narrations:
            scene_id = narration["id"]
            scene = analysis.scenes[scene_id] if scene_id < len(analysis.scenes) else None

            audio_path = f"{tmpdir}/narration_{scene_id}.mp3"
            try:
                generate_speech_sync(
                    text=narration["text"],
                    output_path=audio_path,
                    voice=voice,
                    tone=tone,
                )
                segments.append({
                    "id": scene_id,
                    "audio_path": audio_path,
                    "start_time": scene.start_time if scene else 0.0,
                    "text": narration["text"],
                })
                logger.info("  Scene %d: TTS generated (%.30s)", scene_id, narration["text"])
            except Exception as e:
                logger.warning("  Scene %d: TTS failed: %s", scene_id, e)

        if not segments:
            logger.warning("No TTS audio generated — returning original video")
            return {"output_path": video_path, "narrations_count": 0, "segments": []}

        if audio_mode == "replace":
            result_path = replace_audio(
                video_path=video_path,
                narration_segments=segments,
                output_path=output_path,
            )
        else:
            result_path = mix_voiceover(
                video_path=video_path,
                narration_segments=segments,
                output_path=output_path,
            )

    return {
        "output_path": result_path,
        "narrations_count": len(segments),
        "segments": segments,
    }
