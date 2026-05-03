"""Narration script generator using LLM.

Analyzes video scenes and generates context-aware narration text
for each scene based on the transcript, visual energy, and position.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from cutai.narrator._json import extract_json as _extract_json

if TYPE_CHECKING:
    from cutai.models.types import SceneInfo, VideoAnalysis

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a professional video narrator. Given scene information from a video, generate a short narration script for each scene.

Rules:
- Each narration should be 1-3 sentences (15-40 words)
- Match the requested tone/style
- Reference what's VISUALLY happening in the scene based on the visual descriptions
- If a scene has transcript, incorporate it naturally with the visual description
- Keep narration natural and engaging — describe what the viewer is seeing
- Use the specified language for narration
- Do NOT add timestamps, labels, or formatting — just the narration text
- Make the narration flow like a story — connect scenes logically"""

TONE_INSTRUCTIONS = {
    "documentary": "Speak in a calm, informative documentary style. Explain what's happening with authority and clarity. Use measured pacing.",
    "calm": "Speak gently and peacefully. Create a soothing, meditative atmosphere. Use soft, descriptive language.",
    "excited": "Speak with high energy and enthusiasm! Use exclamations, rhetorical questions, and vivid language to build excitement.",
    "sad": "Speak with empathy and gentleness. Acknowledge the emotional weight of the scene. Use reflective, contemplative language.",
    "happy": "Speak warmly and positively. Highlight the good things happening. Use uplifting language.",
    "serious": "Speak with gravity and authority. Convey the importance and weight of what's happening. Use precise, measured language.",
    "funny": "Add light humor and witty observations. Use playful language, mild sarcasm, or amusing comparisons where appropriate.",
    "teacher": "Explain what's happening as if teaching. Use clear, accessible language. Add context that helps understanding.",
}


def _build_scene_summaries(
    analysis: VideoAnalysis,
    vision_descriptions: list[dict] | None = None,
) -> list[dict[str, Any]]:
    """Build compact summaries of each scene for the LLM prompt."""
    scenes = analysis.scenes
    summaries = []
    vision_map = {}
    if vision_descriptions:
        vision_map = {v["id"]: v["visual_description"] for v in vision_descriptions}

    for i, scene in enumerate(scenes):
        position_pct = (scene.start_time / analysis.duration * 100) if analysis.duration > 0 else 0

        if position_pct < 10:
            position_label = "beginning"
        elif position_pct < 90:
            position_label = "middle"
        else:
            position_label = "ending"

        summary = {
            "id": i,
            "time": f"{scene.start_time:.1f}-{scene.end_time:.1f}s",
            "duration": f"{scene.duration:.1f}s",
            "position": position_label,
            "has_speech": scene.has_speech,
            "is_silent": scene.is_silent,
            "transcript": (scene.transcript[:200] if scene.transcript else None),
            "energy": round(scene.avg_energy, 1) if scene.avg_energy else None,
        }

        visual_desc = vision_map.get(i, "")
        if visual_desc:
            summary["visual_description"] = visual_desc

        summaries.append(summary)

    return summaries


def generate_narration_script(
    analysis: VideoAnalysis,
    tone: str = "documentary",
    language: str = "English",
    custom_prompt: str | None = None,
    llm_model: str = "gpt-4o",
    use_llm: bool = True,
    vision_descriptions: list[dict] | None = None,
) -> list[dict[str, Any]]:
    """Generate narration text for each scene.

    Args:
        analysis: Full video analysis with scenes and transcripts.
        tone: Tone preset (documentary, calm, excited, sad, happy, serious, funny, teacher).
        language: Language for narration output.
        custom_prompt: Optional custom tone/style instruction.
        llm_model: LLM model to use.
        use_llm: Whether to use LLM or generate rule-based narration.
        vision_descriptions: Optional list of dicts with "id" and "visual_description".

    Returns:
        List of dicts with "id" and "text" keys.
    """
    scene_summaries = _build_scene_summaries(analysis, vision_descriptions)

    if use_llm:
        return _generate_with_llm(scene_summaries, analysis, tone, language, custom_prompt, llm_model)
    else:
        return _generate_rule_based(scene_summaries)


def _generate_with_llm(
    scene_summaries: list[dict[str, Any]],
    analysis: VideoAnalysis,
    tone: str,
    language: str,
    custom_prompt: str | None,
    llm_model: str,
) -> list[dict[str, Any]]:
    """Generate narration using LLM."""
    from cutai.config import load_config

    config = load_config()

    tone_instruction = TONE_INSTRUCTIONS.get(tone, TONE_INSTRUCTIONS["documentary"])
    if custom_prompt:
        tone_instruction = custom_prompt

    system_prompt = f"{SYSTEM_PROMPT}\n\nTone/Style: {tone_instruction}\nLanguage: {language}"

    user_message = json.dumps({
        "video_duration": f"{analysis.duration:.1f}s",
        "total_scenes": len(scene_summaries),
        "scenes": scene_summaries,
    }, ensure_ascii=False, indent=2)

    user_message += (
        "\n\nRespond with a JSON object: "
        '{"narrations": [{"id": 0, "text": "narration for scene 0"}, ...]}'
    )

    backend = _resolve_backend(config, llm_model)

    if backend == "rule-based":
        logger.info("No LLM backend available, falling back to rule-based narration")
        return _generate_rule_based(scene_summaries)
    elif backend == "ollama":
        raw = _call_ollama(system_prompt, user_message, config)
    else:
        raw = _call_openai(system_prompt, user_message, config, llm_model, backend)

    data = _extract_json(raw)

    narrations = []
    for item in data.get("narrations", []):
        narrations.append({
            "id": int(item.get("id", 0)),
            "text": str(item.get("text", "")).strip(),
        })

    return narrations


def _resolve_backend(config, llm_model: str) -> str:
    """Determine which LLM backend to use."""
    setting = config.default_llm.lower().strip()

    if setting == "ollama":
        return "ollama"
    if setting in ("gemini", "google"):
        return "gemini"

    if setting in ("auto",) or llm_model.startswith("gpt"):
        if config.openai_api_key:
            return "openai"
        return "ollama"

    return "ollama"


def _call_ollama(system_prompt: str, user_message: str, config) -> str:
    """Call Ollama API for narration generation."""
    import os
    import urllib.request

    model = os.environ.get("OLLAMA_MODEL", config.ollama_model)
    logger.info("Calling Ollama (%s) for narration script...", model)

    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.4},
    }).encode()

    req = urllib.request.Request(
        "http://localhost:11434/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=300) as resp:
        result = json.loads(resp.read())

    raw = result.get("message", {}).get("content", "")
    if not raw:
        raise ValueError("Ollama returned empty response for narration")

    return raw


def _call_openai(system_prompt: str, user_message: str, config, model: str, backend: str) -> str:
    """Call OpenAI API for narration generation."""
    from openai import OpenAI

    api_key = config.openai_api_key
    if not api_key:
        raise ValueError("OpenAI API key required for narration")

    client = OpenAI(api_key=api_key)

    response = client.chat.completions.create(
        model=model if backend == "openai" else config.default_llm,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        response_format={"type": "json_object"},
        temperature=0.4,
    )

    raw = response.choices[0].message.content
    if not raw:
        raise ValueError("OpenAI returned empty response for narration")

    return raw


def _generate_rule_based(
    scene_summaries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Generate simple narration based on scene transcripts (no LLM).

    Uses the scene transcript directly as narration text, or generates
    a generic placeholder if no transcript is available.
    """
    narrations = []

    for scene in scene_summaries:
        text = scene.get("transcript", "")

        if text:
            narrations.append({
                "id": scene["id"],
                "text": text,
            })
        elif scene.get("is_silent"):
            narrations.append({
                "id": scene["id"],
                "text": "",
            })

    return narrations
