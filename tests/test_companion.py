"""Meaningful boundary tests plus real FFmpeg and XML/OTIO round trips."""

import json
import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import httpx
import opentimelineio as otio
from fastapi.testclient import TestClient
from pydantic import ValidationError

from editstyle.app import create_app
from editstyle.editing import Proposal, srt, validate
from editstyle.media import probe, run
from editstyle.provider import ModelConnection, complete, json_result


class ProviderTests(unittest.TestCase):
    def test_https_or_loopback_only(self):
        for url in ("http://example.com/v1", "https://key:secret@example.com", "https://example.com?v=secret"):
            with self.assertRaises(ValidationError):
                ModelConnection(base_url=url, model="test")
        self.assertEqual(ModelConnection(base_url="http://localhost:1234/v1/", model="test").base_url,
                         "http://localhost:1234/v1")

    def test_request_and_secret_safe_failures(self):
        config = ModelConnection(base_url="https://provider.example/v1", model="test", api_key="secret-for-test")

        def handler(request):
            self.assertEqual(str(request.url), "https://provider.example/v1/chat/completions")
            self.assertEqual(request.headers["Authorization"], "Bearer secret-for-test")
            self.assertEqual(json.loads(request.content)["model"], "test")
            return httpx.Response(200, json={"choices": [{"message": {"content": "ready"}}], "usage": {"total_tokens": 1}})
        self.assertEqual(complete(config, "test", "hello", transport=httpx.MockTransport(handler))["text"], "ready")
        for code in (302, 401, 429, 500):
            with self.assertRaises(ValueError) as error:
                complete(config, "test", "hello", transport=httpx.MockTransport(
                    lambda request, status=code: httpx.Response(status, text="secret-for-test", headers={"location": "https://other.example"})))
            self.assertNotIn("secret-for-test", str(error.exception))

    def test_invalid_model_json_is_rejected(self):
        self.assertEqual(json_result('```json\n{"x":1}\n```'), {"x": 1})
        for raw in ("not json", "[]", "null"):
            with self.assertRaises(ValueError):
                json_result(raw)


class TimingTests(unittest.TestCase):
    def test_bounds_and_overlap_are_rejected(self):
        for clips in ([{"start": 0, "end": 4, "reason": "x"}],
                      [{"start": 0, "end": 2, "reason": "x"}, {"start": 1, "end": 3, "reason": "x"}],
                      [{"start": 0.001, "end": 0.002, "reason": "x"}]):
            with self.assertRaises(ValueError):
                validate(Proposal(summary="test", clips=clips), {"frames": 90})

    def test_source_captions_map_to_contiguous_output(self):
        plan = validate(Proposal(summary="test", clips=[
            {"start": 0.5, "end": 1, "reason": "a", "caption": "첫 장면"},
            {"start": 2, "end": 3, "reason": "b", "caption": "다음 장면"},
        ]), {"frames": 90})
        self.assertEqual(plan["duration_frames"], 45)
        self.assertIn("00:00:00,500 --> 00:00:01,500", srt(plan))


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app = create_app(self.root / "workspace")
        self.client = TestClient(self.app)
        self.client.headers["X-Editstyle-Token"] = self.client.get("/api/bootstrap").json()["token"]

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def test_host_origin_token_and_key_redaction(self):
        self.assertEqual(self.client.get("/api/library", headers={"host": "evil.example"}).status_code, 403)
        self.assertEqual(self.client.get("/api/library", headers={"origin": "https://evil.example"}).status_code, 403)
        self.assertEqual(self.client.get("/api/library", headers={"X-Editstyle-Token": "bad"}).status_code, 403)
        result = self.client.post("/api/model/connect", json={"base_url": "bad", "model": "", "api_key": "do-not-echo"})
        self.assertEqual(result.status_code, 422)
        self.assertNotIn("do-not-echo", result.text)

    def test_end_to_end_media_model_proposal_revision_export_and_restart(self):
        source = self.root / "source.mp4"
        run(["ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30",
             "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3",
             "-c:v", "libx264", "-c:a", "aac", str(source)])
        with source.open("rb") as stream:
            response = self.client.post("/api/media", files={"file": ("test.mp4", stream, "video/mp4")})
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()
        self.assertEqual(item["frames"], 90)
        self.assertEqual(len(item["samples"]), 8)
        self.assertEqual(self.client.get(f"/media/{item['id']}/source.mp4", headers={"Range": "bytes=0-99"}).status_code, 206)
        document = "# Saved test\n> EDITSTYLE v1\n## Rules\n- Preserve meaning."
        saved = self.client.post("/api/styles", json={"markdown": document}).json()
        payload = {"media_id": item["id"], "style_id": saved["id"], "send_frames": False}
        self.assertEqual(self.client.post("/api/plans/generate", json=payload).status_code, 400)
        captured = []

        def fake_provider(config, system, content):
            captured.append(content)
            if "testing a connection" in system:
                text = "ready"
            elif '"markdown"' in system:
                text = json.dumps({"markdown": document})
            else:
                text = json.dumps({"summary": "Fixture proposal", "clips": [
                    {"start": 0.5, "end": 1, "reason": "fixture", "caption": "첫 장면"},
                    {"start": 2, "end": 3, "reason": "fixture", "caption": "다음 장면"}], "notes": []})
            return {"text": text, "model": config.model, "usage": {"total_tokens": 1}}
        self.app.state.complete = fake_provider
        connected = self.client.post("/api/model/connect", json={"base_url": "http://localhost:1234/v1", "model": "fixture", "api_key": "ram-only-test"})
        self.assertEqual(connected.status_code, 200)
        extracted = self.client.post("/api/styles/extract", json={**payload, "send_frames": True})
        self.assertEqual(extracted.status_code, 200, extracted.text)
        self.assertEqual(sum(part["type"] == "image_url" for part in captured[-1]), 8)
        response = self.client.post("/api/plans/generate", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        plan = response.json()
        self.assertIsInstance(captured[-1], str)
        self.assertNotIn("ram-only-test", json.dumps(captured))
        revision = self.client.put(f"/api/plans/{plan['id']}", json={"summary": "Reviewed", "clips": [
            {"start": 0.5, "end": 1, "reason": "a", "caption": "첫 장면"},
            {"start": 2, "end": 3, "reason": "b", "caption": "다음 장면"}], "notes": []}).json()
        self.assertNotEqual(plan["id"], revision["id"])
        response = self.client.post(f"/api/plans/{revision['id']}/export")
        self.assertEqual(response.status_code, 200, response.text)
        exported = response.json()
        folder = self.root / "workspace" / "exports" / exported["id"]
        with zipfile.ZipFile(folder / "editstyle.zip") as bundle:
            self.assertIn("clips/002.mp4", bundle.namelist())
            self.assertIn("timeline.xml", bundle.namelist())
            self.assertIn("source.mp4", bundle.namelist())
        for name, adapter in (("timeline.otio", None), ("timeline.xml", "fcp_xml")):
            timeline = otio.adapters.read_from_file(str(folder / name), adapter_name=adapter)
            self.assertAlmostEqual(timeline.duration().to_seconds(), 1.5)
            self.assertEqual(len(timeline.tracks), 2)
            self.assertEqual(len(timeline.tracks[0]), 2)
            self.assertAlmostEqual(timeline.tracks[0][1].source_range.start_time.to_seconds(), 2)
        xml = ET.parse(folder / "timeline.xml")
        self.assertEqual(xml.findtext(".//sequence/media/video/format/samplecharacteristics/width"), "160")
        self.assertEqual(xml.findtext(".//sequence/media/audio/track/clipitem/sourcetrack/mediatype"), "audio")
        self.assertEqual(probe(folder / "preview.mp4")["frames"], 45)
        self.assertEqual(self.client.get(exported["download"]).status_code, 200)
        for path in (self.root / "workspace").rglob("*.json"):
            self.assertNotIn("ram-only-test", path.read_text())
        restarted = TestClient(create_app(self.root / "workspace"))
        bootstrap = restarted.get("/api/bootstrap").json()
        self.assertFalse(bootstrap["connected"])
        restarted.headers["X-Editstyle-Token"] = bootstrap["token"]
        self.assertEqual(restarted.get(f"/api/styles/{saved['id']}").json()["markdown"], document)
        restarted.close()

    def test_no_audio_render(self):
        from editstyle.editing import export_bundle
        source = self.root / "silent.mp4"
        run(["ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30",
             "-t", "1", "-c:v", "libx264", str(source)])
        plan = validate(Proposal(summary="silent", clips=[{"start": 0, "end": 0.5, "reason": "test"}]), {"frames": 30})
        plan["style_markdown"] = "# test\n> EDITSTYLE v1\n"
        export_bundle(plan, {"frames": 30, "has_audio": False, "width": 160, "height": 90}, source, self.root / "export")
        self.assertEqual(probe(self.root / "export/preview.mp4")["frames"], 15)


if __name__ == "__main__":
    unittest.main()
