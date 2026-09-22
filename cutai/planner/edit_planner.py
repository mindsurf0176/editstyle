"""Edit planner — converts VideoAnalysis + natural language → EditPlan.

Supports:
- LLM-based planning (OpenAI API)
- Rule-based fallback for common instructions
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Literal, cast

if TYPE_CHECKING:
    from cutai.models.types import UserPreferences

from cutai.config import load_config
from cutai.models.types import (
    BGMOperation,
    ColorGradeOperation,
    CutOperation,
    EditOperation,
    EditPlan,
    SpeedOperation,
    SubtitleOperation,
    TransitionOperation,
    VideoAnalysis,
)

logger = logging.getLogger(__name__)

SubtitleStyle = Literal["default", "emphasis", "karaoke"]
SubtitlePosition = Literal["bottom", "center", "top"]
BgmMood = Literal["upbeat", "calm", "dramatic", "funny", "emotional"]
TransitionStyle = Literal["cut", "fade", "dissolve", "wipe"]

SYSTEM_PROMPT_PATH = Path(__file__).parent / "prompts" / "system.md"


def create_edit_plan(
    analysis: VideoAnalysis,
    instruction: str,
    llm_model: str = "gpt-4o",
    use_llm: bool = True,
    preferences: UserPreferences | None = None,
) -> EditPlan:
    """Create an edit plan from a video analysis and instruction.

    First tries rule-based fallback for common instructions.
    Falls back to LLM if no rule matches or if use_llm is True and
    the rule-based plan seems insufficient.

    When *preferences* are provided, few-shot examples from the user's
    history are injected into the LLM prompt and ``suggest_defaults()``
    fills ambiguous rule-based parameters.

    Args:
        analysis: Complete video analysis.
        instruction: Natural language editing instruction.
        llm_model: LLM model to use for planning.
        use_llm: Whether to use LLM for planning (requires API key).
        preferences: Optional UserPreferences for personalization.

    Returns:
        EditPlan with ordered operations.
    """
    # Try rule-based fallback first
    rule_plan = _try_rule_based(analysis, instruction)
    if rule_plan and not use_llm:
        return rule_plan

    # Try LLM-based planning
    config = load_config()
    if use_llm:
        llm_backend = _resolve_llm_backend(config, llm_model)
        if llm_backend:
            try:
                llm_plan = _plan_with_llm_backend(
                    analysis, instruction, config, llm_backend,
                    preferences=preferences,
                )
                return llm_plan
            except Exception as exc:
                logger.warning("LLM planning failed (%s): %s. Using rule-based fallback.", llm_backend, exc)

    # If LLM failed or no backend available, use rule-based
    if rule_plan:
        return rule_plan

    # Last resort: return a minimal plan
    logger.warning("No LLM backend available and no matching rules. Returning minimal plan.")
    summary = (
        "No matching rules found. Try: remove silence, add subtitles, trim to N minutes, "
        "add bgm, color grade, etc. Or set up Ollama (free, local) for smarter planning."
    )
    return EditPlan(
        instruction=instruction,
        operations=[],
        estimated_duration=analysis.duration,
        summary=summary,
    )




def _explain_empty_ops(instruction: str, analysis: VideoAnalysis) -> str:
    """Generate a helpful message when rules matched but produced no operations."""
    if _matches_any(instruction, ["remove silence", "cut silence", "무음 제거", "무음 삭제", "delete silence"]):
        return f"No silent segments detected in this video (silence ratio: {analysis.quality.overall_silence_ratio:.1f}%) — nothing to remove."
    if _matches_any(instruction, ["boring", "remove boring", "재미없는", "지루한"]):
        return "No low-engagement scenes detected — the video looks good as-is."
    if _matches_any(instruction, ["speech only", "말하는 부분만", "talking only", "대화만"]):
        return "No non-speech segments detected — the entire video contains speech."
    return "The instruction matched but no segments in this video need editing."

def _try_rule_based(analysis: VideoAnalysis, instruction: str) -> EditPlan | None:
    """Try to create an edit plan using simple rule matching.

    Handles common instructions without needing an LLM.
    """
    lower = instruction.lower()
    operations: list[EditOperation] = []
    summary_parts: list[str] = []
    rule_matched = False  # Track whether any rule matched (even if 0 ops)

    # ── Cut rules ────────────────────────────────────────────────────────

    # Rule: Remove silence
    if _matches_any(lower, ["remove silence", "무음 제거", "cut silence", "무음 삭제", "delete silence"]):
        rule_matched = True
        for seg in analysis.quality.silent_segments:
            operations.append(
                CutOperation(
                    action="remove",
                    start_time=seg.start,
                    end_time=seg.end,
                    reason=f"Silent segment ({seg.duration:.1f}s)",
                )
            )
        if analysis.quality.silent_segments:
            summary_parts.append(f"Remove {len(analysis.quality.silent_segments)} silent segments")
        else:
            summary_parts.append("No silent segments detected in this video — nothing to remove")

    # Rule: Add subtitles
    if _matches_any(lower, ["add subtitles", "자막", "subtitle", "subtitles", "자막 넣어", "자막 추가"]):
        rule_matched = True
        subtitle_style: SubtitleStyle = "default"
        position: SubtitlePosition = "bottom"
        if _matches_any(lower, ["center", "중앙"]):
            position = "center"
        if _matches_any(lower, ["top", "상단"]):
            position = "top"

        operations.append(
            SubtitleOperation(
                style=subtitle_style,
                language="auto",
                font_size=24,
                position=position,
            )
        )
        summary_parts.append("Add subtitles")

    # Rule: Remove boring/uninteresting parts
    if _matches_any(lower, [
        "재미없는 부분 잘라", "재미없는 부분 제거", "boring", "remove boring",
        "지루한 부분", "필요없는 부분",
    ]):
        rule_matched = True
        for scene in analysis.scenes:
            if scene.is_silent or (scene.avg_energy < -45 and not scene.has_speech):
                operations.append(CutOperation(
                    action="remove",
                    start_time=scene.start_time,
                    end_time=scene.end_time,
                    reason=f"Low engagement scene (silent={scene.is_silent}, energy={scene.avg_energy:.1f}dB)",
                ))
        summary_parts.append("Remove boring/low-engagement scenes")

    # Rule: Keep only speech parts
    if _matches_any(lower, [
        "말하는 부분만", "speech only", "talking only", "대화만",
    ]):
        rule_matched = True
        for scene in analysis.scenes:
            if not scene.has_speech:
                operations.append(CutOperation(
                    action="remove",
                    start_time=scene.start_time,
                    end_time=scene.end_time,
                    reason="No speech detected",
                ))
        summary_parts.append("Keep only scenes with speech")

    # Rule: Trim to X minutes
    trim_match = re.search(r"(?:trim|cut|줄여|줄이)\s*(?:to\s*)?(\d+)\s*(?:min|분|minutes?)", lower)
    if trim_match:
        rule_matched = True
        target_minutes = int(trim_match.group(1))
        target_seconds = target_minutes * 60.0
        trim_ops = _trim_to_duration(analysis, target_seconds)
        operations.extend(trim_ops)
        summary_parts.append(f"Trim to {target_minutes} minutes")

    # ── Color grading rules ──────────────────────────────────────────────

    if _matches_any(lower, ["밝게", "bright", "밝은 느낌", "밝은 톤"]):
        rule_matched = True
        operations.append(ColorGradeOperation(preset="bright"))
        summary_parts.append("Apply bright color grade")

    elif _matches_any(lower, ["따뜻하게", "warm", "따뜻한 느낌", "따뜻한 톤"]):
        rule_matched = True
        operations.append(ColorGradeOperation(preset="warm"))
        summary_parts.append("Apply warm color grade")

    elif _matches_any(lower, ["시네마틱", "cinematic", "영화 느낌", "영화같이"]):
        rule_matched = True
        operations.append(ColorGradeOperation(preset="cinematic"))
        summary_parts.append("Apply cinematic color grade")

    elif _matches_any(lower, ["빈티지", "vintage", "레트로", "retro"]):
        rule_matched = True
        operations.append(ColorGradeOperation(preset="vintage"))
        summary_parts.append("Apply vintage color grade")

    elif _matches_any(lower, ["차갑게", "cool", "차가운 느낌", "차가운 톤", "쿨톤"]):
        rule_matched = True
        operations.append(ColorGradeOperation(preset="cool"))
        summary_parts.append("Apply cool color grade")

    # ── BGM rules ────────────────────────────────────────────────────────

    if _matches_any(lower, ["bgm", "music", "background music", "배경음악", "음악 넣", "음악 추가", "배경 음악", "bgm 넣", "bgm 추가"]):
        rule_matched = True
        mood = _detect_bgm_mood(lower)
        operations.append(BGMOperation(mood=mood))
        summary_parts.append(f"Add BGM (mood={mood})")

    # ── Speed rules ──────────────────────────────────────────────────────

    speed_match = re.search(r"(\d+(?:\.\d+)?)\s*배속", lower)
    if speed_match:
        rule_matched = True
        factor = float(speed_match.group(1))
        operations.append(SpeedOperation(
            factor=factor,
            start_time=0,
            end_time=analysis.duration,
        ))
        summary_parts.append(f"Speed ×{factor}")
    elif _matches_any(lower, ["빠르게", "speed up", "fast", "faster"]):
        rule_matched = True
        operations.append(SpeedOperation(
            factor=2.0,
            start_time=0,
            end_time=analysis.duration,
        ))
        summary_parts.append("Speed ×2.0")
    elif _matches_any(lower, ["느리게", "slow", "슬로우", "slower", "slow motion"]):
        rule_matched = True
        operations.append(SpeedOperation(
            factor=0.5,
            start_time=0,
            end_time=analysis.duration,
        ))
        summary_parts.append("Speed ×0.5 (slow motion)")

    # ── Transition rules ─────────────────────────────────────────────────

    if _matches_any(lower, ["페이드", "fade", "전환 효과", "트랜지션", "transition"]):
        rule_matched = True
        transition_style: TransitionStyle = "fade"
        if _matches_any(lower, ["dissolve", "디졸브"]):
            transition_style = "dissolve"
        elif _matches_any(lower, ["wipe", "와이프"]):
            transition_style = "wipe"

        # Add transitions between all consecutive scenes
        for i in range(len(analysis.scenes) - 1):
            operations.append(TransitionOperation(
                style=transition_style,
                duration=0.5,
                between=(i, i + 1),
            ))
        if analysis.scenes:
            summary_parts.append(f"Add {transition_style} transitions between scenes")

    # ── Return ───────────────────────────────────────────────────────────

    # If rules matched but produced no operations, add helpful context
    if rule_matched and not operations:
        summary_parts = [_explain_empty_ops(lower, analysis)]

    if not rule_matched:
        return None

    estimated = _estimate_duration(analysis, operations)

    return EditPlan(
        instruction=instruction,
        operations=operations,
        estimated_duration=round(estimated, 2),
        summary="; ".join(summary_parts),
    )


def _detect_bgm_mood(text: str) -> BgmMood:
    """Detect BGM mood from instruction text.

    Args:
        text: Lowercased instruction text.

    Returns:
        Mood string matching BGMOperation.mood literals.
    """
    mood_keywords: dict[BgmMood, list[str]] = {
        "upbeat": ["신나는", "upbeat", "energetic", "활기", "밝은 음악", "경쾌"],
        "calm": ["잔잔한", "calm", "peaceful", "편안", "차분"],
        "dramatic": ["드라마틱", "dramatic", "epic", "웅장", "긴장"],
        "funny": ["재밌는", "funny", "comedy", "코믹", "유머"],
        "emotional": ["감성", "emotional", "감동", "슬픈", "sad"],
    }

    for mood, keywords in mood_keywords.items():
        if _matches_any(text, keywords):
            return mood

    return "calm"  # Default mood


def _resolve_llm_backend(config, llm_model: str) -> str | None:
    """Determine which LLM backend to use.

    Priority (when default_llm="auto"):
    1. Ollama (if running locally) — free, no API key
    2. Google Gemini (if GOOGLE_API_KEY set) — free tier
    3. OpenAI (if OPENAI_API_KEY set) — paid
    """
    llm_setting = config.default_llm.lower().strip()

    if llm_setting == "ollama":
        return "ollama"
    if llm_setting in ("gemini", "google"):
        return "gemini" if config.google_api_key else None
    if llm_setting == "openai":
        return "openai" if config.openai_api_key else None

    # Auto-detection
    if llm_setting in ("auto", "gpt-4o", "gpt-4o-mini"):
        if _is_ollama_running():
            return "ollama"
        if config.google_api_key:
            return "gemini"
        if config.openai_api_key:
            return "openai"
    elif config.openai_api_key:
        return "openai"
    return None


def _is_ollama_running() -> bool:
    """Check if Ollama is running locally."""
    import urllib.request
    try:
        req = urllib.request.Request("http://localhost:11434/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def _plan_with_llm_backend(
    analysis: VideoAnalysis,
    instruction: str,
    config,
    backend: str,
    preferences: UserPreferences | None = None,
) -> EditPlan:
    """Route to the appropriate LLM backend."""
    if backend == "ollama":
        return _plan_with_ollama(analysis, instruction, config, preferences)
    elif backend == "gemini":
        return _plan_with_gemini(analysis, instruction, config, preferences)
    else:
        model = config.default_llm if config.default_llm not in ("auto",) else "gpt-4o"
        return _plan_with_llm(analysis, instruction, model, config.openai_api_key, preferences)


def _build_planning_messages(analysis: VideoAnalysis, instruction: str) -> tuple[str, str]:
    """Build system + user prompt for LLM planning (shared across backends)."""
    system_prompt = "You are a professional video editor AI."
    if SYSTEM_PROMPT_PATH.exists():
        system_prompt = SYSTEM_PROMPT_PATH.read_text()

    analysis_summary = {
        "file": Path(analysis.file_path).name,
        "duration": analysis.duration,
        "fps": analysis.fps,
        "resolution": f"{analysis.width}x{analysis.height}",
        "scenes": [
            {"id": s.id, "start": s.start_time, "end": s.end_time,
             "duration": s.duration, "has_speech": s.has_speech, "is_silent": s.is_silent,
             "transcript": s.transcript[:200] if s.transcript else None}
            for s in analysis.scenes[:50]
        ],
        "silent_segments": [{"start": seg.start, "end": seg.end} for seg in analysis.quality.silent_segments],
        "silence_ratio": analysis.quality.overall_silence_ratio,
    }

    user_message = (
        f"## Video Analysis\n```json\n{json.dumps(analysis_summary, ensure_ascii=False, indent=2)}\n```\n\n"
        f"## Editing Instruction\n{instruction}\n\n"
        "Respond with JSON: {{\"operations\": [...], \"summary\": \"...\"}}\n"
        "Each operation needs 'type': cut, subtitle, bgm, colorgrade, transition, speed."
    )
    return system_prompt, user_message


def _plan_with_ollama(
    analysis: VideoAnalysis, instruction: str, config, preferences=None,
) -> EditPlan:
    """Generate an edit plan using Ollama (local, free)."""
    import urllib.request

    system_prompt, user_message = _build_planning_messages(analysis, instruction)
    model = config.ollama_model
    logger.info("Calling Ollama (%s) for edit planning...", model)

    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "format": "json", "stream": False,
        "options": {"temperature": 0.3},
    }).encode()

    req = urllib.request.Request(
        "http://localhost:11434/api/chat", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())

    raw = result.get("message", {}).get("content", "")
    if not raw:
        raise ValueError("Ollama returned empty response")
    data = json.loads(raw)
    return _parse_llm_response(data, instruction)


def _plan_with_gemini(
    analysis: VideoAnalysis, instruction: str, config, preferences=None,
) -> EditPlan:
    """Generate an edit plan using Google Gemini (free tier available)."""
    import urllib.request

    system_prompt, user_message = _build_planning_messages(analysis, instruction)
    logger.info("Calling Gemini for edit planning...")

    payload = json.dumps({
        "contents": [{"parts": [{"text": f"{system_prompt}\n\n{user_message}"}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3},
    }).encode()

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key={config.google_api_key}"
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())

    raw = result["candidates"][0]["content"]["parts"][0]["text"]
    if not raw:
        raise ValueError("Gemini returned empty response")
    data = json.loads(raw)
    return _parse_llm_response(data, instruction)


def _plan_with_llm(
    analysis: VideoAnalysis,
    instruction: str,
    model: str,
    api_key: str,
    preferences: UserPreferences | None = None,
) -> EditPlan:
    """Create an edit plan using OpenAI's API.

    When *preferences* are provided, few-shot examples and suggested
    defaults are appended to the user message for better personalization.
    """
    from openai import OpenAI

    client = OpenAI(api_key=api_key)

    # Load system prompt
    system_prompt = "You are a professional video editor AI."
    if SYSTEM_PROMPT_PATH.exists():
        system_prompt = SYSTEM_PROMPT_PATH.read_text()

    # Prepare analysis summary (keep it concise for token efficiency)
    analysis_summary = {
        "file": analysis.file_path,
        "duration": analysis.duration,
        "fps": analysis.fps,
        "resolution": f"{analysis.width}x{analysis.height}",
        "scenes": [
            {
                "id": s.id,
                "start": s.start_time,
                "end": s.end_time,
                "duration": s.duration,
                "has_speech": s.has_speech,
                "is_silent": s.is_silent,
                "transcript": s.transcript[:200] if s.transcript else None,
                "avg_energy": s.avg_energy,
            }
            for s in analysis.scenes
        ],
        "silent_segments": [
            {"start": seg.start, "end": seg.end}
            for seg in analysis.quality.silent_segments
        ],
        "silence_ratio": analysis.quality.overall_silence_ratio,
    }

    user_message = (
        f"## Video Analysis\n```json\n{json.dumps(analysis_summary, ensure_ascii=False, indent=2)}\n```\n\n"
        f"## Editing Instruction\n{instruction}"
    )

    # Inject personalization from learning history
    if preferences is not None:
        try:
            from cutai.learning import get_few_shot_examples, suggest_defaults

            examples = get_few_shot_examples(preferences, instruction, max_examples=3)
            if examples:
                examples_text = "\n".join(
                    f"- Instruction: \"{ex.instruction}\" → Operations: {', '.join(ex.operations_summary)}"
                    for ex in examples
                )
                user_message += (
                    f"\n\n## User's Past Editing Preferences (few-shot examples)\n{examples_text}"
                )

            defaults = suggest_defaults(preferences)
            if defaults:
                defaults_text = ", ".join(f"{k}={v}" for k, v in defaults.items())
                user_message += (
                    f"\n\n## Suggested Defaults (from user history)\n{defaults_text}"
                )
        except Exception as exc:
            logger.debug("Failed to inject preferences into LLM prompt: %s", exc)

    logger.info("Calling %s for edit planning...", model)

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
    )

    raw = response.choices[0].message.content
    if not raw:
        raise ValueError("LLM returned empty response")

    logger.debug("LLM raw response: %s", raw[:500])
    data = json.loads(raw)

    return _parse_llm_response(data, instruction)


def _parse_llm_response(data: dict, instruction: str) -> EditPlan:
    """Parse LLM JSON response into an EditPlan."""
    operations: list[EditOperation] = []

    for op_data in data.get("operations", []):
        op_type = op_data.get("type")

        if op_type == "cut":
            operations.append(
                CutOperation(
                    action=op_data.get("action", "remove"),
                    start_time=float(op_data.get("start_time", 0)),
                    end_time=float(op_data.get("end_time", 0)),
                    reason=op_data.get("reason", ""),
                )
            )
        elif op_type == "subtitle":
            operations.append(
                SubtitleOperation(
                    style=cast(SubtitleStyle, op_data.get("style", "default")),
                    language=op_data.get("language", "auto"),
                    font_size=int(op_data.get("font_size", 24)),
                    position=cast(SubtitlePosition, op_data.get("position", "bottom")),
                )
            )
        elif op_type == "bgm":
            operations.append(
                BGMOperation(
                    mood=cast(BgmMood, op_data.get("mood", "calm")),
                    volume=float(op_data.get("volume", 15.0)),
                    fade_in=float(op_data.get("fade_in", 2.0)),
                    fade_out=float(op_data.get("fade_out", 2.0)),
                )
            )
        elif op_type == "colorgrade":
            operations.append(
                ColorGradeOperation(
                    preset=cast(
                        Literal["bright", "warm", "cool", "cinematic", "vintage"],
                        op_data.get("preset", "bright"),
                    ),
                    intensity=float(op_data.get("intensity", 50.0)),
                )
            )
        elif op_type == "transition":
            between = op_data.get("between", [0, 1])
            if isinstance(between, list) and len(between) == 2:
                between_tuple = (int(between[0]), int(between[1]))
            else:
                between_tuple = (0, 1)
            operations.append(
                TransitionOperation(
                    style=cast(TransitionStyle, op_data.get("style", "fade")),
                    duration=float(op_data.get("duration", 0.5)),
                    between=between_tuple,
                )
            )
        elif op_type == "speed":
            operations.append(
                SpeedOperation(
                    factor=float(op_data.get("factor", 1.0)),
                    start_time=float(op_data.get("start_time", 0)),
                    end_time=float(op_data.get("end_time", 0)),
                )
            )
        else:
            logger.debug("Skipping unsupported operation type: %s", op_type)

    return EditPlan(
        instruction=instruction,
        operations=operations,
        estimated_duration=float(data.get("estimated_duration", 0)),
        summary=data.get("summary", ""),
    )


def _trim_to_duration(analysis: VideoAnalysis, target_seconds: float) -> list[CutOperation]:
    """Create cut operations to trim a video to a target duration.

    Strategy: remove silent/low-energy scenes first, then lowest-energy scenes
    until target duration is reached.
    """
    if analysis.duration <= target_seconds:
        return []

    # Score scenes: higher = more worth keeping
    scored = []
    for scene in analysis.scenes:
        score = 0.0
        if scene.has_speech:
            score += 50.0
        if not scene.is_silent:
            score += 30.0
        # Energy scoring: dB is negative, closer to 0 = louder = more interesting
        if scene.avg_energy < 0:
            score += max(0, (60 + scene.avg_energy))
        elif scene.avg_energy == 0:
            score += 10
        scored.append((scene, score))

    # Sort by score (lowest first — candidates for removal)
    scored.sort(key=lambda x: x[1])

    excess = analysis.duration - target_seconds
    removed = 0.0
    ops: list[CutOperation] = []

    for scene, score in scored:
        if removed >= excess:
            break
        ops.append(
            CutOperation(
                action="remove",
                start_time=scene.start_time,
                end_time=scene.end_time,
                reason=f"Low priority scene (score={score:.1f}) — trimming to target duration",
            )
        )
        removed += scene.duration

    return ops


def _estimate_duration(analysis: VideoAnalysis, operations: list) -> float:
    """Estimate the output duration after applying operations."""
    removed = 0.0
    speed_factor = 1.0

    for op in operations:
        if isinstance(op, CutOperation) and op.action == "remove":
            removed += op.end_time - op.start_time
        elif isinstance(op, SpeedOperation) and op.start_time <= 0.05:
            # Simplistic: if whole-video speed, apply factor to total
            speed_factor = op.factor

    base_duration = max(0, analysis.duration - removed)
    return base_duration / speed_factor if speed_factor > 0 else base_duration


def _matches_any(text: str, patterns: list[str]) -> bool:
    """Check if text contains any of the given patterns."""
    return any(p in text for p in patterns)
