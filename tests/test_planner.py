"""Tests for CutAI Edit Planner (cutai.planner.edit_planner).

Tests rule-based planning only — no LLM/API calls needed.
"""

from __future__ import annotations

import pytest

from cutai.models.types import (
    BGMOperation,
    ColorGradeOperation,
    CutOperation,
    EditPlan,
    SpeedOperation,
    SubtitleOperation,
    TransitionOperation,
    VideoAnalysis,
)
from cutai.planner.edit_planner import (
    _detect_bgm_mood,
    _estimate_duration,
    _matches_any,
    _trim_to_duration,
    _try_rule_based,
    create_edit_plan,
)


# ── Rule matching helpers ────────────────────────────────────────────────────


class TestMatchesAny:
    def test_exact_match(self):
        assert _matches_any("remove silence", ["remove silence"]) is True

    def test_substring_match(self):
        assert _matches_any("please remove silence from the video", ["remove silence"]) is True

    def test_no_match(self):
        assert _matches_any("add subtitles", ["remove silence"]) is False

    def test_multiple_patterns(self):
        assert _matches_any("무음 제거", ["remove silence", "무음 제거"]) is True

    def test_empty_patterns(self):
        assert _matches_any("anything", []) is False


class TestDetectBGMMood:
    def test_upbeat(self):
        assert _detect_bgm_mood("신나는 음악 넣어줘") == "upbeat"

    def test_calm(self):
        assert _detect_bgm_mood("잔잔한 bgm") == "calm"

    def test_dramatic(self):
        assert _detect_bgm_mood("dramatic background music") == "dramatic"

    def test_funny(self):
        assert _detect_bgm_mood("재밌는 음악") == "funny"

    def test_emotional(self):
        assert _detect_bgm_mood("감성적인 bgm") == "emotional"

    def test_default_calm(self):
        assert _detect_bgm_mood("add some music") == "calm"


# ── Silence removal ─────────────────────────────────────────────────────────


class TestRuleBasedSilenceRemoval:
    def test_remove_silence_english(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "remove silence")
        assert plan is not None
        cuts = [op for op in plan.operations if isinstance(op, CutOperation)]
        assert len(cuts) == 2  # 2 silent segments in sample data
        assert all(c.action == "remove" for c in cuts)

    def test_remove_silence_korean(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "무음 제거")
        assert plan is not None
        cuts = [op for op in plan.operations if isinstance(op, CutOperation)]
        assert len(cuts) == 2

    def test_cut_silence(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "cut silence from the video")
        assert plan is not None
        cuts = [op for op in plan.operations if isinstance(op, CutOperation)]
        assert len(cuts) == 2

    def test_silence_removal_timing(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "remove silence")
        assert plan is not None
        cuts = [op for op in plan.operations if isinstance(op, CutOperation)]
        # First silent segment: 5.0 - 10.0
        assert cuts[0].start_time == 5.0
        assert cuts[0].end_time == 10.0
        # Second silent segment: 20.0 - 25.0
        assert cuts[1].start_time == 20.0
        assert cuts[1].end_time == 25.0


# ── Subtitle rules ──────────────────────────────────────────────────────────


class TestRuleBasedSubtitles:
    def test_add_subtitles_english(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "add subtitles")
        assert plan is not None
        subs = [op for op in plan.operations if isinstance(op, SubtitleOperation)]
        assert len(subs) == 1
        assert subs[0].position == "bottom"

    def test_add_subtitles_korean(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "자막 추가")
        assert plan is not None
        subs = [op for op in plan.operations if isinstance(op, SubtitleOperation)]
        assert len(subs) == 1

    def test_center_position(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "add subtitles center")
        assert plan is not None
        subs = [op for op in plan.operations if isinstance(op, SubtitleOperation)]
        assert len(subs) == 1
        assert subs[0].position == "center"

    def test_top_position(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "add subtitles top")
        assert plan is not None
        subs = [op for op in plan.operations if isinstance(op, SubtitleOperation)]
        assert subs[0].position == "top"


# ── Color grading rules ─────────────────────────────────────────────────────


class TestRuleBasedColor:
    def test_bright(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "밝게 해줘")
        assert plan is not None
        colors = [op for op in plan.operations if isinstance(op, ColorGradeOperation)]
        assert len(colors) == 1
        assert colors[0].preset == "bright"

    def test_warm(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "make it warm")
        assert plan is not None
        colors = [op for op in plan.operations if isinstance(op, ColorGradeOperation)]
        assert colors[0].preset == "warm"

    def test_cinematic(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "cinematic look please")
        assert plan is not None
        colors = [op for op in plan.operations if isinstance(op, ColorGradeOperation)]
        assert colors[0].preset == "cinematic"

    def test_vintage(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "빈티지 느낌")
        assert plan is not None
        colors = [op for op in plan.operations if isinstance(op, ColorGradeOperation)]
        assert colors[0].preset == "vintage"

    def test_cool(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "차갑게")
        assert plan is not None
        colors = [op for op in plan.operations if isinstance(op, ColorGradeOperation)]
        assert colors[0].preset == "cool"

    def test_cool_tone_phrasing_mirrors_warm_tone(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "차가운 톤으로 색보정해줘")
        assert plan is not None
        colors = [op for op in plan.operations if isinstance(op, ColorGradeOperation)]
        assert colors[0].preset == "cool"


# ── BGM rules ────────────────────────────────────────────────────────────────


class TestRuleBasedBGM:
    def test_add_bgm(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "배경음악 넣어줘")
        assert plan is not None
        bgms = [op for op in plan.operations if isinstance(op, BGMOperation)]
        assert len(bgms) == 1

    def test_bgm_with_mood(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "신나는 bgm 추가")
        assert plan is not None
        bgms = [op for op in plan.operations if isinstance(op, BGMOperation)]
        assert bgms[0].mood == "upbeat"


# ── Speed rules ──────────────────────────────────────────────────────────────


class TestRuleBasedSpeed:
    def test_speed_korean(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "2배속으로")
        assert plan is not None
        speeds = [op for op in plan.operations if isinstance(op, SpeedOperation)]
        assert len(speeds) == 1
        assert speeds[0].factor == 2.0

    def test_speed_english(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "speed up the video")
        assert plan is not None
        speeds = [op for op in plan.operations if isinstance(op, SpeedOperation)]
        assert speeds[0].factor == 2.0

    def test_slow_motion(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "slow motion")
        assert plan is not None
        speeds = [op for op in plan.operations if isinstance(op, SpeedOperation)]
        assert speeds[0].factor == 0.5

    def test_custom_speed(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "1.5배속")
        assert plan is not None
        speeds = [op for op in plan.operations if isinstance(op, SpeedOperation)]
        assert speeds[0].factor == 1.5


# ── Transition rules ────────────────────────────────────────────────────────


class TestRuleBasedTransitions:
    def test_fade_transitions(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "add fade transitions")
        assert plan is not None
        trans = [op for op in plan.operations if isinstance(op, TransitionOperation)]
        assert len(trans) == 4  # 5 scenes = 4 transitions
        assert all(t.style == "fade" for t in trans)

    def test_dissolve(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "dissolve 트랜지션")
        assert plan is not None
        trans = [op for op in plan.operations if isinstance(op, TransitionOperation)]
        assert all(t.style == "dissolve" for t in trans)


# ── Trim to duration ────────────────────────────────────────────────────────


class TestTrimToDuration:
    def test_trim_not_needed(self, sample_analysis):
        """If video is shorter than target, no cuts."""
        ops = _trim_to_duration(sample_analysis, 120.0)
        assert ops == []

    def test_trim_removes_scenes(self, sample_analysis):
        """Trim to 20 seconds should remove some scenes."""
        ops = _trim_to_duration(sample_analysis, 20.0)
        assert len(ops) > 0
        assert all(isinstance(op, CutOperation) for op in ops)
        assert all(op.action == "remove" for op in ops)

    def test_trim_removes_lowest_priority(self, sample_analysis):
        """Silent scenes should be removed first."""
        ops = _trim_to_duration(sample_analysis, 25.0)
        removed_ids = set()
        for op in ops:
            # Find which scenes match these time ranges
            for scene in sample_analysis.scenes:
                if scene.start_time == op.start_time and scene.end_time == op.end_time:
                    removed_ids.add(scene.id)
        # Silent scenes (id=1, id=3) should be removed first
        assert 1 in removed_ids or 3 in removed_ids

    def test_trim_instruction_rule(self, sample_analysis):
        """Test the 'trim to X min' regex pattern."""
        plan = _try_rule_based(sample_analysis, "trim to 1 min")
        # 35s video, target 60s => no trimming needed
        # Actually the trim rule should match but produce no cuts
        # since the video is already shorter
        if plan is not None:
            cuts = [op for op in plan.operations if isinstance(op, CutOperation)]
            assert len(cuts) == 0


# ── Combined instructions ───────────────────────────────────────────────────


class TestCombinedInstructions:
    def test_silence_plus_subtitles(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "remove silence, add subtitles")
        assert plan is not None
        cuts = [op for op in plan.operations if isinstance(op, CutOperation)]
        subs = [op for op in plan.operations if isinstance(op, SubtitleOperation)]
        assert len(cuts) == 2
        assert len(subs) == 1

    def test_subtitle_plus_color(self, sample_analysis):
        plan = _try_rule_based(sample_analysis, "자막 넣고 따뜻하게")
        assert plan is not None
        subs = [op for op in plan.operations if isinstance(op, SubtitleOperation)]
        colors = [op for op in plan.operations if isinstance(op, ColorGradeOperation)]
        assert len(subs) == 1
        assert len(colors) == 1
        assert colors[0].preset == "warm"


# ── Estimate duration ────────────────────────────────────────────────────────


class TestEstimateDuration:
    def test_no_operations(self, sample_analysis):
        est = _estimate_duration(sample_analysis, [])
        assert est == 35.0

    def test_with_cuts(self, sample_analysis):
        ops = [
            CutOperation(action="remove", start_time=5.0, end_time=10.0),
            CutOperation(action="remove", start_time=20.0, end_time=25.0),
        ]
        est = _estimate_duration(sample_analysis, ops)
        assert est == 25.0  # 35 - 5 - 5

    def test_with_speed(self, sample_analysis):
        ops = [SpeedOperation(factor=2.0, start_time=0, end_time=35)]
        est = _estimate_duration(sample_analysis, ops)
        assert est == 17.5  # 35 / 2

    def test_cuts_and_speed(self, sample_analysis):
        ops = [
            CutOperation(action="remove", start_time=5.0, end_time=10.0),
            SpeedOperation(factor=2.0, start_time=0, end_time=35),
        ]
        est = _estimate_duration(sample_analysis, ops)
        assert est == 15.0  # (35 - 5) / 2


# ── create_edit_plan (no LLM) ───────────────────────────────────────────────


class TestCreateEditPlan:
    def test_rule_based_no_llm(self, sample_analysis):
        plan = create_edit_plan(sample_analysis, "remove silence", use_llm=False)
        assert isinstance(plan, EditPlan)
        assert plan.instruction == "remove silence"
        assert len(plan.operations) > 0

    def test_no_matching_rule(self, sample_analysis):
        plan = create_edit_plan(
            sample_analysis,
            "do something very unusual and specific",
            use_llm=False,
        )
        # Should return None from rules, then minimal plan
        assert isinstance(plan, EditPlan)

    def test_unrecognized_returns_plan(self, sample_analysis):
        """Unrecognized instructions without LLM return a minimal plan."""
        plan = create_edit_plan(
            sample_analysis,
            "xyzzy",
            use_llm=False,
        )
        assert isinstance(plan, EditPlan)
