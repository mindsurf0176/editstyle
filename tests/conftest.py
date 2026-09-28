"""Shared fixtures for CutAI tests.

All fixtures use synthetic data — no actual video files or FFmpeg needed.
"""

from __future__ import annotations

import pytest

from cutai.models.types import (
    EditDNA,
    EngagementReport,
    QualityReport,
    SceneEngagement,
    SceneInfo,
    TimeRange,
    TranscriptSegment,
    UserPreferences,
    VideoAnalysis,
)


@pytest.fixture(autouse=True)
def isolate_project_storage(monkeypatch, tmp_path):
    """No server test may read or write the real user's persistent projects."""
    monkeypatch.setenv("CUTAI_DATA_DIR", str(tmp_path / "cutai-data"))
    # Existing tests import the module at collection time and use its registries.
    import sys

    server = sys.modules.get("cutai.server")
    if server is not None:
        monkeypatch.setattr(server, "UPLOAD_DIR", tmp_path / "cutai-data" / "media")
        monkeypatch.setattr(server, "OUTPUT_DIR", tmp_path / "outputs")
        monkeypatch.setattr(server, "videos", {})
        monkeypatch.setattr(server, "jobs", {})


@pytest.fixture
def sample_scenes() -> list[SceneInfo]:
    """A list of 5 scenes with varied properties."""
    return [
        SceneInfo(
            id=0,
            start_time=0.0,
            end_time=5.0,
            duration=5.0,
            has_speech=True,
            is_silent=False,
            transcript="Hello and welcome to this video.",
            avg_energy=-20.0,
        ),
        SceneInfo(
            id=1,
            start_time=5.0,
            end_time=10.0,
            duration=5.0,
            has_speech=False,
            is_silent=True,
            transcript=None,
            avg_energy=-60.0,
        ),
        SceneInfo(
            id=2,
            start_time=10.0,
            end_time=20.0,
            duration=10.0,
            has_speech=True,
            is_silent=False,
            transcript="Today we are going to talk about AI video editing.",
            avg_energy=-18.0,
        ),
        SceneInfo(
            id=3,
            start_time=20.0,
            end_time=25.0,
            duration=5.0,
            has_speech=False,
            is_silent=True,
            transcript=None,
            avg_energy=-55.0,
        ),
        SceneInfo(
            id=4,
            start_time=25.0,
            end_time=35.0,
            duration=10.0,
            has_speech=True,
            is_silent=False,
            transcript="Thanks for watching, see you next time!",
            avg_energy=-22.0,
        ),
    ]


@pytest.fixture
def sample_analysis(sample_scenes: list[SceneInfo]) -> VideoAnalysis:
    """A complete VideoAnalysis with sample data."""
    return VideoAnalysis(
        file_path="test_video.mp4",
        duration=35.0,
        fps=30.0,
        width=1920,
        height=1080,
        scenes=sample_scenes,
        transcript=[
            TranscriptSegment(
                start_time=0.5,
                end_time=4.5,
                text="Hello and welcome to this video.",
                confidence=0.95,
            ),
            TranscriptSegment(
                start_time=10.5,
                end_time=19.5,
                text="Today we are going to talk about AI video editing.",
                confidence=0.92,
            ),
            TranscriptSegment(
                start_time=25.5,
                end_time=34.0,
                text="Thanks for watching, see you next time!",
                confidence=0.97,
            ),
        ],
        quality=QualityReport(
            silent_segments=[
                TimeRange(start=5.0, end=10.0),
                TimeRange(start=20.0, end=25.0),
            ],
            audio_energy=[-20.0, -60.0, -18.0, -55.0, -22.0],
            overall_silence_ratio=0.286,
        ),
    )


@pytest.fixture
def sample_engagement(sample_scenes: list[SceneInfo]) -> EngagementReport:
    """Engagement report matching sample_scenes."""
    scene_engagements = [
        SceneEngagement(scene_id=0, score=72.0, label="high"),
        SceneEngagement(scene_id=1, score=15.0, label="low"),
        SceneEngagement(scene_id=2, score=85.0, label="high"),
        SceneEngagement(scene_id=3, score=12.0, label="low"),
        SceneEngagement(scene_id=4, score=68.0, label="high"),
    ]
    return EngagementReport(
        scenes=scene_engagements,
        avg_score=50.4,
        high_count=3,
        low_count=2,
    )


@pytest.fixture
def sample_edit_dna() -> EditDNA:
    """A sample EditDNA for testing style operations."""
    return EditDNA(
        name="test-style",
        description="Test editing style",
        source="test_reference.mp4",
    )


@pytest.fixture
def cinematic_dna() -> EditDNA:
    """A cinematic-style EditDNA with non-default values."""
    from cutai.models.types import (
        AudioDNA,
        RhythmDNA,
        SubtitleDNA,
        TransitionDNA,
        VisualDNA,
    )

    return EditDNA(
        name="cinematic",
        description="Cinematic editing style",
        source="preset",
        rhythm=RhythmDNA(
            avg_cut_length=6.0,
            cut_length_variance=3.0,
            pacing_curve="slow-fast-slow",
            cuts_per_minute=6.0,
        ),
        transitions=TransitionDNA(
            jump_cut_ratio=0.5,
            fade_ratio=0.3,
            dissolve_ratio=0.15,
            wipe_ratio=0.05,
            avg_transition_duration=1.0,
        ),
        visual=VisualDNA(
            avg_brightness=-0.1,
            avg_saturation=0.8,
            avg_contrast=1.2,
            color_temperature="cool",
        ),
        audio=AudioDNA(
            has_bgm=True,
            bgm_volume_ratio=0.2,
            silence_tolerance=2.0,
            speech_ratio=0.4,
        ),
        subtitle=SubtitleDNA(
            has_subtitles=False,
            position="bottom",
            font_size_category="medium",
        ),
    )


@pytest.fixture
def sample_preferences() -> UserPreferences:
    """A UserPreferences with some history."""
    from cutai.models.types import FeedbackEntry, InstructionMemory

    return UserPreferences(
        preferred_style="cinematic",
        preferred_subtitle_position="bottom",
        preferred_color_preset="warm",
        preferred_bgm_mood="calm",
        avg_keep_ratio=0.65,
        instruction_history=[
            InstructionMemory(
                instruction="remove silence add subtitles",
                operations_summary=["cut:remove 3 scenes", "subtitle:bottom"],
                was_accepted=True,
                timestamp="2026-03-01T10:00:00+00:00",
            ),
            InstructionMemory(
                instruction="make it warm and cinematic",
                operations_summary=["colorgrade:warm", "subtitle:bottom"],
                was_accepted=True,
                timestamp="2026-03-02T14:00:00+00:00",
            ),
        ],
        feedback_history=[
            FeedbackEntry(
                instruction="remove silence",
                feedback="good",
                timestamp="2026-03-01T10:05:00+00:00",
            ),
        ],
    )
