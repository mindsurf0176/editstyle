"""Regression checks for the optional standalone editor runtime."""

from __future__ import annotations

import asyncio
import builtins
import sys

import pytest

import cutai.server as server
from cutai.analyzer.cache import get_cached, save_cache


def test_transcription_settings_do_not_share_cached_analysis(tmp_path, sample_analysis):
    video = tmp_path / "source.mp4"
    video.write_bytes(b"video")

    save_cache(str(video), sample_analysis, skip_transcription=True)

    assert get_cached(str(video), skip_transcription=True) is not None
    assert get_cached(str(video), skip_transcription=False) is None


def test_analysis_without_transcription_does_not_import_backend(
    monkeypatch, tmp_path, sample_analysis
):
    monkeypatch.setattr(server, "jobs", {})
    monkeypatch.setattr(server, "videos", {"video": {}})
    monkeypatch.setitem(sys.modules, "cutai.analyzer.transcriber", None)
    monkeypatch.setattr(
        "cutai.analyzer._get_video_metadata",
        lambda _: sample_analysis.model_dump(include={"duration", "fps", "width", "height"}),
    )
    monkeypatch.setattr(
        "cutai.analyzer.scene_detector.detect_scenes", lambda _: sample_analysis.scenes
    )
    monkeypatch.setattr("cutai.analyzer._extract_audio_cached", lambda *_: None)
    monkeypatch.setattr(
        "cutai.analyzer.quality_analyzer.analyze_quality",
        lambda *_, **__: sample_analysis.quality,
    )
    job_id = server._create_job("analysis")

    asyncio.run(server._run_analysis(job_id, "video", str(tmp_path / "video.mp4"), "base", True))

    assert server.jobs[job_id]["status"] == "completed"
    assert server.jobs[job_id]["result"]["transcript"] == []


def test_missing_transcriber_explains_optional_install(monkeypatch):
    from cutai.analyzer.transcriber import _transcribe_openai_whisper

    import_module = builtins.__import__

    def without_whisper(name, *args, **kwargs):
        if name == "whisper":
            raise ModuleNotFoundError("No module named 'whisper'")
        return import_module(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_whisper)

    with pytest.raises(RuntimeError, match="cutai-transcription"):
        _transcribe_openai_whisper("video.mp4", "base", None)


def test_editor_package_contains_runtime_resources():
    from importlib.resources import files

    package = files("cutai")
    assert package.joinpath("style/presets/cinematic.yaml").is_file()
    assert package.joinpath("planner/prompts/system.md").is_file()
