from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from cutai.project_store import (
    InvalidProjectState,
    ProjectEditingState,
    ProjectNotFound,
    ProjectStore,
    ProjectStoreError,
    RevisionConflict,
)


def register(store: ProjectStore, video_id: str = "video") -> dict:
    store.media_dir.mkdir(parents=True, exist_ok=True)
    source = store.media_dir / f"{video_id}.mp4"
    source.write_bytes(b"original media")
    return store.create(video_id, {
        "path": str(source), "original_name": f"{video_id}.mp4",
        "file_size": source.stat().st_size, "duration": 35.0,
        "width": 1920, "height": 1080, "fps": 30.0,
    })


def editing_state() -> ProjectEditingState:
    data = ProjectEditingState.initial().model_dump()
    data.update({
        "edit_plan": {
            "instruction": "keep intro", "summary": "Saved draft", "estimated_duration": 6.0,
            "operations": [{"type": "cut", "action": "keep", "start_time": 2.0,
                            "end_time": 8.0, "editable": True, "confidence": 0.9,
                            "metadata": {"origin": "manual"}}],
        },
        "undo_stack": [None], "preview_resolution": 480, "render_preset": "high",
        "planning_style_preset": {"name": "cinematic", "description": "Soft cuts", "file": "cinematic.yaml"},
        "transcribe_on_import": True,
    })
    return ProjectEditingState.model_validate(data)


def test_independent_store_reopens_source_analysis_and_editing_state(tmp_path, sample_analysis):
    store = ProjectStore(tmp_path)
    assert store.current() is None
    assert register(store)["revision"] == 0
    state = editing_state()
    saved = store.save("video", 0, state)
    store.save_analysis("video", sample_analysis.model_dump())

    reopened = ProjectStore(tmp_path)
    snapshot = reopened.current()
    assert snapshot["revision"] == 1
    assert snapshot["state"] == state.model_dump()
    assert snapshot["analysis"] == sample_analysis.model_dump()
    assert snapshot["media_status"] == "available"
    assert snapshot["updated_at"] >= saved["updated_at"]
    assert reopened.video_record("video")["path"] == str(tmp_path / "media/video.mp4")
    assert len(reopened.list_projects()) == 1


def test_competing_store_revisions_have_one_winner(tmp_path):
    register(ProjectStore(tmp_path))

    def save(_):
        try:
            return ProjectStore(tmp_path).save("video", 0, editing_state())["revision"]
        except RevisionConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, range(2)))
    assert sorted(results, key=str) == [1, "conflict"]
    assert ProjectStore(tmp_path).get("video")["revision"] == 1


def test_get_and_save_do_not_change_active_project(tmp_path):
    store = ProjectStore(tmp_path)
    register(store, "one")
    register(store, "two")
    store.get("one")
    store.save("one", 0, editing_state())
    assert store.current()["video_id"] == "two"
    with pytest.raises(ProjectNotFound):
        store.open("unknown")
    assert store.current()["video_id"] == "two"
    store.open("one")
    assert ProjectStore(tmp_path).current()["video_id"] == "one"


def test_missing_source_keeps_project_and_undo(tmp_path):
    store = ProjectStore(tmp_path)
    register(store)
    state = editing_state()
    store.save("video", 0, state)
    (store.media_dir / "video.mp4").unlink()
    snapshot = ProjectStore(tmp_path).open("video")
    assert snapshot["media_status"] == "missing"
    assert snapshot["state"] == state.model_dump()
    assert store.list_projects()[0]["media_status"] == "missing"


@pytest.mark.parametrize("statement", [
    "PRAGMA user_version = 2",
    "UPDATE projects SET schema_version = 2",
    "UPDATE projects SET state_json = '{bad json'",
    "UPDATE projects SET state_json = '{}'",
    "UPDATE projects SET analysis_json = '{}'",
    "DELETE FROM active_project",
])
def test_unknown_or_corrupt_storage_is_visible_and_never_reset(tmp_path, statement):
    store = ProjectStore(tmp_path)
    register(store)
    with sqlite3.connect(store.db_path) as connection:
        connection.execute(statement)
    before = store.db_path.read_bytes()
    with pytest.raises(ProjectStoreError):
        ProjectStore(tmp_path).current()
    with pytest.raises(ProjectStoreError):
        ProjectStore(tmp_path).open("video")
    assert store.db_path.read_bytes() == before


def test_corrupt_project_cannot_be_overwritten_or_opened(tmp_path):
    store = ProjectStore(tmp_path)
    register(store, "one")
    register(store, "two")
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("UPDATE projects SET state_json = '{}' WHERE video_id = 'one'")
    with pytest.raises(ProjectStoreError):
        store.save("one", 0, editing_state())
    with pytest.raises(ProjectStoreError):
        store.open("one")
    assert store.current()["video_id"] == "two"


def test_unversioned_database_with_tables_is_preserved(tmp_path):
    db_path = tmp_path / "projects.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.execute("CREATE TABLE unknown_project(value TEXT)")
    before = db_path.read_bytes()
    with pytest.raises(ProjectStoreError, match="Unversioned"):
        ProjectStore(tmp_path).current()
    assert db_path.read_bytes() == before


@pytest.mark.parametrize(("start", "end"), [(8, 2), (2, 36), (2, 2)])
def test_invalid_source_ranges_do_not_replace_valid_state(tmp_path, start, end):
    store = ProjectStore(tmp_path)
    register(store)
    state = editing_state()
    state.edit_plan.operations[0].update(start_time=start, end_time=end)
    with pytest.raises(InvalidProjectState):
        store.save("video", 0, state)
    assert store.get("video")["revision"] == 0
    assert store.get("video")["state"]["edit_plan"] is None


def test_draft_unsupported_render_combinations_can_be_saved(tmp_path):
    store = ProjectStore(tmp_path)
    register(store)
    state = editing_state()
    state.edit_plan.operations.extend([
        {"type": "speed", "factor": 2.0, "start_time": 2.0, "end_time": 8.0},
        {"type": "subtitle", "style": "default"},
    ])
    # Revalidate the actual public schema; renderer capability is a separate gate.
    state = ProjectEditingState.model_validate(state.model_dump())
    assert store.save("video", 0, state)["state"]["edit_plan"] == state.edit_plan.model_dump()


def test_database_write_failure_preserves_state_and_active_pointer(tmp_path):
    store = ProjectStore(tmp_path)
    register(store)
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("""
            CREATE TRIGGER deny_save BEFORE UPDATE ON projects
            BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END
        """)
    with pytest.raises(ProjectStoreError, match="simulated disk failure"):
        store.save("video", 0, editing_state())
    assert store.current()["revision"] == 0
    assert store.current()["state"]["edit_plan"] is None


def test_constructor_does_not_touch_storage(tmp_path):
    target = tmp_path / "not-created"
    ProjectStore(target)
    assert not target.exists()


def test_environment_selects_storage(monkeypatch, tmp_path):
    monkeypatch.setenv("CUTAI_DATA_DIR", str(tmp_path / "custom"))
    store = ProjectStore()
    assert store.data_dir == Path(tmp_path / "custom")
