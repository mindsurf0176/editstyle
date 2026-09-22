"""Bounded local video preparation and timestamped evidence; no cloud calls."""

from __future__ import annotations

import base64
import json
import math
import re
import shutil
import subprocess
from pathlib import Path


def run(args: list[str], timeout: int = 180) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise ValueError("FFmpeg와 FFprobe가 필요합니다. macOS에서는 brew install ffmpeg로 설치하세요.") from exc
    except subprocess.TimeoutExpired as exc:
        raise ValueError("영상 처리 시간이 초과됐습니다. 더 짧은 영상으로 다시 시도하세요.") from exc
    if result.returncode:
        raise ValueError("영상을 처리하지 못했습니다. 파일이 재생되는지 확인하고 MP4로 다시 시도하세요.")
    return result


def probe(path: Path) -> dict:
    result = run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)], 30)
    info = json.loads(result.stdout)
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if not video:
        raise ValueError("영상 스트림이 없습니다.")
    duration = float(video.get("duration") or info["format"].get("duration", 0))
    if not math.isfinite(duration) or not 0 < duration <= 600:
        raise ValueError("첫 버전은 10분 이하의 영상을 지원합니다.")
    return {"duration": duration, "width": video["width"], "height": video["height"],
            "has_audio": any(s["codec_type"] == "audio" for s in info["streams"]),
            "frames": int(video.get("nb_frames", 0))}


def prepare(directory: Path, original_name: str) -> dict:
    raw = directory / "upload"
    probe(raw)
    source = directory / "source.mp4"
    run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-i", str(raw),
         "-map", "0:v:0", "-map", "0:a:0?", "-vf",
         "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", str(source)], 600)
    info = probe(source)
    info["fps"] = 30
    info["duration"] = info["frames"] / 30
    info["name"] = Path(original_name).name
    # The working copy is explicit; original bytes are not silently overwritten.
    info["working_copy"] = "30fps H.264, longest side <=1280px, stereo AAC"
    result = run(["ffmpeg", "-hide_banner", "-nostdin", "-i", str(source), "-vf",
                  "scale=320:-2,select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"], 180)
    boundaries = sorted({round(float(t) * 30) for t in
                         re.findall(rb"pts_time:([0-9.]+)", result.stderr)
                         if 0 < float(t) < info["duration"]})
    limits = [0, *boundaries, info["frames"]]
    info["scenes"] = [{"start": a / 30, "end": b / 30} for a, b in zip(limits, limits[1:], strict=False)]
    info["evidence"] = "FFmpeg scene-difference threshold 0.3; candidate cuts, not verified transitions. No speech transcription."
    info["samples"] = []
    for i in range(8):
        t = info["duration"] * (i + 0.5) / 8
        run(["ffmpeg", "-v", "error", "-nostdin", "-n", "-ss", str(t), "-i", str(source),
             "-frames:v", "1", "-vf", "scale=640:-2", str(directory / f"frame-{i}.jpg")], 30)
        info["samples"].append(round(t, 3))
    return info


def model_content(directory: Path, info: dict, prompt: str, images: bool):
    if not images:
        return prompt + "\nNo images or audio supplied. Do not invent visual/semantic observations."
    content = [{"type": "text", "text": prompt + "\nNo audio supplied. Frames are sparse samples, not full video."}]
    for i, timestamp in enumerate(info["samples"]):
        encoded = base64.b64encode((directory / f"frame-{i}.jpg").read_bytes()).decode()
        content.extend([{"type": "text", "text": f"Source time {timestamp:.3f}s"},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded}"}}])
    return content


def available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
