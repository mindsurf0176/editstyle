"""Tests for transcript timestamp adjustment during rendering."""

from __future__ import annotations

import asyncio
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

import cutai.server as server
from cutai.editor.renderer import (
    _adjust_transcript_for_cuts,
    _compute_cut_points,
    _remap_transitions,
    render,
    validate_render_plan,
)
from cutai.models.types import (
    CutOperation,
    EditPlan,
    SpeedOperation,
    SubtitleOperation,
    TranscriptSegment,
    TransitionOperation,
    VideoAnalysis,
)


class TestAdjustTranscriptForCuts:
    def test_keeps_partially_overlapping_segment_at_start(self):
        transcript = [
            TranscriptSegment(start_time=0.0, end_time=2.0, text="Alphabravo"),
            TranscriptSegment(start_time=2.0, end_time=3.0, text="Charlie Delta"),
        ]
        cut_ops = [
            CutOperation(action="remove", start_time=0.831, end_time=2.072),
        ]

        adjusted = _adjust_transcript_for_cuts(transcript, cut_ops)

        assert [seg.text for seg in adjusted] == ["Alphabravo", "Charlie Delta"]
        assert adjusted[0].start_time == 0.0
        assert adjusted[0].end_time == 0.831
        assert adjusted[1].start_time == 0.831
        assert adjusted[1].end_time == 1.759

    @pytest.mark.parametrize("cuts", [
        [CutOperation(action="keep", start_time=6, end_time=12)],
        [CutOperation(action="remove", start_time=0, end_time=6),
         CutOperation(action="remove", start_time=12, end_time=20)],
    ])
    def test_keep_and_remove_forms_exclude_removed_speech_and_shift_retained_speech(self, cuts):
        transcript = [
            TranscriptSegment(start_time=0, end_time=4, text="removed before"),
            TranscriptSegment(start_time=5, end_time=8, text="retained beginning"),
            TranscriptSegment(start_time=10, end_time=14, text="retained ending"),
            TranscriptSegment(start_time=15, end_time=20, text="removed after"),
        ]
        adjusted = _adjust_transcript_for_cuts(transcript, cuts, 20)
        assert [(seg.text, seg.start_time, seg.end_time) for seg in adjusted] == [
            ("retained beginning", 0, 2), ("retained ending", 4, 6),
        ]

    def test_caption_crossing_separated_keeps_is_split_at_the_join(self):
        transcript = [TranscriptSegment(start_time=1, end_time=9, text="crosses cut")]
        cuts = [CutOperation(action="keep", start_time=0, end_time=3),
                CutOperation(action="keep", start_time=7, end_time=10)]
        adjusted = _adjust_transcript_for_cuts(transcript, cuts, 10)
        assert [(seg.start_time, seg.end_time) for seg in adjusted] == [(1, 3), (3, 5)]

    def test_overlapping_removals_are_not_counted_twice(self):
        transcript = [TranscriptSegment(start_time=8, end_time=10, text="last")]
        cuts = [CutOperation(action="remove", start_time=0, end_time=4),
                CutOperation(action="remove", start_time=2, end_time=6)]
        adjusted = _adjust_transcript_for_cuts(transcript, cuts, 10)
        assert [(seg.start_time, seg.end_time) for seg in adjusted] == [(2, 4)]


def test_transition_times_and_scene_ids_follow_kept_scene_spans(sample_analysis):
    cuts = [CutOperation(action="keep", start_time=6, end_time=12)]
    transitions = [
        TransitionOperation(between=(0, 1)),
        TransitionOperation(between=(1, 2)),
        TransitionOperation(between=(2, 3)),
    ]
    assert _compute_cut_points(sample_analysis, cuts) == [4]
    mapped = _remap_transitions(sample_analysis, cuts, transitions)
    assert [op.between for op in mapped] == [(0, 1)]
    assert transitions[1].between == (1, 2)


def test_transition_join_between_disjoint_keeps_maps_source_scene_ids(sample_analysis):
    cuts = [CutOperation(action="keep", start_time=1, end_time=3),
            CutOperation(action="keep", start_time=12, end_time=18)]
    assert _compute_cut_points(sample_analysis, cuts) == [2]
    mapped = _remap_transitions(sample_analysis, cuts, [TransitionOperation(between=(0, 2))])
    assert [op.between for op in mapped] == [(0, 1)]


INVALID_TIMING_OPERATIONS = [
    [SpeedOperation(factor=2, start_time=0, end_time=35),
     CutOperation(action="keep", start_time=6, end_time=12)],
    [SpeedOperation(factor=2, start_time=0, end_time=35), SubtitleOperation()],
    [SpeedOperation(factor=2, start_time=0, end_time=35), TransitionOperation(between=(0, 1))],
    [SpeedOperation(factor=2, start_time=0, end_time=35),
     SpeedOperation(factor=0.5, start_time=0, end_time=35)],
    [SubtitleOperation(), TransitionOperation(between=(0, 1))],
]


@pytest.mark.parametrize("operations", INVALID_TIMING_OPERATIONS)
@pytest.mark.parametrize("endpoint", ["/api/preview", "/api/render"])
def test_media_api_rejects_unsupported_timing_before_creating_job(
    monkeypatch, sample_analysis, operations, endpoint,
):
    monkeypatch.setattr(server, "jobs", {})
    monkeypatch.setattr(server, "videos", {
        "video": {"path": "unused.mp4", "analysis": sample_analysis.model_dump()},
    })
    plan = EditPlan(instruction="mixed", operations=operations, estimated_duration=12, summary="mixed")
    response = TestClient(server.app).post(endpoint, json={"video_id": "video", "plan": plan.model_dump()})
    assert response.status_code == 422
    assert "cannot yet be combined" in response.json()["detail"]
    assert server.jobs == {}


@pytest.mark.parametrize("endpoint", ["/api/preview", "/api/render"])
def test_media_api_rejects_subtitles_without_transcript(monkeypatch, sample_analysis, endpoint):
    sample_analysis.transcript = []
    monkeypatch.setattr(server, "jobs", {})
    monkeypatch.setattr(server, "videos", {
        "video": {"path": "unused.mp4", "analysis": sample_analysis.model_dump()},
    })
    plan = EditPlan(instruction="subtitles", operations=[SubtitleOperation()], estimated_duration=35)
    response = TestClient(server.app).post(endpoint, json={"video_id": "video", "plan": plan.model_dump()})
    assert response.status_code == 422
    assert "transcript" in response.json()["detail"]
    assert server.jobs == {}


def test_direct_render_rejects_missing_transcript_before_output_creation(sample_analysis, tmp_path):
    sample_analysis.transcript = []
    plan = EditPlan(instruction="subtitles", operations=[SubtitleOperation()], estimated_duration=35)
    output = tmp_path / "not-created" / "video.mp4"
    with pytest.raises(ValueError, match="transcript"):
        render("unused.mp4", plan, sample_analysis, str(output))
    assert not output.parent.exists()


def test_single_speed_change_remains_supported(sample_analysis):
    plan = EditPlan(instruction="speed", operations=[
        SpeedOperation(factor=2, start_time=0, end_time=35),
    ], estimated_duration=17.5)
    validate_render_plan(plan, sample_analysis)


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg required")
@pytest.mark.parametrize("pipeline", ["direct", "server"])
def test_kept_captions_are_written_at_output_times_in_actual_sidecar(
    monkeypatch, tmp_path, pipeline,
):
    source = tmp_path / "source.mp4"
    output = tmp_path / "edited.mp4"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "testsrc2=size=160x90:rate=24:duration=6", "-c:v", "libx264", str(source),
    ], check=True, capture_output=True, timeout=30)
    analysis = VideoAnalysis(
        file_path=str(source), duration=6, fps=24, width=160, height=90,
        transcript=[
            TranscriptSegment(start_time=0, end_time=1, text="discard-before"),
            TranscriptSegment(start_time=1, end_time=3, text="retained-first"),
            TranscriptSegment(start_time=3, end_time=4, text="discard-middle"),
            TranscriptSegment(start_time=4, end_time=6, text="retained-second"),
        ],
    )
    plan = EditPlan(instruction="cut and caption", operations=[
        CutOperation(action="keep", start_time=1, end_time=3),
        CutOperation(action="keep", start_time=4, end_time=6),
        SubtitleOperation(),
    ], estimated_duration=4)
    if pipeline == "direct":
        render(str(source), plan, analysis, str(output), burn_subtitles=False)
    else:
        monkeypatch.setattr(server, "jobs", {})
        job_id = server._create_job("render")
        asyncio.run(server._run_render(
            job_id, str(source), analysis.model_dump(), plan.model_dump(),
            str(output), "balanced", "sidecar", None,
        ))
        assert server.jobs[job_id]["status"] == "completed", server.jobs[job_id]
    sidecar = output.with_suffix(".ass").read_text()
    assert "discard-" not in sidecar
    assert "0:00:00.00,0:00:02.00" in sidecar
    assert "0:00:02.00,0:00:04.00" in sidecar
    assert "retained-first" in sidecar
    assert "retained-second" in sidecar
    assert output.stat().st_size > 0
