"""Vision analyzer — extracts frames and describes scenes using a vision LLM.

Sends representative frames from each scene to a vision model (e.g. Gemma 4)
via Ollama API to get visual descriptions, enabling context-aware narration.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path

from cutai.config import ensure_ffmpeg

logger = logging.getLogger(__name__)

VISION_SYSTEM_PROMPT = """You are an expert video scene analyst. Examine this video frame carefully and provide a detailed visual description.

Describe the following in your analysis:
1. **Setting & Environment**: Where is this taking place? Indoor/outdoor, lighting, colors, atmosphere
2. **People & Characters**: Who is visible? Their appearance, expressions, body language, actions, poses
3. **Objects & Details**: Key items, UI elements, text overlays, subtitles, score displays, any readable text in the frame
4. **Action & Motion**: What is happening? What just happened or is about to happen?
5. **Mood & Tone**: What emotion or vibe does this frame convey?

Be specific and detailed — mention exact colors, positions, text content, numbers, and visual details.
This description will be used to write a voiceover narration, so include everything a narrator would describe to a viewer."""

DEFAULT_VISION_MODEL = "mistral-large-3:675b-cloud"


def extract_frame(video_path: str, timestamp: float, output_path: str) -> str:
    """Extract a single frame from video at the given timestamp.

    Args:
        video_path: Path to the video file.
        timestamp: Time in seconds to extract the frame.
        output_path: Path to save the JPEG frame.

    Returns:
        Path to the extracted frame.
    """
    ffmpeg = ensure_ffmpeg()

    cmd = [
        ffmpeg,
        "-y",
        "-ss", str(timestamp),
        "-i", video_path,
        "-frames:v", "1",
        "-q:v", "2",
        output_path,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"Failed to extract frame at {timestamp}s: {result.stderr[-200:]}")

    return output_path


def extract_multiple_frames(
    video_path: str,
    start_time: float,
    end_time: float,
    tmpdir: str,
    scene_index: int,
    count: int = 3,
) -> list[str]:
    """Extract multiple evenly-spaced frames from a scene.

    Args:
        video_path: Path to the video file.
        start_time: Scene start time in seconds.
        end_time: Scene end time in seconds.
        tmpdir: Persistent temp directory to store frames.
        scene_index: Scene number for naming.
        count: Number of frames to extract.

    Returns:
        List of paths to extracted frames.
    """
    if end_time - start_time < 1.0:
        count = 1

    frames = []
    for i in range(count):
        if count == 1:
            ts = (start_time + end_time) / 2
        else:
            ts = start_time + (end_time - start_time) * i / (count - 1)

        frame_path = os.path.join(tmpdir, f"scene{scene_index}_frame{i}.jpg")
        try:
            extract_frame(video_path, ts, frame_path)
            frames.append(frame_path)
        except Exception as e:
            logger.warning("Failed to extract frame at %.1fs: %s", ts, e)

    return frames


def encode_image_base64(image_path: str) -> str:
    """Encode an image file to base64 string."""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def describe_frame(
    image_path: str,
    model: str | None = None,
    system_prompt: str | None = None,
) -> str:
    """Send a frame to a vision LLM and get a description.

    Args:
        image_path: Path to the image file.
        model: Ollama model name (defaults to mistral-large-3:675b-cloud).
        system_prompt: Custom system prompt.

    Returns:
        Visual description string.
    """
    from cutai.narrator._json import extract_json as _extract_json
    import urllib.request

    model = model or os.environ.get("OLLAMA_VISION_MODEL", DEFAULT_VISION_MODEL)
    prompt = system_prompt or VISION_SYSTEM_PROMPT

    b64_image = encode_image_base64(image_path)

    payload = json.dumps({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": b64_image},
                    {"type": "text", "text": prompt},
                ],
            },
        ],
        "stream": False,
        "options": {"temperature": 0.3},
    }).encode()

    req = urllib.request.Request(
        "http://localhost:11434/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=180) as resp:
        result = json.loads(resp.read())

    description = result.get("message", {}).get("content", "")
    if not description:
        raise ValueError(f"Vision model returned empty description for {image_path}")

    description = description.strip()
    description = _extract_json(description) if description.startswith("{") or description.startswith("`") else description
    if isinstance(description, dict):
        description = description.get("description", description.get("text", json.dumps(description)))

    return str(description).strip()


def analyze_scenes(
    video_path: str,
    analysis,
    model: str | None = None,
    frames_per_scene: int = 3,
) -> list[dict]:
    """Analyze all scenes in a video using vision LLM.

    Extracts representative frames from each scene and sends them
    to a vision model for description.

    Args:
        video_path: Path to the source video.
        analysis: VideoAnalysis object with scenes.
        model: Vision model name for Ollama.
        frames_per_scene: How many frame descriptions per scene.

    Returns:
        List of dicts with "id" and "visual_description" keys.
    """
    from cutai.narrator._json import extract_json as _extract_json

    logger.info("Analyzing %d scenes with vision model (%s)...", len(analysis.scenes), model or DEFAULT_VISION_MODEL)

    descriptions = []

    with tempfile.TemporaryDirectory(prefix="cutai_vision_") as tmpdir:
        for i, scene in enumerate(analysis.scenes):
            try:
                frames = extract_multiple_frames(
                    video_path,
                    scene.start_time,
                    scene.end_time,
                    tmpdir=tmpdir,
                    scene_index=i,
                    count=frames_per_scene,
                )

                scene_descriptions = []
                for frame_path in frames:
                    if os.path.exists(frame_path):
                        desc = describe_frame(frame_path, model=model)
                        scene_descriptions.append(desc)

                combined = " | ".join(scene_descriptions) if scene_descriptions else ""

                descriptions.append({
                    "id": i,
                    "visual_description": combined[:1000],
                })

                logger.info(
                    "  Scene %d (%.1f-%.1fs): %s",
                    i, scene.start_time, scene.end_time,
                    combined[:80] + "..." if len(combined) > 80 else combined,
                )

            except Exception as e:
                logger.warning("  Scene %d: Vision analysis failed: %s", i, e)
                descriptions.append({"id": i, "visual_description": ""})

    return descriptions
