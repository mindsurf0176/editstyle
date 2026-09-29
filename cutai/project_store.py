"""Durable, versioned local projects. Media and analysis remain server-owned."""

from __future__ import annotations

import json
import math
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_serializer, field_validator

from cutai.models.types import EditOperation, VideoAnalysis

SCHEMA_VERSION = 1


class ProjectStoreError(Exception):
    """Storage cannot be read or committed safely; never reset it automatically."""


class ProjectNotFound(ProjectStoreError):
    pass


class RevisionConflict(ProjectStoreError):
    pass


class InvalidProjectState(ValueError):
    pass


class SavedEditPlan(BaseModel):
    """Validate known operations while preserving editor-added operation metadata."""

    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    instruction: str
    operations: list[dict[str, Any]]
    estimated_duration: float = Field(ge=0)
    summary: str

    @field_validator("operations")
    @classmethod
    def validate_operations(cls, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
        adapter = TypeAdapter(EditOperation)
        for operation in operations:
            adapter.validate_json(json.dumps(operation, allow_nan=False), strict=True)
        return operations


class PlanningStylePreset(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str
    description: str
    file: str | None = None
    style: dict[str, Any] | None = None


class ProjectEditingState(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    edit_plan: SavedEditPlan | None
    undo_stack: list[SavedEditPlan | None] = Field(max_length=20)
    preview_resolution: Literal[360, 480, 720]
    render_preset: Literal["draft", "balanced", "high"]
    subtitle_export_mode: Literal["burned", "sidecar"]
    planning_style_preset: PlanningStylePreset | None
    transcribe_on_import: bool
    # Absent in projects saved before playback. Zero is the source start, not a new schema.
    playhead_time: float = 0

    @field_validator("playhead_time", mode="before")
    @classmethod
    def finite_playhead(cls, value: object) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("playhead_time must be a finite number")
        number = float(value)
        if not math.isfinite(number) or number < 0:
            raise ValueError("playhead_time must be a finite number greater than or equal to zero")
        return number

    @field_serializer("planning_style_preset")
    def serialize_preset(self, value: PlanningStylePreset | None) -> dict[str, Any] | None:
        return value.model_dump(exclude_none=True) if value is not None else None

    @classmethod
    def initial(cls) -> ProjectEditingState:
        return cls(
            edit_plan=None, undo_stack=[], preview_resolution=360,
            render_preset="balanced", subtitle_export_mode="burned",
            planning_style_preset=None, transcribe_on_import=False,
        )


class ProjectUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal[1]
    expected_revision: int = Field(ge=0)
    state: ProjectEditingState


class VideoInfo(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)
    video_id: str
    original_name: str
    duration: float = Field(gt=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    fps: float = Field(gt=0)
    file_size: int = Field(ge=0)


def get_data_dir() -> Path:
    return Path(os.environ.get("CUTAI_DATA_DIR", "~/.cutai/data")).expanduser().resolve()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_state(state: ProjectEditingState, duration: float) -> None:
    # Saving a draft does not invoke render support checks. Only source intervals
    # and the stored schema must be valid, including every undo entry.
    for plan in [state.edit_plan, *state.undo_stack]:
        if plan is None:
            continue
        for operation in plan.operations:
            if operation["type"] not in {"cut", "speed"}:
                continue
            start, end = operation["start_time"], operation["end_time"]
            if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration):
                raise InvalidProjectState(
                    f"Invalid source interval {start}–{end}; expected 0 <= start < end <= {duration}"
                )
    if not 0 <= state.playhead_time <= duration:
        raise InvalidProjectState(
            f"Invalid playhead {state.playhead_time}; expected 0 <= time <= {duration}"
        )
    try:
        _json(state.model_dump())
    except (ValueError, TypeError) as exc:
        raise InvalidProjectState("Project state must contain finite JSON values") from exc


class ProjectStore:
    """Open connections per operation so independent backend processes share CAS."""

    def __init__(self, data_dir: str | Path | None = None):
        self.data_dir = Path(data_dir) if data_dir is not None else get_data_dir()
        self.media_dir = self.data_dir / "media"
        self.db_path = self.data_dir / "projects.sqlite3"

    @contextmanager
    def _connect(self):
        connection = None
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.db_path, timeout=5)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA synchronous = FULL")
            connection.execute("BEGIN IMMEDIATE")
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                tables = connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
                if tables:
                    raise ProjectStoreError("Unversioned project database; existing data was preserved")
                connection.execute("""
                    CREATE TABLE projects (
                        video_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL,
                        revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
                        media_path TEXT NOT NULL, video_info_json TEXT NOT NULL,
                        analysis_json TEXT, state_json TEXT NOT NULL
                    )
                """)
                connection.execute("""
                    CREATE TABLE active_project (
                        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                        video_id TEXT REFERENCES projects(video_id)
                    )
                """)
                connection.execute("INSERT INTO active_project VALUES (1, NULL)")
                connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            elif version != SCHEMA_VERSION:
                raise ProjectStoreError(f"Unsupported project database schema version: {version}")
            yield connection
            connection.commit()
        except (sqlite3.Error, OSError) as exc:
            raise ProjectStoreError(f"Project storage error: {exc}") from exc
        finally:
            if connection is not None:
                connection.close()

    def _row(self, connection: sqlite3.Connection, video_id: str) -> sqlite3.Row:
        row = connection.execute("SELECT * FROM projects WHERE video_id = ?", (video_id,)).fetchone()
        if row is None:
            raise ProjectNotFound(f"Project not found: {video_id}")
        return row

    def _snapshot(self, row: sqlite3.Row) -> dict[str, Any]:
        if row["schema_version"] != SCHEMA_VERSION:
            raise ProjectStoreError(f"Unsupported project schema version: {row['schema_version']}")
        try:
            info = VideoInfo.model_validate_json(row["video_info_json"])
            if info.video_id != row["video_id"] or row["revision"] < 0:
                raise ValueError("Project identity or revision is invalid")
            if not isinstance(row["revision"], int):
                raise ValueError("Project revision must be an integer")
            datetime.fromisoformat(row["updated_at"])
            state = ProjectEditingState.model_validate_json(row["state_json"])
            _validate_state(state, info.duration)
            analysis = json.loads(row["analysis_json"]) if row["analysis_json"] is not None else None
            if analysis is not None:
                VideoAnalysis.model_validate(analysis)
                _json(analysis)
            media_path = Path(row["media_path"])
            if not media_path.is_absolute():
                raise ValueError("Stored media path must be absolute")
            return {
                "schema_version": SCHEMA_VERSION,
                "video_id": row["video_id"],
                "revision": row["revision"],
                "updated_at": row["updated_at"],
                "video_info": info.model_dump(),
                "analysis": analysis,
                "media_status": "available" if media_path.is_file() else "missing",
                "state": state.model_dump(),
            }
        except (ValueError, TypeError, KeyError) as exc:
            raise ProjectStoreError(f"Invalid stored project {row['video_id']}: {exc}") from exc

    def _active_id(self, connection: sqlite3.Connection) -> str | None:
        row = connection.execute("SELECT video_id FROM active_project WHERE singleton = 1").fetchone()
        if row is None:
            raise ProjectStoreError("Active project record is missing; existing data was preserved")
        if row[0] is None and connection.execute("SELECT 1 FROM projects LIMIT 1").fetchone():
            raise ProjectStoreError("Active project pointer is missing; existing projects were preserved")
        return row[0]

    def current(self) -> dict[str, Any] | None:
        with self._connect() as connection:
            video_id = self._active_id(connection)
            if video_id is None:
                return None
            try:
                return self._snapshot(self._row(connection, video_id))
            except ProjectNotFound as exc:
                raise ProjectStoreError("Active project points to a missing project") from exc

    def get(self, video_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            return self._snapshot(self._row(connection, video_id))

    def list_projects(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            snapshots = [self._snapshot(row) for row in connection.execute(
                "SELECT * FROM projects ORDER BY updated_at DESC, video_id"
            )]
            return [{
                "video_id": snapshot["video_id"],
                "original_name": snapshot["video_info"]["original_name"],
                "revision": snapshot["revision"],
                "updated_at": snapshot["updated_at"],
                "media_status": snapshot["media_status"],
            } for snapshot in snapshots]

    def open(self, video_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            snapshot = self._snapshot(self._row(connection, video_id))
            self._active_id(connection)
            connection.execute("UPDATE active_project SET video_id = ? WHERE singleton = 1", (video_id,))
            return snapshot

    def create(self, video_id: str, record: dict[str, Any]) -> dict[str, Any]:
        info = VideoInfo(video_id=video_id, **{key: record[key] for key in VideoInfo.model_fields if key != "video_id"})
        media_path = Path(record["path"]).resolve()
        if not media_path.is_file():
            raise ProjectStoreError("Cannot register project: source media is missing")
        with self._connect() as connection:
            self._active_id(connection)
            connection.execute(
                "INSERT INTO projects VALUES (?, ?, 0, ?, ?, ?, NULL, ?)",
                (video_id, SCHEMA_VERSION, _now(), str(media_path), _json(info.model_dump()),
                 _json(ProjectEditingState.initial().model_dump())),
            )
            connection.execute("UPDATE active_project SET video_id = ? WHERE singleton = 1", (video_id,))
            return self._snapshot(self._row(connection, video_id))

    def save(self, video_id: str, expected_revision: int, state: ProjectEditingState) -> dict[str, Any]:
        with self._connect() as connection:
            snapshot = self._snapshot(self._row(connection, video_id))
            if snapshot["revision"] != expected_revision:
                raise RevisionConflict(
                    f"Project changed: expected revision {expected_revision}, current revision {snapshot['revision']}"
                )
            _validate_state(state, snapshot["video_info"]["duration"])
            connection.execute(
                "UPDATE projects SET state_json = ?, revision = revision + 1, updated_at = ? "
                "WHERE video_id = ? AND revision = ?",
                (_json(state.model_dump()), _now(), video_id, expected_revision),
            )
            return self._snapshot(self._row(connection, video_id))

    def save_analysis(self, video_id: str, analysis: dict[str, Any]) -> None:
        VideoAnalysis.model_validate(analysis)
        serialized = _json(analysis)
        with self._connect() as connection:
            self._snapshot(self._row(connection, video_id))
            # Analysis is server-owned; it cannot invalidate a pending editing-state save.
            connection.execute(
                "UPDATE projects SET analysis_json = ?, updated_at = ? WHERE video_id = ?",
                (serialized, _now(), video_id),
            )

    def video_record(self, video_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = self._row(connection, video_id)
            snapshot = self._snapshot(row)
            record = {**snapshot["video_info"], "path": row["media_path"], "_persisted": True}
            record.pop("video_id")
            if snapshot["analysis"] is not None:
                record["analysis"] = snapshot["analysis"]
            return record
