"""CutAI Multi-Reel Generator — Generate multiple distinct reels from one video.

Splits a video into non-overlapping time segments, runs engagement analysis
on each segment, and generates the best highlight reel from each segment.
Each reel covers a different part of the video for variety.

Usage:
    cutai reels video.mp4 --count 3 --duration 60
    cutai reels video.mp4 -n 5 -d 90 -o reels/
    cutai reels video.mp4 -n 4 -d 60 --style cinematic
"""

from __future__ import annotations

import logging
import math
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from cutai.models.types import CutOperation, EditOperation, EditPlan

if TYPE_CHECKING:
    from cutai.models.types import EngagementReport, SceneInfo, VideoAnalysis

logger = logging.getLogger(__name__)


@dataclass
class ReelSpec:
    """Specification for a single reel to generate."""

    index: int
    segment_start: float
    segment_end: float
    output_path: str
    target_duration: float


def generate_reels(
    video_path: str,
    analysis: VideoAnalysis,
    engagement: EngagementReport,
    count: int = 3,
    target_duration: float = 60.0,
    output_dir: str = "reels",
    min_scene_duration: float = 1.0,
    burn_subtitles: bool = True,
) -> list[dict]:
    """Generate multiple distinct highlight reels from a single video.

    The video is divided into ``count`` non-overlapping time segments.
    Each segment is analyzed for engagement, and the best highlight reel
    is generated from each segment.

    Args:
        video_path: Path to the source video.
        analysis: Full video analysis.
        engagement: Engagement scores for all scenes.
        count: Number of reels to generate.
        target_duration: Target duration per reel in seconds.
        output_dir: Directory to save reel files.
        min_scene_duration: Minimum scene duration to consider.
        burn_subtitles: Whether to burn subtitles into the output.

    Returns:
        List of dicts with reel info (path, plan, duration, scenes).
    """
    video_stem = Path(video_path).stem
    reel_dir = Path(output_dir) / video_stem
    reel_dir.mkdir(parents=True, exist_ok=True)

    score_map: dict[int, float] = {
        se.scene_id: se.score for se in engagement.scenes
    }

    scenes = [s for s in analysis.scenes if s.duration >= min_scene_duration]
    if not scenes:
        scenes = list(analysis.scenes)

    scenes = _fill_scene_gaps(scenes, analysis.duration)
    scenes = _ensure_enough_scenes(scenes, count)

    specs = _split_into_reel_specs(
        scenes, count, target_duration, video_path, str(reel_dir),
    )

    segment_map = _assign_scenes_to_segments(scenes, specs)

    results = []
    for spec in specs:
        logger.info(
            "Reel %d/%d: segment %.1f–%.1fs, target %.1fs",
            spec.index + 1, len(specs),
            spec.segment_start, spec.segment_end, spec.target_duration,
        )

        segment_scenes = segment_map.get(spec.index, [])

        if not segment_scenes:
            logger.warning("Reel %d: no scenes in segment, skipping", spec.index + 1)
            continue

        segment_score_map = {
            s.id: score_map.get(s.id, 0) for s in segment_scenes
        }

        kept = _strategy_best_moments(segment_scenes, segment_score_map, spec.target_duration)

        operations: list[EditOperation] = [
            CutOperation(
                action="keep",
                start_time=s.start_time,
                end_time=s.end_time,
                reason=f"Engagement: {segment_score_map.get(s.id, 0):.0f}",
            )
            for s in kept
        ]

        estimated = sum(s.duration for s in kept)

        edit_plan = EditPlan(
            instruction=f"Reel {spec.index + 1} of {count}",
            operations=operations,
            estimated_duration=round(estimated, 2),
            summary=(
                f"Reel {spec.index + 1}: {len(kept)} scenes from "
                f"{format_time(spec.segment_start)}–{format_time(spec.segment_end)}, "
                f"{estimated:.1f}s (target {spec.target_duration:.0f}s)"
            ),
        )

        results.append({
            "index": spec.index,
            "output_path": spec.output_path,
            "plan": edit_plan,
            "estimated_duration": estimated,
            "scene_count": len(kept),
            "segment_start": spec.segment_start,
            "segment_end": spec.segment_end,
        })

    return results


def generate_reel_plans_only(
    analysis: VideoAnalysis,
    engagement: EngagementReport,
    count: int = 3,
    target_duration: float = 60.0,
    min_scene_duration: float = 1.0,
) -> list[EditPlan]:
    """Generate edit plans for multiple reels without rendering.

    Useful for previewing what each reel would look like before committing
    to a full render.

    Args:
        analysis: Full video analysis.
        engagement: Engagement scores for all scenes.
        count: Number of reels.
        target_duration: Target duration per reel in seconds.
        min_scene_duration: Minimum scene duration to consider.

    Returns:
        List of EditPlan objects, one per reel.
    """
    score_map: dict[int, float] = {
        se.scene_id: se.score for se in engagement.scenes
    }

    scenes = [s for s in analysis.scenes if s.duration >= min_scene_duration]
    if not scenes:
        scenes = list(analysis.scenes)

    scenes = _fill_scene_gaps(scenes, analysis.duration)
    scenes = _ensure_enough_scenes(scenes, count)

    specs = _split_into_reel_specs(scenes, count, target_duration, "", "")
    segment_map = _assign_scenes_to_segments(scenes, specs)

    plans = []
    for spec in specs:
        segment_scenes = segment_map.get(spec.index, [])

        if not segment_scenes:
            continue

        segment_score_map = {
            s.id: score_map.get(s.id, 0) for s in segment_scenes
        }

        kept = _strategy_best_moments(segment_scenes, segment_score_map, spec.target_duration)
        estimated = sum(s.duration for s in kept)

        plans.append(EditPlan(
            instruction=f"Reel {spec.index + 1} of {count}",
            operations=[
                CutOperation(
                    action="keep",
                    start_time=s.start_time,
                    end_time=s.end_time,
                    reason=f"Engagement: {segment_score_map.get(s.id, 0):.0f}",
                )
                for s in kept
            ],
            estimated_duration=round(estimated, 2),
            summary=(
                f"Reel {spec.index + 1}: {len(kept)} scenes from "
                f"{format_time(spec.segment_start)}–{format_time(spec.segment_end)}, "
                f"{estimated:.1f}s"
            ),
        ))

    return plans


def suggest_reel_count(duration: float) -> int:
    """Suggest how many reels to generate based on video duration.

    Rules:
        - <5 min:   2-3 reels
        - 5-15 min: 3-4 reels
        - 15-30 min: 4-6 reels
        - 30-60 min: 5-8 reels
        - >60 min:  8-12 reels
    """
    if duration < 300:
        return 3
    elif duration < 900:
        return 4
    elif duration < 1800:
        return 5
    elif duration < 3600:
        return 7
    else:
        return 10


def suggest_reel_duration(total_duration: float, count: int | None = None) -> float:
    """Suggest per-reel duration based on total video length and reel count.

    Each reel targets roughly equal segments of the video, capped at 120s.
    """
    if count is None:
        count = suggest_reel_count(total_duration)

    segment_duration = total_duration / count
    return max(30.0, min(120.0, segment_duration * 0.4))


def format_time(seconds: float) -> str:
    """Format seconds as M:SS."""
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m}:{s:02d}"


def _fill_scene_gaps(
    scenes: list[SceneInfo],
    total_duration: float,
) -> list[SceneInfo]:
    """Fill gaps in the scene list so the entire video timeline is covered.

    Scene detectors sometimes miss content (e.g. slow static video).
    This ensures the full video duration is represented in the scene list
    so reels can be generated from every part of the video.
    """
    if not scenes:
        return [SceneInfo(
            id=0, start_time=0.0, end_time=total_duration,
            duration=total_duration,
        )]

    filled: list[SceneInfo] = []
    next_id = 0

    for scene in scenes:
        if filled:
            last_end = filled[-1].end_time
            if scene.start_time > last_end + 0.5:
                gap_duration = scene.start_time - last_end
                filled.append(SceneInfo(
                    id=next_id,
                    start_time=last_end,
                    end_time=scene.start_time,
                    duration=gap_duration,
                    is_silent=True,
                ))
                next_id += 1

        filled.append(SceneInfo(
            id=next_id,
            start_time=scene.start_time,
            end_time=scene.end_time,
            duration=scene.duration,
            has_speech=scene.has_speech,
            is_silent=scene.is_silent,
            transcript=scene.transcript,
            avg_energy=scene.avg_energy,
        ))
        next_id += 1

    last_end = filled[-1].end_time
    if total_duration > last_end + 0.5:
        filled.append(SceneInfo(
            id=next_id,
            start_time=last_end,
            end_time=total_duration,
            duration=total_duration - last_end,
            is_silent=True,
        ))

    return filled


def _ensure_enough_scenes(
    scenes: list[SceneInfo],
    min_count: int,
    max_subdivision: float = 60.0,
) -> list[SceneInfo]:
    """Subdivide long scenes so we have at least ``min_count`` scenes.

    Videos like chess streams or screen recordings may have very few
    scene changes. This splits scenes longer than ``max_subdivision``
    into equal chunks so every reel segment has content to work with.
    """
    if len(scenes) >= min_count:
        return scenes

    logger.info(
        "Only %d scenes detected for %d reels — subdividing long scenes",
        len(scenes), min_count,
    )

    subdivided: list[SceneInfo] = []
    next_id = 0

    for scene in scenes:
        if scene.duration > max_subdivision and len(subdivided) < min_count:
            n_chunks = max(2, int(math.ceil(scene.duration / max_subdivision)))
            chunk_duration = scene.duration / n_chunks

            for j in range(n_chunks):
                chunk_start = scene.start_time + j * chunk_duration
                chunk_end = scene.start_time + (j + 1) * chunk_duration
                if j == n_chunks - 1:
                    chunk_end = scene.end_time

                subdivided.append(SceneInfo(
                    id=next_id,
                    start_time=chunk_start,
                    end_time=chunk_end,
                    duration=chunk_end - chunk_start,
                    has_speech=scene.has_speech,
                    is_silent=scene.is_silent,
                    transcript=scene.transcript,
                    avg_energy=scene.avg_energy,
                ))
                next_id += 1
        else:
            subdivided.append(SceneInfo(
                id=next_id,
                start_time=scene.start_time,
                end_time=scene.end_time,
                duration=scene.duration,
                has_speech=scene.has_speech,
                is_silent=scene.is_silent,
                transcript=scene.transcript,
                avg_energy=scene.avg_energy,
            ))
            next_id += 1

    return subdivided


def _split_into_reel_specs(
    scenes: list[SceneInfo],
    count: int,
    target_duration: float,
    video_path: str,
    output_dir: str,
) -> list[ReelSpec]:
    """Divide the video timeline into non-overlapping segments for reel generation.

    Splits the timeline into ``count`` equal segments. Scenes that overlap
    with a segment are assigned to that segment. For long scenes that span
    multiple segments, the scene is assigned to the segment that contains
    its midpoint.

    This handles videos with very few scenes (e.g. chess streams) by
    using time-based segments rather than relying solely on scene boundaries.
    """
    if not scenes:
        return []

    video_start = scenes[0].start_time
    video_end = scenes[-1].end_time
    total_duration = video_end - video_start
    segment_size = total_duration / count

    specs: list[ReelSpec] = []
    video_stem = Path(video_path).stem if video_path else "video"

    for i in range(count):
        seg_start = video_start + i * segment_size
        seg_end = video_start + (i + 1) * segment_size

        output_name = f"{video_stem}_reel_{i + 1}.mp4"
        output_path = str(Path(output_dir) / output_name) if output_dir else output_name

        specs.append(ReelSpec(
            index=i,
            segment_start=seg_start,
            segment_end=seg_end,
            output_path=output_path,
            target_duration=target_duration,
        ))

    return specs


def _assign_scenes_to_segments(
    scenes: list[SceneInfo],
    specs: list[ReelSpec],
) -> dict[int, list[SceneInfo]]:
    """Assign each scene to the segment that contains its midpoint.

    This ensures every scene is assigned to exactly one segment, even if
    the scene spans multiple segments (long scenes in videos with few cuts).
    """
    result: dict[int, list[SceneInfo]] = {s.index: [] for s in specs}

    for scene in scenes:
        midpoint = (scene.start_time + scene.end_time) / 2
        best_spec = specs[0]
        best_overlap = 0.0

        for spec in specs:
            overlap_start = max(midpoint, spec.segment_start)
            overlap_end = min(midpoint, spec.segment_end)
            if overlap_start <= overlap_end:
                overlap = overlap_end - overlap_start
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_spec = spec

        result[best_spec.index].append(scene)

    for idx in result:
        result[idx].sort(key=lambda s: s.start_time)

    return result


def _strategy_best_moments(
    scenes: list[SceneInfo],
    score_map: dict[int, float],
    target_duration: float,
) -> list[SceneInfo]:
    """Pick top scenes by engagement score, then re-sort chronologically."""
    sorted_scenes = sorted(
        scenes,
        key=lambda s: score_map.get(s.id, 0),
        reverse=True,
    )

    kept: list[SceneInfo] = []
    accumulated = 0.0

    for scene in sorted_scenes:
        if accumulated >= target_duration:
            break
        kept.append(scene)
        accumulated += scene.duration

    kept.sort(key=lambda s: s.start_time)
    return kept
