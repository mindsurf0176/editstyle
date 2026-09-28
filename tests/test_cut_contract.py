"""Source-time interval contract shared with desktop/src/timeline.test.ts."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

import cutai.editor.cutter as cutter
from cutai.editor.renderer import _kept_timeline, render, validate_render_plan
from cutai.models.types import CutOperation, EditPlan, SpeedOperation

# Keep these behavioral cases aligned with the TypeScript contract table.
CUT_CASES = [
    ("no cuts", [], [(0, 36)]),
    ("one keep", [("keep", 6, 18)], [(6, 18)]),
    ("one remove", [("remove", 6, 12)], [(0, 6), (12, 36)]),
    ("mixed", [("keep", 0, 18), ("remove", 6, 12)], [(0, 6), (12, 18)]),
    ("mixed reverse order", [("remove", 6, 12), ("keep", 0, 18)], [(0, 6), (12, 18)]),
    ("overlapping keeps", [("keep", 8, 18), ("keep", 2, 12)], [(2, 18)]),
    ("adjacent keeps", [("keep", 6, 12), ("keep", 0, 6)], [(0, 12)]),
    ("overlapping removes", [("remove", 8, 18), ("remove", 2, 12)], [(0, 2), (18, 36)]),
    ("adjacent removes", [("remove", 6, 12), ("remove", 0, 6)], [(12, 36)]),
    ("outside keep", [("keep", 6, 18), ("remove", 24, 36)], [(6, 18)]),
    ("touching keep", [("keep", 6, 18), ("remove", 0, 6), ("remove", 18, 36)], [(6, 18)]),
    ("remove spanning keeps", [("keep", 2, 8), ("keep", 12, 20), ("remove", 6, 15)], [(2, 6), (15, 20)]),
    ("remove contains keep", [("keep", 6, 18), ("remove", 0, 24)], []),
    ("all removed", [("remove", 0, 36)], []),
    ("keep then all removed", [("keep", 0, 36), ("remove", 0, 36)], []),
    ("duplicates", [("keep", 0, 18), ("keep", 0, 18), ("remove", 6, 12), ("remove", 6, 12)], [(0, 6), (12, 18)]),
]


@pytest.mark.parametrize("name,specs,expected", CUT_CASES, ids=[case[0] for case in CUT_CASES])
def test_source_time_cut_contract(name, specs, expected):
    operations = [CutOperation(action=action, start_time=start, end_time=end)
                  for action, start, end in specs]
    original = [op.model_dump() for op in operations]
    assert cutter._compute_keep_ranges(operations, 36) == expected
    assert [op.model_dump() for op in operations] == original
    timeline = _kept_timeline(operations, 36)
    assert [(start, end) for start, end, _ in timeline] == expected
    assert [offset for _, _, offset in timeline] == [
        sum(end - start for start, end in expected[:index]) for index in range(len(expected))
    ]


INVALID_RANGES = [
    (-1, 6), (6, 6), (12, 6), (30, 50), (36, 40),
    (float("nan"), 6), (0, float("nan")),
    (float("inf"), 36), (0, float("inf")), (float("-inf"), 6),
]


@pytest.mark.parametrize("action", ["keep", "remove"])
@pytest.mark.parametrize("start,end", INVALID_RANGES)
def test_invalid_source_interval_is_rejected_even_when_another_cut_hides_it(action, start, end):
    invalid = CutOperation.model_construct(action=action, start_time=start, end_time=end)
    operations = [CutOperation(action="remove", start_time=0, end_time=36), invalid]
    with pytest.raises(ValueError, match="Cut ranges must be finite"):
        cutter._compute_keep_ranges(operations, 36)


@pytest.mark.parametrize("duration", [0, -1, float("nan"), float("inf"), float("-inf")])
@pytest.mark.parametrize("with_cuts", [False, True])
def test_invalid_duration_is_rejected_even_without_cuts(duration, with_cuts):
    cuts = [CutOperation(action="keep", start_time=0, end_time=1)] if with_cuts else []
    with pytest.raises(ValueError, match="Source duration"):
        cutter._compute_keep_ranges(cuts, duration)


def test_unknown_cut_action_is_rejected():
    invalid = CutOperation.model_construct(action="trim", start_time=0, end_time=10)
    with pytest.raises(ValueError, match="Cut action"):
        cutter._compute_keep_ranges([invalid], 36)


@pytest.mark.parametrize("operations,duration,error", [
    ([CutOperation(action="remove", start_time=0, end_time=36)], 36, "entire video"),
    ([CutOperation(action="keep", start_time=30, end_time=50)], 36, "Cut ranges"),
    ([], 0, "Source duration"),
    ([], float("inf"), "Source duration"),
])
def test_direct_cut_rejects_invalid_output_before_encoding(
    monkeypatch, tmp_path, operations, duration, error,
):
    monkeypatch.setattr(cutter, "_get_duration", lambda path: duration)
    encode = Mock(side_effect=AssertionError("Encoding must not start"))
    monkeypatch.setattr(cutter, "ensure_ffmpeg", encode)
    output = tmp_path / "not-created.mp4"
    with pytest.raises(ValueError, match=error):
        cutter.apply_cuts("unused.mp4", operations, str(output))
    encode.assert_not_called()
    assert not output.exists()


@pytest.mark.parametrize("start,end", INVALID_RANGES)
def test_speed_source_range_is_validated_before_render(sample_analysis, tmp_path, start, end):
    speed = SpeedOperation.model_construct(factor=2, start_time=start, end_time=end)
    plan = EditPlan(instruction="speed", operations=[speed])
    output = tmp_path / "not-created" / "video.mp4"
    with pytest.raises(ValueError, match="Speed ranges"):
        render("unused.mp4", plan, sample_analysis, str(output))
    assert not output.parent.exists()


@pytest.mark.parametrize("factor", [0, -1, float("nan"), float("inf"), float("-inf")])
def test_speed_factor_must_be_finite_and_positive(sample_analysis, factor):
    speed = SpeedOperation.model_construct(factor=factor, start_time=0, end_time=35)
    plan = EditPlan(instruction="speed", operations=[speed])
    with pytest.raises(ValueError, match="Speed factor"):
        validate_render_plan(plan, sample_analysis)


@pytest.mark.parametrize("duration", [0, -1, float("nan"), float("inf")])
def test_render_rejects_invalid_source_duration_without_edits(sample_analysis, tmp_path, duration):
    analysis = sample_analysis.model_copy(update={"duration": duration})
    output = tmp_path / "not-created" / "video.mp4"
    with pytest.raises(ValueError, match="Source duration"):
        render("unused.mp4", EditPlan(instruction="copy"), analysis, str(output))
    assert not output.parent.exists()
