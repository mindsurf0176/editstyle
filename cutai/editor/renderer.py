"""Render pipeline — orchestrates all edit operations into a final video.

Pipeline order:
1. Cut (segment extraction + concat)
2. Speed adjustments
3. Color grading
4. BGM mixing
5. Subtitles (ASS generation — sidecar or burn)
6. Transitions (applied during concat step)

This is the main entry point for applying an EditPlan to a video.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from pathlib import Path

from cutai.models.types import (
    BGMOperation,
    ColorGradeOperation,
    CutOperation,
    EditPlan,
    SpeedOperation,
    SubtitleOperation,
    TranscriptSegment,
    TransitionOperation,
    VideoAnalysis,
)

logger = logging.getLogger(__name__)


def validate_render_plan(plan: EditPlan, analysis: VideoAnalysis) -> None:
    """Reject combinations whose source timestamps cannot yet be rendered correctly."""
    cuts = [op for op in plan.operations if isinstance(op, CutOperation)]
    speeds = [op for op in plan.operations if isinstance(op, SpeedOperation)]
    subtitles = any(isinstance(op, SubtitleOperation) for op in plan.operations)
    transitions = any(
        isinstance(op, TransitionOperation) and op.style != "cut" for op in plan.operations
    )
    if subtitles and not analysis.transcript:
        raise ValueError("Subtitles require a transcript. Analyze with transcription first.")
    if speeds and (cuts or subtitles or transitions or len(speeds) > 1):
        raise ValueError(
            "Speed changes cannot yet be combined with cuts, subtitles, transitions, "
            "or another speed change. Render the speed change separately first."
        )
    if subtitles and transitions:
        raise ValueError(
            "Subtitles and transitions cannot yet be combined because transitions change "
            "subtitle timing. Render these edits separately."
        )
    if cuts and not _kept_timeline(cuts, analysis.duration):
        raise ValueError("The cut plan removes the entire video. Keep at least one segment.")


def render(
    video_path: str,
    plan: EditPlan,
    analysis: VideoAnalysis,
    output_path: str,
    burn_subtitles: bool = True,
    bgm_file: str | None = None,
) -> str:
    """Apply an edit plan and render the final video.

    Pipeline:
    1. Apply CutOperations (segment extraction + concat)
    2. Apply SpeedOperations (playback speed adjustment)
    3. Apply ColorGradeOperations (color grading filters)
    4. Apply BGMOperations (background music mixing)
    5. Apply SubtitleOperations (generate ASS — sidecar or burn)
    6. Apply TransitionOperations (xfade between scenes)

    Args:
        video_path: Path to the source video.
        plan: The edit plan to apply.
        analysis: Video analysis (needed for transcript data).
        output_path: Path for the final output video.
        burn_subtitles: If True (default), burn subtitles into video.
            If False, save .ass file as sidecar next to output instead.
        bgm_file: Optional path to a BGM audio file to use.

    Returns:
        Path to the rendered output video.
    """
    validate_render_plan(plan, analysis)

    # Ensure output directory exists
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    # Separate operations by type
    cut_ops = [op for op in plan.operations if isinstance(op, CutOperation)]
    speed_ops = [op for op in plan.operations if isinstance(op, SpeedOperation)]
    color_ops = [op for op in plan.operations if isinstance(op, ColorGradeOperation)]
    bgm_ops = [op for op in plan.operations if isinstance(op, BGMOperation)]
    sub_ops = [op for op in plan.operations if isinstance(op, SubtitleOperation)]
    trans_ops = [op for op in plan.operations if isinstance(op, TransitionOperation)]

    total_steps = sum([
        bool(cut_ops),
        bool(speed_ops),
        bool(color_ops),
        bool(bgm_ops),
        bool(sub_ops),
        bool(trans_ops),
    ])
    step_num = 0

    current_video = video_path

    with tempfile.TemporaryDirectory(prefix="cutai_render_") as tmpdir:

        # ── Step 1: Apply cuts ───────────────────────────────────────────
        if cut_ops:
            from cutai.editor.cutter import apply_cuts

            step_num += 1
            cut_output = str(Path(tmpdir) / "step1_cut.mp4")
            logger.info(
                "Step %d/%d: Applying %d cut operations...",
                step_num, total_steps, len(cut_ops),
            )
            current_video = apply_cuts(current_video, cut_ops, cut_output)
        else:
            logger.info("Cuts: skipped (none)")

        # ── Step 2: Apply speed adjustments ──────────────────────────────
        if speed_ops:
            from cutai.editor.speed import apply_speed

            step_num += 1
            for i, speed_op in enumerate(speed_ops):
                speed_output = str(Path(tmpdir) / f"step2_speed_{i}.mp4")
                logger.info(
                    "Step %d/%d: Applying speed ×%.2f...",
                    step_num, total_steps, speed_op.factor,
                )
                current_video = apply_speed(current_video, speed_op, speed_output)

        else:
            logger.info("Speed: skipped (none)")

        # ── Step 3: Apply color grading ──────────────────────────────────
        if color_ops:
            from cutai.editor.color import apply_color_grade

            step_num += 1
            # Apply only the first color grade operation (stacking is rare)
            color_op = color_ops[0]
            color_output = str(Path(tmpdir) / "step3_color.mp4")
            logger.info(
                "Step %d/%d: Applying color grade (preset=%s, intensity=%.0f)...",
                step_num, total_steps, color_op.preset, color_op.intensity,
            )
            current_video = apply_color_grade(
                current_video, color_op, color_output,
            )
        else:
            logger.info("Color grade: skipped (none)")

        # ── Step 4: Apply BGM ────────────────────────────────────────────
        if bgm_ops:
            from cutai.editor.bgm import apply_bgm

            step_num += 1
            bgm_op = bgm_ops[0]
            bgm_output = str(Path(tmpdir) / "step4_bgm.mp4")
            logger.info(
                "Step %d/%d: Mixing BGM (mood=%s, vol=%d%%)...",
                step_num, total_steps, bgm_op.mood, bgm_op.volume,
            )
            current_video = apply_bgm(
                current_video, bgm_op, bgm_output, bgm_file=bgm_file,
            )
        else:
            logger.info("BGM: skipped (none)")

        # ── Step 5: Apply subtitles ──────────────────────────────────────
        if sub_ops and analysis.transcript:
            from cutai.editor.subtitle import burn_subtitles as _burn_subs
            from cutai.editor.subtitle import generate_ass

            step_num += 1
            sub_op = sub_ops[0]

            # If cuts were applied, adjust transcript timestamps
            transcript = analysis.transcript
            if cut_ops:
                transcript = _adjust_transcript_for_cuts(
                    analysis.transcript, cut_ops, analysis.duration,
                )

            if burn_subtitles:
                ass_path = str(Path(tmpdir) / "subtitles.ass")
                generate_ass(transcript, ass_path, sub_op)

                logger.info(
                    "Step %d/%d: Burning subtitles into video...",
                    step_num, total_steps,
                )
                sub_output = str(Path(tmpdir) / "step5_subs.mp4")
                current_video = _burn_subs(current_video, ass_path, sub_output)
            else:
                sidecar_path = str(Path(output_path).with_suffix(".ass"))
                generate_ass(transcript, sidecar_path, sub_op)
                logger.info(
                    "Step %d/%d: Subtitles saved as sidecar: %s",
                    step_num, total_steps, sidecar_path,
                )
        else:
            logger.info("Subtitles: skipped (none or no transcript)")

        # ── Step 6: Apply transitions ────────────────────────────────────
        if trans_ops:
            from cutai.editor.transition import apply_transitions

            step_num += 1
            # Compute cut points from the current state of the video.
            # Use scene boundaries from analysis, adjusted for any cuts.
            cut_points = _compute_cut_points(analysis, cut_ops)
            if cut_points:
                trans_output = str(Path(tmpdir) / "step6_trans.mp4")
                logger.info(
                    "Step %d/%d: Applying %d transitions...",
                    step_num, total_steps, len(trans_ops),
                )
                current_video = apply_transitions(
                    current_video, _remap_transitions(analysis, cut_ops, trans_ops),
                    cut_points, trans_output,
                )
            else:
                logger.info("Transitions: skipped (no cut points)")
        else:
            logger.info("Transitions: skipped (none)")

        # ── Final: copy to output ────────────────────────────────────────
        if current_video != output_path:
            shutil.copy2(current_video, output_path)

    logger.info("✅ Render complete → %s", output_path)
    return output_path


def _kept_timeline(
    cut_ops: list[CutOperation], duration: float,
) -> list[tuple[float, float, float]]:
    """Return (source start, source end, output start) using the cutter's ranges."""
    from cutai.editor.cutter import _compute_keep_ranges

    timeline: list[tuple[float, float, float]] = []
    output_start = 0.0
    for start, end in _compute_keep_ranges(cut_ops, duration):
        if end <= start:
            continue
        timeline.append((start, end, output_start))
        output_start += end - start
    return timeline


def _retained_scene_spans(
    analysis: VideoAnalysis, cut_ops: list[CutOperation],
) -> list[tuple[int, float]]:
    """Map retained source scene IDs to the end of each output segment."""
    spans: list[tuple[int, float]] = []
    for keep_start, keep_end, output_start in _kept_timeline(cut_ops, analysis.duration):
        for scene in analysis.scenes:
            start = max(scene.start_time, keep_start)
            end = min(scene.end_time, keep_end)
            if end > start:
                spans.append((scene.id, round(output_start + end - keep_start, 3)))
    return spans


def _compute_cut_points(
    analysis: VideoAnalysis, cut_ops: list[CutOperation],
) -> list[float]:
    """Return retained scene boundaries and joins between disjoint kept ranges."""
    return [end for _, end in _retained_scene_spans(analysis, cut_ops)[:-1]]


def _remap_transitions(
    analysis: VideoAnalysis,
    cut_ops: list[CutOperation],
    transitions: list[TransitionOperation],
) -> list[TransitionOperation]:
    """Translate source scene IDs into adjacent segment indices after cutting."""
    scene_ids = [scene_id for scene_id, _ in _retained_scene_spans(analysis, cut_ops)]
    mapped: list[TransitionOperation] = []
    for index, pair in enumerate(zip(scene_ids, scene_ids[1:], strict=False)):
        for transition in transitions:
            if transition.between == pair:
                mapped.append(transition.model_copy(update={"between": (index, index + 1)}))
    return mapped


def _adjust_transcript_for_cuts(
    transcript: list[TranscriptSegment],
    cut_ops: list[CutOperation],
    duration: float | None = None,
) -> list[TranscriptSegment]:
    """Clip captions to every kept interval and map them onto the edited timeline."""
    if not cut_ops:
        return transcript
    if duration is None:
        duration = max(
            [seg.end_time for seg in transcript] + [op.end_time for op in cut_ops],
            default=0.0,
        )
    adjusted: list[TranscriptSegment] = []
    for keep_start, keep_end, output_start in _kept_timeline(cut_ops, duration):
        for segment in transcript:
            start = max(segment.start_time, keep_start)
            end = min(segment.end_time, keep_end)
            if end - start < 0.05:
                continue
            adjusted.append(
                segment.model_copy(update={
                    "start_time": round(output_start + start - keep_start, 3),
                    "end_time": round(output_start + end - keep_start, 3),
                })
            )
    return adjusted
