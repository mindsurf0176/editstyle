"""CutAI Server — REST API + WebSocket for desktop app integration.

Exposes all CutAI functionality via HTTP endpoints.
Launch: cutai server --port 18910
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import tempfile
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

from fastapi import FastAPI, File, HTTPException, Query, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Ensure upload/output directories exist during app startup."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(
    title="CutAI",
    version="0.1.0",
    description="AI Video Editor API",
    lifespan=lifespan,
)

# CORS for Tauri (localhost)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tauri uses tauri://localhost
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger(__name__)

RenderPresetName = Literal["draft", "balanced", "high"]
SubtitleExportMode = Literal["burned", "sidecar"]
ExportArtifactKind = Literal["video", "subtitle"]


@dataclass(frozen=True)
class RenderPresetSpec:
    key: RenderPresetName
    label: str
    max_height: int | None
    ffmpeg_preset: str
    crf: int


RENDER_PRESETS: dict[RenderPresetName, RenderPresetSpec] = {
    "draft": RenderPresetSpec(
        key="draft",
        label="Draft",
        max_height=720,
        ffmpeg_preset="veryfast",
        crf=30,
    ),
    "balanced": RenderPresetSpec(
        key="balanced",
        label="Balanced",
        max_height=1080,
        ffmpeg_preset="medium",
        crf=23,
    ),
    "high": RenderPresetSpec(
        key="high",
        label="High",
        max_height=None,
        ffmpeg_preset="slow",
        crf=19,
    ),
}

# ── Storage ──────────────────────────────────────────────────────────────────

UPLOAD_DIR = Path(tempfile.gettempdir()) / "cutai_uploads"
OUTPUT_DIR = Path(tempfile.gettempdir()) / "cutai_outputs"

# In-memory registries (ephemeral, single-user desktop use)
videos: dict[str, dict[str, Any]] = {}  # video_id -> {path, original_name, ...}
jobs: dict[str, dict[str, Any]] = {}    # job_id -> {status, result, error, progress}
UPLOAD_VIDEO_FILE = File(...)


# ── Request/Response Models ──────────────────────────────────────────────────


class AnalyzeRequest(BaseModel):
    whisper_model: str = "base"
    skip_transcription: bool = False


class PlanRequest(BaseModel):
    video_id: str
    instruction: str
    use_llm: bool = True
    llm_model: str = "gpt-4o"
    style_path: str | None = None
    style_preset: str | None = None


class RenderRequest(BaseModel):
    video_id: str
    plan: dict  # EditPlan as dict
    render_preset: RenderPresetName = "balanced"
    subtitle_export_mode: SubtitleExportMode = "burned"
    burn_subtitles: bool | None = None
    bgm_file: str | None = None
    output_path: str | None = None


class PreviewRequest(BaseModel):
    video_id: str
    plan: dict  # EditPlan as dict
    resolution: int = 360
    output_path: str | None = None


class HighlightRequest(BaseModel):
    video_id: str
    target_duration: float | None = None
    target_ratio: float = 0.2
    style: str = "best-moments"


class StyleApplyRequest(BaseModel):
    video_id: str
    style: dict  # EditDNA as dict


class StyleExtractRequest(BaseModel):
    video_id: str


class JobResponse(BaseModel):
    job_id: str
    type: str
    status: str  # pending, running, completed, failed
    progress: float = 0.0  # 0-100
    result: dict | None = None
    error: str | None = None


# ── Helpers ──────────────────────────────────────────────────────────────────


def _get_video_or_404(video_id: str) -> dict[str, Any]:
    """Retrieve video record or raise 404."""
    if video_id not in videos:
        raise HTTPException(status_code=404, detail=f"Video not found: {video_id}")
    return videos[video_id]


def _create_job(job_type: str) -> str:
    """Create a new job entry and return its ID."""
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "type": job_type,
        "status": "pending",
        "result": None,
        "error": None,
        "progress": 0.0,
    }
    return job_id


def _get_job_response(job_id: str) -> JobResponse:
    """Build a JobResponse from the job store."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    j = jobs[job_id]
    return JobResponse(
        job_id=job_id,
        type=j.get("type", "unknown"),
        status=j["status"],
        progress=j.get("progress", 0.0),
        result=j.get("result"),
        error=j.get("error"),
    )


def _build_output_path(original_name: str, suffix: str) -> str:
    stem = Path(original_name or "output.mp4").stem
    return str(OUTPUT_DIR / f"{stem}_{suffix}_{uuid.uuid4().hex[:8]}.mp4")


def _build_export_artifacts(
    output_path: str,
    subtitle_path: str | None = None,
) -> list[dict[str, str]]:
    artifacts = [{"kind": "video", "path": output_path}]
    if subtitle_path:
        artifacts.append({"kind": "subtitle", "path": subtitle_path})
    return artifacts


def _resolve_style_source(
    *,
    style_path: str | None = None,
    style_preset: str | None = None,
) -> str | None:
    if style_path:
        return style_path

    if not style_preset:
        return None

    presets_dir = Path(__file__).parent / "style" / "presets"
    candidates = [
        presets_dir / style_preset,
        presets_dir / f"{style_preset}.yaml",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    raise HTTPException(status_code=404, detail=f"Preset not found: {style_preset}")


def _resolve_subtitle_export_mode(req: RenderRequest) -> SubtitleExportMode:
    if "subtitle_export_mode" in req.model_fields_set:
        return req.subtitle_export_mode

    if "burn_subtitles" in req.model_fields_set:
        return "burned" if req.burn_subtitles is not False else "sidecar"

    return "burned"


def _get_completed_media_job(job_id: str, expected_type: str) -> tuple[JobResponse, str]:
    jr = _get_job_response(job_id)
    if jr.type != expected_type:
        raise HTTPException(
            status_code=400,
            detail=f"Job {job_id} is type={jr.type}, expected {expected_type}",
        )
    if jr.status != "completed":
        raise HTTPException(
            status_code=400,
            detail=f"Job is not completed (status={jr.status})",
        )

    output_path = jr.result.get("output_path") if jr.result else None
    if not output_path or not Path(output_path).exists():
        raise HTTPException(status_code=404, detail="Output file not found")
    return jr, output_path


# ── 1. Video Management ─────────────────────────────────────────────────────


@app.post("/api/videos/upload")
async def upload_video(file: UploadFile = UPLOAD_VIDEO_FILE) -> dict:
    """Upload a video file. Returns video_id and basic info."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    video_id = str(uuid.uuid4())
    suffix = Path(file.filename).suffix or ".mp4"
    dest = UPLOAD_DIR / f"{video_id}{suffix}"

    # Stream file to disk
    with open(dest, "wb") as f:
        while chunk := await file.read(1024 * 1024):  # 1MB chunks
            f.write(chunk)

    # Get basic metadata via ffprobe
    meta = await asyncio.to_thread(_probe_video, str(dest))

    videos[video_id] = {
        "path": str(dest),
        "original_name": file.filename,
        "file_size": dest.stat().st_size,
        "duration": meta.get("duration", 0.0),
        "width": meta.get("width", 0),
        "height": meta.get("height", 0),
        "fps": meta.get("fps", 0.0),
    }

    return {"video_id": video_id, **videos[video_id]}


@app.get("/api/videos/{video_id}")
async def get_video(video_id: str) -> dict:
    """Get video info (path, duration, etc.)."""
    info = _get_video_or_404(video_id)
    return {"video_id": video_id, **info}


@app.get("/api/videos/{video_id}/analysis")
async def get_video_analysis(video_id: str) -> dict:
    """Get completed analysis for a video."""
    info = _get_video_or_404(video_id)
    if "analysis" not in info:
        raise HTTPException(status_code=404, detail="Analysis not ready")
    return cast(dict[Any, Any], info["analysis"])


@app.delete("/api/videos/{video_id}")
async def delete_video(video_id: str) -> dict:
    """Delete an uploaded video."""
    info = _get_video_or_404(video_id)
    path = Path(info["path"])
    if path.exists():
        path.unlink()
    del videos[video_id]
    return {"deleted": video_id}


@app.get("/api/videos/{video_id}/thumbnail")
async def get_thumbnail(video_id: str, time: float = Query(0.0, ge=0)) -> FileResponse:
    """Extract and return a single frame at the given timestamp."""
    info = _get_video_or_404(video_id)
    video_path = info["path"]

    # Clamp time to video duration
    duration = info.get("duration", 0.0)
    if duration > 0 and time > duration:
        time = duration - 0.1

    thumb_path = UPLOAD_DIR / f"thumb_{video_id}_{time:.2f}.jpg"

    if not thumb_path.exists():
        await asyncio.to_thread(_extract_thumbnail, video_path, str(thumb_path), time)

    return FileResponse(str(thumb_path), media_type="image/jpeg")


# ── 2. Analysis ──────────────────────────────────────────────────────────────


@app.post("/api/videos/{video_id}/analyze")
async def start_analysis(video_id: str, req: AnalyzeRequest | None = None) -> dict:
    """Start video analysis as a background task. Returns job_id."""
    info = _get_video_or_404(video_id)
    if req is None:
        req = AnalyzeRequest()

    job_id = _create_job("analysis")
    asyncio.create_task(
        _run_analysis(job_id, video_id, info["path"], req.whisper_model, req.skip_transcription)
    )
    return {"job_id": job_id, "status": "pending"}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> JobResponse:
    """Get job status and result."""
    return _get_job_response(job_id)


async def _run_analysis(
    job_id: str, video_id: str, video_path: str, whisper_model: str, skip_transcription: bool
) -> None:
    """Background task for video analysis — step-by-step with progress updates."""
    jobs[job_id]["status"] = "running"
    jobs[job_id]["progress"] = 5.0
    audio_tmpdir: str | None = None
    try:
        from pathlib import Path as _Path

        from cutai.analyzer import _extract_audio_cached, _get_video_metadata, _is_scene_silent
        from cutai.analyzer.quality_analyzer import analyze_quality
        from cutai.analyzer.scene_detector import detect_scenes
        from cutai.models.types import VideoAnalysis

        # Step 0: Get video metadata (5% -> 10%)
        meta = await asyncio.to_thread(_get_video_metadata, video_path)
        jobs[job_id]["progress"] = 10.0

        # Step 1: Scene detection (10% -> 40%)
        scenes = await asyncio.to_thread(detect_scenes, video_path)
        jobs[job_id]["progress"] = 40.0

        # Step 2: Extract shared audio for transcriber + quality analyzer (40% -> 50%)
        import tempfile as _tempfile

        audio_tmpdir = _tempfile.mkdtemp(prefix="cutai_audio_shared_")
        audio_file: str | None = None
        try:
            audio_file = await asyncio.to_thread(_extract_audio_cached, video_path, audio_tmpdir)
        except Exception as exc:
            logger.warning("Shared audio extraction failed (%s), modules will extract individually", exc)
        jobs[job_id]["progress"] = 50.0

        # Step 3: Transcription (50% -> 75%)
        transcript: list = []
        if not skip_transcription:
            from cutai.analyzer.transcriber import transcribe

            transcribe_input = audio_file if audio_file else video_path
            transcript = await asyncio.to_thread(
                transcribe, transcribe_input, model_name=whisper_model
            )

            # Annotate scenes with speech info
            for scene in scenes:
                scene_segments = [
                    seg for seg in transcript
                    if seg.start_time < scene.end_time and seg.end_time > scene.start_time
                ]
                scene.has_speech = len(scene_segments) > 0
                if scene_segments:
                    scene.transcript = " ".join(seg.text for seg in scene_segments)
        jobs[job_id]["progress"] = 75.0

        # Step 4: Quality analysis (75% -> 90%)
        quality = await asyncio.to_thread(
            analyze_quality, video_path, scenes=scenes, audio_path=audio_file,
        )
        jobs[job_id]["progress"] = 90.0

        # Step 5: Post-processing — annotate scenes with silence info (90% -> 95%)
        for i, scene in enumerate(scenes):
            scene.is_silent = _is_scene_silent(scene, quality)
            if i < len(quality.audio_energy):
                scene.avg_energy = quality.audio_energy[i]
        jobs[job_id]["progress"] = 95.0

        # Assemble VideoAnalysis
        analysis = VideoAnalysis(
            file_path=str(_Path(video_path).resolve()),
            duration=meta["duration"],
            fps=meta["fps"],
            width=meta["width"],
            height=meta["height"],
            scenes=scenes,
            transcript=transcript,
            quality=quality,
        )

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 100.0
        result = analysis.model_dump()
        jobs[job_id]["result"] = result

        # Cache analysis on the video record
        videos[video_id]["analysis"] = result
    except Exception as e:
        logger.exception("Analysis failed for job %s", job_id)
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)
    finally:
        if audio_tmpdir is not None:
            shutil.rmtree(audio_tmpdir, ignore_errors=True)


# ── 3. Planning ──────────────────────────────────────────────────────────────


@app.post("/api/plan")
async def generate_plan(req: PlanRequest) -> dict:
    """Generate an edit plan from instruction (+ optional style)."""
    info = _get_video_or_404(req.video_id)

    # Need analysis first
    analysis_data = info.get("analysis")
    if not analysis_data:
        raise HTTPException(
            status_code=400,
            detail="Video must be analyzed first. POST /api/videos/{video_id}/analyze",
        )

    from cutai.models.types import VideoAnalysis

    analysis = VideoAnalysis(**analysis_data)

    style_source = _resolve_style_source(style_path=req.style_path, style_preset=req.style_preset)

    if style_source:
        # Style-based planning
        from cutai.style import apply_style, load_style

        style_dna = await asyncio.to_thread(load_style, style_source)
        edit_plan = await asyncio.to_thread(
            apply_style, analysis, style_dna, instruction=req.instruction
        )
    else:
        # Instruction-based planning
        from cutai.planner import create_edit_plan

        edit_plan = await asyncio.to_thread(
            create_edit_plan,
            analysis,
            req.instruction,
            llm_model=req.llm_model,
            use_llm=req.use_llm,
        )

    return edit_plan.model_dump()


# ── 4. Rendering ─────────────────────────────────────────────────────────────


def _validate_media_request(plan_data: dict, analysis_data: dict) -> None:
    from cutai.editor.renderer import validate_render_plan
    from cutai.models.types import EditPlan, VideoAnalysis

    try:
        validate_render_plan(EditPlan(**plan_data), VideoAnalysis(**analysis_data))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/render")
async def start_render(req: RenderRequest) -> dict:
    """Start rendering as a background task. Returns job_id."""
    info = _get_video_or_404(req.video_id)

    analysis_data = info.get("analysis")
    if not analysis_data:
        raise HTTPException(
            status_code=400,
            detail="Video must be analyzed first. POST /api/videos/{video_id}/analyze",
        )

    _validate_media_request(req.plan, analysis_data)

    # Determine output path
    output_path = req.output_path
    if not output_path:
        output_path = _build_output_path(info.get("original_name", "output.mp4"), "render")

    job_id = _create_job("render")
    asyncio.create_task(
        _run_render(
            job_id,
            info["path"],
            analysis_data,
            req.plan,
            output_path,
            req.render_preset,
            _resolve_subtitle_export_mode(req),
            req.bgm_file,
        )
    )
    return {"job_id": job_id, "status": "pending"}


@app.get("/api/render/{job_id}/download")
async def download_render(job_id: str) -> FileResponse:
    """Download the rendered video for a completed render job."""
    _, output_path = _get_completed_media_job(job_id, "render")
    return FileResponse(output_path, media_type="video/mp4", filename=Path(output_path).name)


@app.get("/api/render/{job_id}/video")
async def get_render_video(job_id: str) -> FileResponse:
    """Serve the rendered video for in-app playback."""
    _, output_path = _get_completed_media_job(job_id, "render")
    return FileResponse(output_path, media_type="video/mp4")


@app.post("/api/preview")
async def start_preview(req: PreviewRequest) -> dict:
    """Start preview rendering as a background task. Returns job_id."""
    info = _get_video_or_404(req.video_id)

    analysis_data = info.get("analysis")
    if not analysis_data:
        raise HTTPException(
            status_code=400,
            detail="Video must be analyzed first. POST /api/videos/{video_id}/analyze",
        )

    _validate_media_request(req.plan, analysis_data)

    output_path = req.output_path
    if not output_path:
        output_path = _build_output_path(info.get("original_name", "preview.mp4"), "preview")

    job_id = _create_job("preview")
    asyncio.create_task(
        _run_preview(
            job_id,
            info["path"],
            analysis_data,
            req.plan,
            output_path,
            req.resolution,
        )
    )
    return {"job_id": job_id, "status": "pending"}


@app.get("/api/preview/{job_id}/download")
async def download_preview(job_id: str) -> FileResponse:
    """Download the preview video for a completed preview job."""
    _, output_path = _get_completed_media_job(job_id, "preview")
    return FileResponse(output_path, media_type="video/mp4", filename=Path(output_path).name)


@app.get("/api/preview/{job_id}/video")
async def get_preview_video(job_id: str) -> FileResponse:
    """Serve the preview video for in-app playback."""
    _, output_path = _get_completed_media_job(job_id, "preview")
    return FileResponse(output_path, media_type="video/mp4")


async def _run_render(
    job_id: str,
    video_path: str,
    analysis_data: dict,
    plan_data: dict,
    output_path: str,
    render_preset: RenderPresetName,
    subtitle_export_mode: SubtitleExportMode,
    bgm_file: str | None,
) -> None:
    """Background task for video rendering — step-by-step with progress updates."""
    jobs[job_id]["status"] = "running"
    jobs[job_id]["progress"] = 5.0
    try:
        from pathlib import Path as _Path

        from cutai.editor.renderer import (
            _adjust_transcript_for_cuts,
            _compute_cut_points,
            _remap_transitions,
            validate_render_plan,
        )
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

        analysis = VideoAnalysis(**analysis_data)
        edit_plan = EditPlan(**plan_data)
        validate_render_plan(edit_plan, analysis)
        preset_spec = RENDER_PRESETS[render_preset]
        burn_subtitles = subtitle_export_mode == "burned"
        subtitle_result: dict[str, Any] = {}

        # Ensure output directory exists
        _Path(output_path).parent.mkdir(parents=True, exist_ok=True)

        # Separate operations by type
        cut_ops = [op for op in edit_plan.operations if isinstance(op, CutOperation)]
        speed_ops = [op for op in edit_plan.operations if isinstance(op, SpeedOperation)]
        color_ops = [op for op in edit_plan.operations if isinstance(op, ColorGradeOperation)]
        bgm_ops = [op for op in edit_plan.operations if isinstance(op, BGMOperation)]
        sub_ops = [op for op in edit_plan.operations if isinstance(op, SubtitleOperation)]
        trans_ops = [op for op in edit_plan.operations if isinstance(op, TransitionOperation)]

        # Count active steps for progress distribution
        active_steps = [
            bool(cut_ops), bool(speed_ops), bool(color_ops),
            bool(bgm_ops), bool(sub_ops or (sub_ops and analysis.transcript)),
            bool(trans_ops),
        ]
        num_active = max(1, sum(active_steps))

        # Progress goes from 10% to 90% across steps, then 90->100 for finalization
        progress_per_step = 80.0 / num_active
        current_progress = 10.0
        jobs[job_id]["progress"] = current_progress

        import tempfile as _tempfile

        current_video = video_path

        tmpdir_obj = _tempfile.mkdtemp(prefix="cutai_render_")

        try:
            # Step 1: Apply cuts
            if cut_ops:
                from cutai.editor.cutter import apply_cuts

                cut_output = str(_Path(tmpdir_obj) / "step1_cut.mp4")
                current_video = await asyncio.to_thread(
                    apply_cuts, current_video, cut_ops, cut_output,
                )
                current_progress += progress_per_step
                jobs[job_id]["progress"] = round(current_progress, 1)

            # Step 2: Apply speed adjustments
            if speed_ops:
                from cutai.editor.speed import apply_speed

                for i, speed_op in enumerate(speed_ops):
                    speed_output = str(_Path(tmpdir_obj) / f"step2_speed_{i}.mp4")
                    current_video = await asyncio.to_thread(
                        apply_speed, current_video, speed_op, speed_output,
                    )
                current_progress += progress_per_step
                jobs[job_id]["progress"] = round(current_progress, 1)

            # Step 3: Apply color grading
            if color_ops:
                from cutai.editor.color import apply_color_grade

                color_op = color_ops[0]
                color_output = str(_Path(tmpdir_obj) / "step3_color.mp4")
                current_video = await asyncio.to_thread(
                    apply_color_grade, current_video, color_op, color_output,
                )
                current_progress += progress_per_step
                jobs[job_id]["progress"] = round(current_progress, 1)

            # Step 4: Apply BGM
            if bgm_ops:
                from cutai.editor.bgm import apply_bgm

                bgm_op = bgm_ops[0]
                bgm_output = str(_Path(tmpdir_obj) / "step4_bgm.mp4")
                current_video = await asyncio.to_thread(
                    apply_bgm, current_video, bgm_op, bgm_output, bgm_file,
                )
                current_progress += progress_per_step
                jobs[job_id]["progress"] = round(current_progress, 1)

            # Step 5: Apply subtitles
            if sub_ops and analysis.transcript:
                from cutai.editor.subtitle import burn_subtitles as _burn_subs
                from cutai.editor.subtitle import generate_ass

                sub_op = sub_ops[0]
                transcript = analysis.transcript
                if cut_ops:
                    transcript = _adjust_transcript_for_cuts(
                        analysis.transcript, cut_ops, analysis.duration
                    )

                if burn_subtitles:
                    ass_path = str(_Path(tmpdir_obj) / "subtitles.ass")
                    await asyncio.to_thread(generate_ass, transcript, ass_path, sub_op)
                    sub_output = str(_Path(tmpdir_obj) / "step5_subs.mp4")
                    current_video = await asyncio.to_thread(
                        _burn_subs, current_video, ass_path, sub_output,
                    )
                    subtitle_result["subtitle_export_mode"] = "burned"
                else:
                    sidecar_path = str(_Path(output_path).with_suffix(".ass"))
                    await asyncio.to_thread(generate_ass, transcript, sidecar_path, sub_op)
                    if not _Path(sidecar_path).exists():
                        raise RuntimeError(
                            "Sidecar subtitle export requested, but the subtitle file was not generated."
                        )
                    subtitle_result["subtitle_export_mode"] = "sidecar"
                    subtitle_result["subtitle_path"] = sidecar_path

                current_progress += progress_per_step
                jobs[job_id]["progress"] = round(current_progress, 1)

            # Step 6: Apply transitions
            if trans_ops:
                from cutai.editor.transition import apply_transitions

                cut_points = _compute_cut_points(analysis, cut_ops)
                if cut_points:
                    trans_output = str(_Path(tmpdir_obj) / "step6_trans.mp4")
                    current_video = await asyncio.to_thread(
                        apply_transitions, current_video,
                        _remap_transitions(analysis, cut_ops, trans_ops), cut_points, trans_output,
                    )
                current_progress += progress_per_step
                jobs[job_id]["progress"] = round(current_progress, 1)

            # Final: copy to output
            jobs[job_id]["progress"] = 95.0
            actual_height = _resolve_render_height(analysis.height, preset_spec.max_height)
            await asyncio.to_thread(
                _export_render_with_settings,
                current_video,
                output_path,
                preset_spec,
                analysis.height,
            )

            if subtitle_export_mode == "sidecar" and not subtitle_result.get("subtitle_path"):
                raise RuntimeError(
                    "Sidecar subtitle export was requested, but no subtitle sidecar artifact was produced."
                )

        finally:
            # Clean up temp directory
            import shutil as _shutil

            _shutil.rmtree(tmpdir_obj, ignore_errors=True)

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 100.0
        jobs[job_id]["result"] = {
            "output_path": output_path,
            "resolution": actual_height,
            "render_preset": render_preset,
            "export_artifacts": _build_export_artifacts(
                output_path,
                cast(str | None, subtitle_result.get("subtitle_path")),
            ),
            **subtitle_result,
        }
    except Exception as e:
        logger.exception("Render failed for job %s", job_id)
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)


async def _run_preview(
    job_id: str,
    video_path: str,
    analysis_data: dict,
    plan_data: dict,
    output_path: str,
    resolution: int,
) -> None:
    """Background task for preview rendering."""
    jobs[job_id]["status"] = "running"
    jobs[job_id]["progress"] = 10.0
    try:
        from pathlib import Path as _Path

        from cutai.editor.renderer import validate_render_plan
        from cutai.models.types import EditPlan, VideoAnalysis
        from cutai.preview import render_preview

        analysis = VideoAnalysis(**analysis_data)
        edit_plan = EditPlan(**plan_data)
        validate_render_plan(edit_plan, analysis)

        _Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        jobs[job_id]["progress"] = 35.0
        result_path = await asyncio.to_thread(
            render_preview,
            video_path,
            edit_plan,
            analysis,
            output_path,
            resolution,
        )
        jobs[job_id]["progress"] = 95.0
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 100.0
        jobs[job_id]["result"] = {
            "output_path": result_path,
            "resolution": resolution,
            "export_artifacts": _build_export_artifacts(result_path),
        }
    except Exception as e:
        logger.exception("Preview failed for job %s", job_id)
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)


# ── 5. Style ─────────────────────────────────────────────────────────────────


@app.get("/api/styles/presets")
async def list_presets() -> list[dict]:
    """List available style presets."""
    presets_dir = Path(__file__).parent / "style" / "presets"
    result = []
    if presets_dir.is_dir():
        for yaml_file in sorted(presets_dir.glob("*.yaml")):
            from cutai.style import load_style

            try:
                dna = load_style(str(yaml_file))
                result.append({
                    "name": dna.name,
                    "description": dna.description,
                    "file": yaml_file.name,
                })
            except Exception:
                logger.warning("Failed to load preset %s", yaml_file.name)
    return result


@app.get("/api/styles/presets/{name}")
async def get_preset(name: str) -> dict:
    """Get full details of a style preset."""
    presets_dir = Path(__file__).parent / "style" / "presets"
    # Try exact filename or name match
    candidates = [
        presets_dir / f"{name}.yaml",
        presets_dir / name,
    ]
    for candidate in candidates:
        if candidate.exists():
            from cutai.style import load_style

            dna = load_style(str(candidate))
            return dna.model_dump()

    raise HTTPException(status_code=404, detail=f"Preset not found: {name}")


@app.post("/api/styles/extract")
async def extract_style_endpoint(req: StyleExtractRequest) -> dict:
    """Extract editing style (Edit DNA) from a video. Returns job_id."""
    info = _get_video_or_404(req.video_id)
    job_id = _create_job("style_extract")
    asyncio.create_task(_run_style_extract(job_id, info["path"]))
    return {"job_id": job_id, "status": "pending"}


async def _run_style_extract(job_id: str, video_path: str) -> None:
    """Background task for style extraction — with progress updates."""
    jobs[job_id]["status"] = "running"
    jobs[job_id]["progress"] = 10.0
    try:
        from cutai.style import extract_style

        jobs[job_id]["progress"] = 30.0
        dna = await asyncio.to_thread(extract_style, video_path)
        jobs[job_id]["progress"] = 90.0
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 100.0
        jobs[job_id]["result"] = dna.model_dump()
    except Exception as e:
        logger.exception("Style extraction failed for job %s", job_id)
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)


@app.post("/api/styles/apply")
async def apply_style_endpoint(req: StyleApplyRequest) -> dict:
    """Apply an Edit DNA style to generate an edit plan."""
    info = _get_video_or_404(req.video_id)

    analysis_data = info.get("analysis")
    if not analysis_data:
        raise HTTPException(
            status_code=400,
            detail="Video must be analyzed first. POST /api/videos/{video_id}/analyze",
        )

    from cutai.models.types import EditDNA, VideoAnalysis
    from cutai.style import apply_style

    analysis = VideoAnalysis(**analysis_data)
    style_dna = EditDNA(**req.style)

    edit_plan = await asyncio.to_thread(apply_style, analysis, style_dna)
    return edit_plan.model_dump()


# ── 6. Engagement & Highlights ───────────────────────────────────────────────


@app.post("/api/videos/{video_id}/engagement")
async def compute_engagement(video_id: str) -> dict:
    """Compute engagement scores. Returns job_id."""
    info = _get_video_or_404(video_id)
    job_id = _create_job("engagement")
    asyncio.create_task(_run_engagement(job_id, video_id, info["path"]))
    return {"job_id": job_id, "status": "pending"}


async def _run_engagement(job_id: str, video_id: str, video_path: str) -> None:
    """Background task for engagement analysis — with progress updates."""
    jobs[job_id]["status"] = "running"
    jobs[job_id]["progress"] = 10.0
    try:
        from cutai.analyzer import analyze_with_engagement

        jobs[job_id]["progress"] = 20.0
        analysis, report = await asyncio.to_thread(analyze_with_engagement, video_path)
        jobs[job_id]["progress"] = 90.0
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 100.0
        jobs[job_id]["result"] = {
            "analysis": analysis.model_dump(),
            "engagement": report.model_dump(),
        }

        # Cache analysis on the video record
        videos[video_id]["analysis"] = analysis.model_dump()
    except Exception as e:
        logger.exception("Engagement analysis failed for job %s", job_id)
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)


@app.post("/api/highlights")
async def generate_highlights(req: HighlightRequest) -> dict:
    """Generate highlight reel from engagement analysis. Returns job_id."""
    info = _get_video_or_404(req.video_id)

    analysis_data = info.get("analysis")
    if not analysis_data:
        raise HTTPException(
            status_code=400,
            detail="Video must be analyzed first. POST /api/videos/{video_id}/analyze",
        )

    job_id = _create_job("highlights")
    asyncio.create_task(
        _run_highlights(job_id, req.video_id, info["path"], analysis_data, req)
    )
    return {"job_id": job_id, "status": "pending"}


async def _run_highlights(
    job_id: str,
    video_id: str,
    video_path: str,
    analysis_data: dict,
    req: HighlightRequest,
) -> None:
    """Background task for highlight generation — with progress updates."""
    jobs[job_id]["status"] = "running"
    jobs[job_id]["progress"] = 10.0
    try:
        from cutai.analyzer.engagement import compute_engagement_scores
        from cutai.highlight import generate_highlights as gen_hl
        from cutai.models.types import VideoAnalysis

        analysis = VideoAnalysis(**analysis_data)

        # Step 1: Compute engagement scores (10% -> 50%)
        jobs[job_id]["progress"] = 20.0
        engagement = await asyncio.to_thread(compute_engagement_scores, analysis, video_path)
        jobs[job_id]["progress"] = 50.0

        # Step 2: Generate highlight plan (50% -> 90%)
        jobs[job_id]["progress"] = 60.0
        edit_plan = await asyncio.to_thread(
            gen_hl,
            video_path,
            analysis,
            engagement,
            target_duration=req.target_duration,
            target_ratio=req.target_ratio,
            style=req.style,
        )
        jobs[job_id]["progress"] = 90.0

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 100.0
        jobs[job_id]["result"] = edit_plan.model_dump()
    except Exception as e:
        logger.exception("Highlight generation failed for job %s", job_id)
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)


# ── 7. WebSocket for Progress ────────────────────────────────────────────────


@app.websocket("/ws/progress/{job_id}")
async def ws_progress(websocket: WebSocket, job_id: str) -> None:
    """Stream job progress updates via WebSocket."""
    await websocket.accept()

    if job_id not in jobs:
        await websocket.send_json({"error": f"Job not found: {job_id}"})
        await websocket.close()
        return

    try:
        prev_progress = -1.0
        prev_status = ""
        while True:
            j = jobs.get(job_id)
            if not j:
                await websocket.send_json({"error": "Job disappeared"})
                break

            # Send update only when state changes
            current_progress = j.get("progress", 0.0)
            current_status = j["status"]
            if current_progress != prev_progress or current_status != prev_status:
                msg: dict[str, Any] = {
                    "job_id": job_id,
                    "type": j.get("type", "unknown"),
                    "status": current_status,
                    "progress": current_progress,
                }
                if current_status == "completed":
                    msg["result"] = j.get("result")
                elif current_status == "failed":
                    msg["error"] = j.get("error")
                await websocket.send_json(msg)
                prev_progress = current_progress
                prev_status = current_status

            # Terminal states — close connection
            if current_status in ("completed", "failed"):
                break

            await asyncio.sleep(0.5)
    except Exception:
        pass  # Client disconnected
    finally:
        with suppress(Exception):
            await websocket.close()


# ── 8. System ────────────────────────────────────────────────────────────────


@app.get("/api/health")
async def health_check() -> dict:
    """Health check endpoint."""
    return {
        "status": "ok",
        "version": "0.1.0",
        "videos_loaded": len(videos),
        "active_jobs": sum(1 for j in jobs.values() if j["status"] == "running"),
    }


@app.get("/api/config")
async def get_config() -> dict:
    """Get current CutAI configuration (redacts API keys)."""
    from cutai.config import load_config

    config = load_config()
    data = config.model_dump()
    # Redact sensitive fields
    if data.get("openai_api_key"):
        key = data["openai_api_key"]
        data["openai_api_key"] = f"{key[:8]}...{key[-4:]}" if len(key) > 12 else "***"
    return data


# ── Internal helpers ─────────────────────────────────────────────────────────


def _probe_video(video_path: str) -> dict[str, Any]:
    """Get basic video metadata using ffprobe."""
    from cutai.config import ensure_ffprobe

    ffprobe = ensure_ffprobe()
    cmd = [
        ffprobe,
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        video_path,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return {"duration": 0.0, "width": 0, "height": 0, "fps": 0.0}

    data = json.loads(result.stdout)

    video_stream = None
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            video_stream = stream
            break

    if not video_stream:
        return {"duration": 0.0, "width": 0, "height": 0, "fps": 0.0}

    fps_str = video_stream.get("r_frame_rate", "30/1")
    try:
        num, den = fps_str.split("/")
        fps = float(num) / float(den)
    except (ValueError, ZeroDivisionError):
        fps = 30.0

    duration = float(data.get("format", {}).get("duration", 0))

    return {
        "duration": round(duration, 3),
        "fps": round(fps, 2),
        "width": int(video_stream.get("width", 0)),
        "height": int(video_stream.get("height", 0)),
    }


def _extract_thumbnail(video_path: str, output_path: str, time: float) -> None:
    """Extract a single frame from video at the given timestamp using FFmpeg."""
    from cutai.config import ensure_ffmpeg

    ffmpeg = ensure_ffmpeg()
    cmd = [
        ffmpeg, "-y",
        "-ss", str(time),
        "-i", video_path,
        "-vframes", "1",
        "-q:v", "2",
        output_path,
    ]
    subprocess.run(cmd, capture_output=True, check=True, timeout=30)


def _resolve_render_height(input_height: int, max_height: int | None) -> int:
    """Return the expected output height without upscaling."""
    if input_height <= 0:
        return max_height or 0
    if max_height is None:
        return input_height
    return min(input_height, max_height)


def _export_render_with_settings(
    input_path: str,
    output_path: str,
    preset: RenderPresetSpec,
    input_height: int,
) -> None:
    """Apply the selected render preset during final export."""
    from cutai.config import ensure_ffmpeg

    ffmpeg = ensure_ffmpeg()
    target_height = _resolve_render_height(input_height, preset.max_height)

    cmd = [
        ffmpeg,
        "-y",
        "-i",
        input_path,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
    ]

    if preset.max_height is not None and input_height > preset.max_height:
        cmd.extend(["-vf", f"scale=-2:{target_height}"])

    cmd.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            preset.ffmpeg_preset,
            "-crf",
            str(preset.crf),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            output_path,
        ]
    )

    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=1800)
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode(errors="ignore")[-500:] if exc.stderr else ""
        raise RuntimeError(
            f"FFmpeg export failed for render preset '{preset.key}': {stderr or exc}"
        ) from exc
