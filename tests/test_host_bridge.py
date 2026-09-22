import copy
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock

import opentimelineio as otio
from fastapi.testclient import TestClient

from editstyle.app import create_app
from editstyle.host_bridge import (
    HostProposal,
    ResolveCapture,
    Snapshot,
    resolve_snapshot,
    validate_proposal,
    write_timeline,
)
from editstyle.media import run

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "resolve"))
from editstyle_resolve import ResolveHost, read_cuts  # noqa: E402


def snapshot(path="/tmp/source.mov", fps=30):
    return Snapshot(host="premiere", project_id="project-1", sequence_id="sequence-1",
        name="러프컷", fps=fps, width=320, height=180, clips=[
            {"id": "v0-0", "name": "첫 장면", "path": path, "timeline_in": 0,
             "source_in": 0, "duration": 30, "source_frames": 90, "audio": True},
            {"id": "v0-1", "name": "둘째 장면", "path": path, "timeline_in": 30,
             "source_in": 30, "duration": 60, "source_frames": 90, "audio": True}])


def proposal():
    return HostProposal(summary="리듬을 짧게", cuts=[
        {"clip_id": "v0-0", "start": 0, "end": 15, "reason": "첫 컷"},
        {"clip_id": "v0-1", "start": 15, "end": 45, "reason": "둘째 컷"}], notes=[])


class HostBridgeTests(unittest.TestCase):
    def test_async_model_setup_and_disconnect_cancels_pending_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(Path(directory), plugin_token="paired")
            client = TestClient(app, headers={"X-Editstyle-Plugin": "paired"})
            entered, release = threading.Event(), threading.Event()

            def model(*_):
                entered.set()
                release.wait(2)
                return {"text": "ready", "model": "fixture", "usage": {}}

            app.state.complete = model
            response = client.post("/bridge/model/connect-job", json={
                "base_url": "http://localhost:11434/v1", "model": "fixture", "api_key": "TEMP_KEY"})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(entered.wait(1))
            self.assertEqual(client.get("/bridge/jobs/" + response.json()["job_id"]).json()["status"], "running")
            client.post("/bridge/model/disconnect", json={})
            release.set()
            for _ in range(100):
                result = client.get("/bridge/jobs/" + response.json()["job_id"])
                if result.json()["status"] != "running":
                    break
                time.sleep(.01)
            self.assertEqual(result.json()["status"], "error")
            self.assertFalse(client.get("/bridge/status").json()["connected"])
            self.assertNotIn("TEMP_KEY", result.text)

    def test_validation_rejects_invalid_model_ranges(self):
        self.assertEqual(validate_proposal(proposal(), snapshot())["duration_frames"], 45)
        for update in ({"end": 31}, {"start": 15}, {"clip_id": "unknown"}, {"start": -1},
                       {"start": 1.2}, {"end": True}, {"end": float("nan")}):
            raw = proposal().model_dump()
            raw["cuts"][0].update(update)
            with self.assertRaises(ValueError):
                validate_proposal(HostProposal(**raw), snapshot())
        raw = proposal().model_dump()
        raw["cuts"].reverse()
        with self.assertRaises(ValueError):
            validate_proposal(HostProposal(**raw), snapshot())
        raw = proposal().model_dump()
        raw["cuts"].insert(1, raw["cuts"][0])
        with self.assertRaises(ValueError):
            validate_proposal(HostProposal(**raw), snapshot())

    def test_snapshot_validation_and_private_context(self):
        current = snapshot()
        context = json.dumps(current.model_context())
        self.assertNotIn("source.mov", context)
        self.assertNotIn("project-1", context)
        self.assertIn("duration_frames", context)
        for field, value in (("fps", 27), ("sequence_id", ""), ("width", 0)):
            raw = current.model_dump()
            raw[field] = value
            with self.assertRaises(ValueError):
                Snapshot(**raw)
        for field, value in (("path", "https://evil.test/source.mov"), ("timeline_in", 10),
                             ("id", "v0-0"), ("source_frames", 20)):
            raw = current.model_dump()
            raw["clips"][1][field] = value
            with self.assertRaises(ValueError):
                Snapshot(**raw)

    def test_opt_in_pairing_and_origin_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(Path(directory), plugin_token="test-pair-code")
            client = TestClient(app)
            self.assertEqual(client.get("/bridge/status").status_code, 403)
            headers = {"X-Editstyle-Plugin": "test-pair-code"}
            self.assertEqual(client.get("/bridge/status", headers=headers).status_code, 200)
            self.assertEqual(client.get("/bridge/status", headers={**headers, "Origin": "null"}).status_code, 200)
            for extra in ({"Origin": "https://evil.test"}, {"Host": "evil.test"}, {"Sec-Fetch-Site": "cross-site"}):
                self.assertEqual(client.get("/bridge/status", headers={**headers, **extra}).status_code, 403)
            self.assertNotIn("test-pair-code", client.get("/api/bootstrap").text)
            config = {"base_url": "http://evil.test/v1", "model": "model", "api_key": "SENSITIVE"}
            response = client.post("/bridge/model/connect", headers=headers, json=config)
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("SENSITIVE", response.text)
            disabled = TestClient(create_app(Path(directory)))
            self.assertEqual(disabled.get("/bridge/status", headers=headers).status_code, 403)

    def test_real_media_assembly_preserves_sources_and_fps(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "원본 <&>.mp4"
            run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=3",
                 "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(source)])
            original = source.read_bytes()
            path = write_timeline(snapshot(str(source)), proposal(), root / "export")
            for filename in (path, path.with_suffix(".otio")):
                timeline = otio.adapters.read_from_file(str(filename))
                self.assertEqual(len(timeline.tracks), 2)
                self.assertEqual(timeline.duration().value, 45)
                self.assertEqual(timeline.duration().rate, 30)
                self.assertEqual(timeline.tracks[0][1].source_range.start_time.value, 45)
                self.assertEqual(timeline.tracks[0][1].source_range.duration.value, 30)
            self.assertEqual(source.read_bytes(), original)
            self.assertIn("channelcount>1<", path.read_text())
            with self.assertRaises(ValueError):
                write_timeline(snapshot(str(source), fps=25), proposal(), root / "wrong-fps")

    def test_ntsc_frame_rate_is_not_normalized_to_30(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "ntsc.mp4"
            run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=320x180:r=30000/1001",
                 "-frames:v", "90", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)])
            current = snapshot(str(source), fps=30000/1001)
            for clip in current.clips:
                clip.audio = False
            path = write_timeline(current, proposal(), root / "export")
            timeline = otio.adapters.read_from_file(str(path))
            self.assertEqual(len(timeline.tracks), 1)
            self.assertAlmostEqual(timeline.duration().rate, 30000/1001, places=6)
            self.assertAlmostEqual(timeline.duration().value, 45)
            self.assertIn("<ntsc>TRUE</ntsc>", path.read_text())

    def test_api_generate_review_stale_and_apply(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(Path(directory), plugin_token="paired")
            client = TestClient(app, headers={"X-Editstyle-Plugin": "paired"})
            calls = []

            def model(config, system, content):
                calls.append(content)
                return {"text": json.dumps(proposal().model_dump()), "model": "fixture", "usage": {"total_tokens": 10}}

            app.state.complete = model
            self.assertEqual(client.post("/bridge/model/connect", json={"base_url": "http://localhost:11434/v1",
                "model": "fixture", "api_key": "KEY_SHOULD_NOT_BE_SAVED", "vision": False}).status_code, 200)
            saved = client.post("/bridge/snapshots", json=snapshot().model_dump()).json()
            self.assertEqual(client.get("/bridge/styles").status_code, 200)
            response = client.post("/bridge/proposals", json={"snapshot_id": saved["id"], "style_id": "preset:cinematic"})
            self.assertEqual(response.status_code, 200)
            for _ in range(100):
                job = client.get("/bridge/jobs/" + response.json()["job_id"]).json()
                if job["status"] != "running":
                    break
                time.sleep(.01)
            self.assertEqual(job["status"], "done")
            self.assertNotIn("/tmp/source.mov", calls[-1])
            self.assertNotIn("project-1", calls[-1])
            body = {"snapshot_id": saved["id"], "current": snapshot().model_dump(),
                    "proposal": job["proposal"], "acknowledge_basic_cuts": True}
            body["current"]["sequence_id"] = "changed"
            response = client.post("/bridge/prepare", json=body)
            self.assertEqual(response.status_code, 400)
            self.assertIn("바뀌었습니다", response.json()["detail"])
            body["current"] = snapshot().model_dump()
            body["acknowledge_basic_cuts"] = False
            self.assertEqual(client.post("/bridge/prepare", json=body).status_code, 422)
            stored = "".join(p.read_text() for p in Path(directory).rglob("*.json"))
            self.assertNotIn("KEY_SHOULD_NOT_BE_SAVED", stored)
            client.post("/bridge/model/disconnect", json={})
            self.assertFalse(client.get("/bridge/status").json()["connected"])

    def test_model_malformed_response_does_not_escape_job(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(Path(directory), plugin_token="paired")
            client = TestClient(app, headers={"X-Editstyle-Plugin": "paired"})
            app.state.complete = lambda *_: {"text": "not JSON SECRET", "model": "fixture", "usage": {}}
            client.post("/bridge/model/connect", json={"base_url": "http://localhost:11434/v1", "model": "fixture"})
            saved = client.post("/bridge/snapshots", json=snapshot().model_dump()).json()
            job_id = client.post("/bridge/proposals", json={"snapshot_id": saved["id"], "style_id": "preset:cinematic"}).json()["job_id"]
            for _ in range(100):
                result = client.get("/bridge/jobs/" + job_id)
                if result.json()["status"] != "running":
                    break
                time.sleep(.01)
            self.assertEqual(result.json()["status"], "error")
            self.assertNotIn("SECRET", result.text)

    def test_resolve_otio_readback_timecode_audio_and_retime(self):
        def span(start, duration):
            return otio.opentime.TimeRange(otio.opentime.RationalTime(start, 30),
                                           otio.opentime.RationalTime(duration, 30))
        timeline = otio.schema.Timeline(name="Resolve fixture")
        for kind in ("Video", "Audio"):
            track = otio.schema.Track(kind=kind)
            track.append(otio.schema.Clip(name="clip", source_range=span(108030, 60),
                media_reference=otio.schema.ExternalReference(target_url="file:///tmp/source.mov", available_range=span(108000, 90))))
            timeline.tracks.append(track)
        data = {"project_id": "p", "sequence_id": "s", "name": "Resolve", "fps": 30, "width": 320, "height": 180,
                "otio": otio.adapters.write_to_string(timeline, adapter_name="otio_json")}
        result = resolve_snapshot(ResolveCapture(**data))
        self.assertTrue(result.clips[0].audio)
        self.assertEqual(result.clips[0].source_in, 30)
        timeline.tracks[0][0].effects.append(otio.schema.LinearTimeWarp(time_scalar=2))
        data["otio"] = otio.adapters.write_to_string(timeline, adapter_name="otio_json")
        with self.assertRaises(ValueError):
            resolve_snapshot(ResolveCapture(**data))

    def test_resolve_host_never_imports_on_stale_snapshot(self):
        current = snapshot().model_dump()
        changed = copy.deepcopy(current)
        changed["sequence_id"] = "changed"
        host = ResolveHost(Mock(), Mock())
        host.capture = Mock(return_value={"snapshot": changed})
        with self.assertRaises(ValueError):
            host.apply({"path": "/tmp/timeline.xml", "name": "review"}, current)
        host.resolve.GetProjectManager.assert_not_called()
        host.capture.return_value = {"snapshot": current}
        project = host.resolve.GetProjectManager.return_value.GetCurrentProject.return_value
        project.GetUniqueId.return_value = current["project_id"]
        project.GetCurrentTimeline.return_value.GetUniqueId.return_value = current["sequence_id"]
        host.apply({"path": "/tmp/timeline.xml", "name": "review"}, current)
        project.GetMediaPool.return_value.ImportTimelineFromFile.assert_called_once()

    def test_resolve_review_text(self):
        result = read_cuts("v0-0 2 10\nv0-1 4 20", proposal().model_dump())
        self.assertEqual(result["cuts"][0]["start"], 2)
        for value in ("", "v0-0 1.5 20", "bad 0 1", "v0-0 2 3 extra"):
            with self.assertRaises(ValueError):
                read_cuts(value, proposal().model_dump())


if __name__ == "__main__":
    unittest.main()
