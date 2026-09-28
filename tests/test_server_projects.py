from __future__ import annotations

import asyncio
import hashlib
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import cutai.server as server
from cutai.project_store import ProjectEditingState, ProjectStore, ProjectStoreError
from tests.test_project_store import editing_state


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(server, "_probe_video", lambda _: {
        "duration": 35.0, "width": 1920, "height": 1080, "fps": 30.0,
    })
    # Intentionally omit lifespan to cover lazy API use as existing clients do.
    return TestClient(server.app)


def upload(client: TestClient, name: str = "input.mp4", **kwargs) -> dict:
    response = client.post("/api/videos/upload", files={"file": (name, b"original source")}, **kwargs)
    assert response.status_code == 200, response.text
    return response.json()


def save_body(state: dict | None = None, revision: int = 0) -> dict:
    return {"schema_version": 1, "expected_revision": revision,
            "state": state if state is not None else editing_state().model_dump()}


def test_upload_creates_project_and_lazy_restore_keeps_no_jobs(client):
    assert client.get("/api/projects/current").json() is None
    info = upload(client)
    video_id = info["video_id"]
    path = Path(info["path"])
    assert path.is_relative_to(ProjectStore().media_dir)
    assert info["project_revision"] == 0
    snapshot = client.get("/api/projects/current").json()
    assert snapshot["video_id"] == video_id
    assert snapshot["analysis"] is None
    assert snapshot["state"] == ProjectEditingState.initial().model_dump()
    assert "path" not in snapshot["video_info"]
    assert "_persisted" not in client.get(f"/api/videos/{video_id}").json()

    result = client.put(f"/api/projects/{video_id}", json=save_body())
    assert result.status_code == 200
    assert result.json()["revision"] == 1
    server.videos.clear()
    server.jobs.clear()
    reopened = TestClient(server.app)
    assert reopened.get("/api/projects/current").json() == result.json()
    assert reopened.get(f"/api/videos/{video_id}").json()["path"] == str(path)
    assert reopened.get("/api/jobs/old-job").status_code == 404
    assert server.jobs == {}


def test_revision_conflict_and_inactive_save_cannot_switch_pointer(client):
    one = upload(client)["video_id"]
    two = upload(client, "two.mp4")["video_id"]
    assert client.get(f"/api/projects/{one}").status_code == 200
    assert client.put(f"/api/projects/{one}", json=save_body()).status_code == 200
    stale = client.put(f"/api/projects/{one}", json=save_body())
    assert stale.status_code == 409
    assert "revision" in stale.json()["detail"]
    assert client.get("/api/projects/current").json()["video_id"] == two
    assert client.post("/api/projects/no-such-project/open").status_code == 404
    assert client.get("/api/projects/current").json()["video_id"] == two
    assert client.post(f"/api/projects/{one}/open").json()["video_id"] == one


def test_missing_source_blocks_jobs_but_keeps_plan_and_analysis(client, sample_analysis):
    info = upload(client)
    video_id = info["video_id"]
    ProjectStore().save_analysis(video_id, sample_analysis.model_dump())
    client.put(f"/api/projects/{video_id}", json=save_body())
    Path(info["path"]).unlink()
    server.videos.clear()
    snapshot = client.post(f"/api/projects/{video_id}/open").json()
    assert snapshot["media_status"] == "missing"
    assert snapshot["state"]["edit_plan"]["summary"] == "Saved draft"
    assert client.get(f"/api/videos/{video_id}/analysis").json() == sample_analysis.model_dump()
    for endpoint, body in [
        (f"/api/videos/{video_id}/analyze", {}),
        (f"/api/videos/{video_id}/engagement", {}),
        ("/api/styles/extract", {"video_id": video_id}),
        ("/api/highlights", {"video_id": video_id}),
        ("/api/preview", {"video_id": video_id, "plan": {}}),
        ("/api/render", {"video_id": video_id, "plan": {}}),
    ]:
        response = client.post(endpoint, json=body)
        assert response.status_code == 409, response.text
        assert "missing" in response.json()["detail"]
    assert server.jobs == {}


@pytest.mark.parametrize("patch", [
    {"schema_version": 2}, {"expected_revision": -1}, {"expected_revision": "0"},
    {"path": "/tmp/other.mp4"}, {"analysis": {}}, {"state": {}},
])
def test_invalid_or_server_owned_fields_rejected(client, patch):
    video_id = upload(client)["video_id"]
    body = save_body()
    body.update(patch)
    assert client.put(f"/api/projects/{video_id}", json=body).status_code == 422
    assert client.get(f"/api/projects/{video_id}").json()["revision"] == 0


@pytest.mark.parametrize("field,value", [
    ("preview_resolution", 1080), ("transcribe_on_import", "yes"),
    ("render_preset", "unknown"), ("undo_stack", [None] * 21),
    ("analysis", {}),
])
def test_invalid_state_rejected(client, field, value):
    video_id = upload(client)["video_id"]
    state = editing_state().model_dump()
    state[field] = value
    assert client.put(f"/api/projects/{video_id}", json=save_body(state)).status_code == 422


def test_out_of_source_undo_entry_is_rejected(client):
    video_id = upload(client)["video_id"]
    state = editing_state().model_dump()
    state["undo_stack"] = [state["edit_plan"]]
    state["undo_stack"][0]["operations"][0]["end_time"] = 100
    response = client.put(f"/api/projects/{video_id}", json=save_body(state))
    assert response.status_code == 422
    assert client.get(f"/api/projects/{video_id}").json()["revision"] == 0


def test_corrupt_project_and_database_are_visible(client):
    video_id = upload(client)["video_id"]
    store = ProjectStore()
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("UPDATE projects SET state_json = '{corrupt'")
    for endpoint in ("/api/projects/current", "/api/projects", f"/api/projects/{video_id}"):
        assert client.get(endpoint).status_code == 503
    assert client.put(f"/api/projects/{video_id}", json=save_body()).status_code == 503
    with sqlite3.connect(store.db_path) as connection:
        assert connection.execute("SELECT state_json FROM projects").fetchone()[0] == "{corrupt"
        connection.execute("PRAGMA user_version = 9")
    assert client.get("/api/projects/current").status_code == 503


def test_saved_project_prevents_source_deletion(client):
    info = upload(client)
    response = client.delete(f"/api/videos/{info['video_id']}")
    assert response.status_code == 409
    assert Path(info["path"]).read_bytes() == b"original source"


def mock_analysis(monkeypatch, sample_analysis):
    monkeypatch.setattr("cutai.analyzer._get_video_metadata", lambda _: sample_analysis.model_dump(
        include={"duration", "fps", "width", "height"}))
    monkeypatch.setattr("cutai.analyzer.scene_detector.detect_scenes", lambda _: sample_analysis.scenes)
    monkeypatch.setattr("cutai.analyzer._extract_audio_cached", lambda *_: None)
    monkeypatch.setattr("cutai.analyzer.quality_analyzer.analyze_quality", lambda *_, **__: sample_analysis.quality)


def test_analysis_is_committed_before_job_completion(client, monkeypatch, sample_analysis):
    info = upload(client)
    mock_analysis(monkeypatch, sample_analysis)
    job_id = server._create_job("analysis")
    original_save = ProjectStore.save_analysis

    def inspect_save(store, video_id, result):
        assert server.jobs[job_id]["status"] == "running"
        original_save(store, video_id, result)

    monkeypatch.setattr(ProjectStore, "save_analysis", inspect_save)
    asyncio.run(server._run_analysis(job_id, info["video_id"], info["path"], "base", True))
    assert server.jobs[job_id]["status"] == "completed"
    server.videos.clear()
    assert client.get(f"/api/videos/{info['video_id']}/analysis").json() == server.jobs[job_id]["result"]
    assert ProjectStore().current()["revision"] == 0


def test_failed_analysis_write_never_reports_complete_or_replaces_old_analysis(client, monkeypatch, sample_analysis):
    info = upload(client)
    ProjectStore().save_analysis(info["video_id"], sample_analysis.model_dump())
    old_analysis = ProjectStore().current()["analysis"]
    mock_analysis(monkeypatch, sample_analysis)

    def fail(*_):
        raise ProjectStoreError("disk unavailable")

    monkeypatch.setattr(ProjectStore, "save_analysis", fail)
    job_id = server._create_job("analysis")
    asyncio.run(server._run_analysis(job_id, info["video_id"], info["path"], "base", True))
    assert server.jobs[job_id]["status"] == "failed"
    assert server.jobs[job_id]["result"] is None
    assert "disk unavailable" in server.jobs[job_id]["error"]
    assert ProjectStore().current()["analysis"] == old_analysis


@pytest.mark.parametrize("stage", ["fsync", "replace", "database"])
def test_failed_upload_cleans_files_and_does_not_switch_active_project(client, monkeypatch, stage):
    info = upload(client)
    original_files = set(ProjectStore().media_dir.iterdir())

    def fail(*_):
        if stage == "database":
            raise ProjectStoreError("database full")
        raise OSError("disk full")

    if stage == "database":
        monkeypatch.setattr(ProjectStore, "create", fail)
    else:
        monkeypatch.setattr(server.os, stage, fail)
    response = client.post("/api/videos/upload", files={"file": ("failed.mp4", b"incomplete")})
    assert response.status_code == 503
    assert set(ProjectStore().media_dir.iterdir()) == original_files
    assert ProjectStore().current()["video_id"] == info["video_id"]
    assert list(server.videos) == [info["video_id"]]


def test_invalid_media_upload_has_no_record_or_leftover_file(client, monkeypatch):
    monkeypatch.setattr(server, "_probe_video", lambda _: {})
    response = client.post("/api/videos/upload", files={"file": ("bad.mp4", b"not media")})
    assert response.status_code == 422
    assert list(ProjectStore().media_dir.iterdir()) == []
    assert ProjectStore().current() is None


def test_interrupted_upload_cleans_partial_source(monkeypatch):
    class InterruptedUpload:
        filename = "interrupted.mp4"
        reads = 0

        async def read(self, _size):
            self.reads += 1
            if self.reads == 1:
                return b"partial media"
            raise OSError("upload interrupted")

    with pytest.raises(ProjectStoreError, match="upload interrupted"):
        asyncio.run(server.upload_video(InterruptedUpload()))
    assert list(ProjectStore().media_dir.iterdir()) == []
    assert ProjectStore().current() is None


def test_nonfinite_extra_style_metadata_is_rejected_without_commit(client):
    import json

    video_id = upload(client)["video_id"]
    state = editing_state().model_dump()
    state["planning_style_preset"]["style"] = {"invalid": float("inf")}
    response = client.put(f"/api/projects/{video_id}", content=json.dumps(save_body(state)),
                          headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert ProjectStore().current()["revision"] == 0


def test_upload_commits_only_after_media_fsync_and_rename(client, monkeypatch):
    real_create = ProjectStore.create
    real_fsync = server.os.fsync
    calls = []

    def fsync(descriptor):
        calls.append("fsync")
        return real_fsync(descriptor)

    def create(store, video_id, record):
        assert len(calls) == 2  # Complete file, then rename directory entry.
        assert Path(record["path"]).read_bytes() == b"original source"
        assert not list(store.media_dir.glob("*.upload"))
        return real_create(store, video_id, record)

    monkeypatch.setattr(server.os, "fsync", fsync)
    monkeypatch.setattr(ProjectStore, "create", create)
    upload(client)


def test_hostile_origin_cannot_upload_or_save(client):
    hostile = {"Origin": "https://hostile.example"}
    response = client.post("/api/videos/upload", files={"file": ("bad.mp4", b"data")}, headers=hostile)
    assert response.status_code == 403
    assert ProjectStore().current() is None
    video_id = upload(client)["video_id"]
    assert client.put(f"/api/projects/{video_id}", json=save_body(), headers=hostile).status_code == 403
    assert ProjectStore().current()["revision"] == 0
    preflight = client.options("/api/projects", headers={**hostile, "Access-Control-Request-Method": "PUT"})
    assert "access-control-allow-origin" not in preflight.headers


@pytest.mark.parametrize("origin", sorted(server.LOCAL_UI_ORIGINS))
def test_local_ui_origins_can_upload_and_save(client, origin):
    headers = {"Origin": origin}
    video_id = upload(client, headers=headers)["video_id"]
    response = client.put(f"/api/projects/{video_id}", json=save_body(), headers=headers)
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-credentials" not in response.headers


@pytest.mark.parametrize("endpoint", ["/api/render", "/api/preview"])
@pytest.mark.parametrize("destination", ["self", "other", "database", "symlink", "hardlink"])
def test_output_cannot_overwrite_any_managed_data(client, sample_analysis, tmp_path, endpoint, destination):
    one = upload(client)
    two = upload(client, "other.mp4")
    store = ProjectStore()
    store.save_analysis(one["video_id"], sample_analysis.model_dump())
    targets = {"self": one["path"], "other": two["path"], "database": str(store.db_path)}
    alias = tmp_path / "alias.mp4"
    if destination == "symlink":
        alias.symlink_to(two["path"])
        target = str(alias)
    elif destination == "hardlink":
        alias.hardlink_to(two["path"])
        target = str(alias)
    else:
        target = targets[destination]
    before = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in targets.values()}
    response = client.post(endpoint, json={
        "video_id": one["video_id"], "plan": {"instruction": "test", "operations": []}, "output_path": target,
    })
    assert response.status_code == 422, response.text
    assert server.jobs == {}
    assert before == {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in targets.values()}
