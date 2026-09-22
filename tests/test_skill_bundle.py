"""Portable skill packaging integrity, reproducibility and source boundaries."""

import hashlib
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from editstyle.catalog import read_style

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "build-skill.py"
SKILL_FILES = {
    "SKILL.md", "references/editstyle.md", "references/editor-handoff.md",
    "assets/EDITSTYLE.template.md",
}
PRESET_IDS = {
    "cinematic", "cooking-show", "music-video", "podcast-clip",
    "shorts-reels", "tech-review", "vlog-casual",
}


class SkillBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "source"
        shutil.copytree(ROOT / "skills" / "editstyle", self.root / "skills" / "editstyle")
        shutil.copytree(ROOT / "editstyle" / "presets", self.root / "editstyle" / "presets")
        self.skill = self.root / "skills" / "editstyle"
        self.presets = self.root / "editstyle" / "presets"
        self.output = Path(self.temporary.name) / "output"
        self.build = runpy.run_path(str(SCRIPT))["build"]
        patcher = patch.dict(self.build.__globals__, {"ROOT": self.root})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_bundle_contains_only_exact_portable_files_and_unzips_without_checkout(self):
        bundles = self.build(self.output)
        expected = {f"editstyle/{name}" for name in SKILL_FILES}
        expected.update(f"editstyle/presets/{style_id}.md" for style_id in PRESET_IDS)
        archive_path = self.output / "editstyle-skill.zip"
        extracted = Path(self.temporary.name) / "installed"
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(archive.namelist(), sorted(expected))
            for entry in archive.infolist():
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(entry.external_attr >> 16, 0o100644)
                self.assertNotIn("..", Path(entry.filename).parts)
                self.assertFalse(Path(entry.filename).is_absolute())
            for name in SKILL_FILES:
                self.assertEqual(archive.read(f"editstyle/{name}"), (self.skill / name).read_bytes())
            for style_id in PRESET_IDS:
                content = archive.read(f"editstyle/presets/{style_id}.md")
                self.assertEqual(content, (self.presets / f"{style_id}.md").read_bytes())
                self.assertTrue(read_style(content.decode("utf-8"))["name"])
            archive.extractall(extracted)
        installed_skill = extracted / "editstyle"
        shutil.rmtree(self.root)
        template = (installed_skill / "assets" / "EDITSTYLE.template.md").read_text(encoding="utf-8")
        self.assertTrue(read_style(template)["name"])
        for name in SKILL_FILES:
            document = installed_skill / name
            for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", document.read_text(encoding="utf-8")):
                if "://" not in target and not target.startswith("#"):
                    self.assertTrue((document.parent / target.split("#")[0]).exists(), target)
        self.assertEqual(json.loads((self.output / "checksums.json").read_text()), bundles)
        self.assertEqual(bundles, [{
            "skill": "editstyle", "file": "editstyle-skill.zip",
            "sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
        }])

    def test_archive_and_checksums_ignore_source_mtime_and_permissions(self):
        self.build(self.output)
        first_zip = (self.output / "editstyle-skill.zip").read_bytes()
        first_checksums = (self.output / "checksums.json").read_bytes()
        for path in self.root.rglob("*"):
            if path.is_file():
                os.utime(path, (1_700_000_000, 1_700_000_000))
                path.chmod(0o600)
        self.build(self.output)
        self.assertEqual((self.output / "editstyle-skill.zip").read_bytes(), first_zip)
        self.assertEqual((self.output / "checksums.json").read_bytes(), first_checksums)

    def test_unexpected_files_and_private_or_cache_paths_fail_before_output(self):
        for name in (".env", "private.json", "notes.md", "cache/item.yaml", "run.py", "../../private.md"):
            with self.subTest(name=name):
                target = self.skill / name
                if ".." in Path(name).parts:
                    # Data outside the skill is never traversed or bundled.
                    target.write_text("private fixture", encoding="utf-8")
                    self.build(self.output)
                    with zipfile.ZipFile(self.output / "editstyle-skill.zip") as archive:
                        self.assertNotIn(b"private fixture", b"".join(archive.read(n) for n in archive.namelist()))
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("private fixture", encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "Unexpected"):
                        self.build(self.output)
                target.unlink()
                if name == "cache/item.yaml":
                    target.parent.rmdir()

    def test_missing_required_skill_or_preset_and_invalid_preset_are_rejected(self):
        for target in [*(self.skill / name for name in SKILL_FILES), self.presets / "cinematic.md"]:
            with self.subTest(target=target):
                content = target.read_bytes()
                target.unlink()
                with self.assertRaisesRegex(ValueError, "Missing required"):
                    self.build(self.output)
                target.write_bytes(content)
        (self.presets / "cinematic.md").write_text("# Missing marker", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Missing blockquote"):
            self.build(self.output)
        self.assertFalse(self.output.exists())

    def test_symlink_file_directory_and_source_parent_are_rejected(self):
        target = self.skill / "SKILL.md"
        content = target.read_bytes()
        external = Path(self.temporary.name) / "outside.md"
        external.write_bytes(content)
        target.unlink()
        target.symlink_to(external)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            self.build(self.output)
        target.unlink()
        target.write_bytes(content)
        linked = self.skill / "linked"
        linked.symlink_to(self.presets, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            self.build(self.output)
        linked.unlink()
        skills = self.root / "skills"
        moved = Path(self.temporary.name) / "moved-skills"
        skills.rename(moved)
        skills.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            self.build(self.output)
        self.assertFalse(self.output.exists())

    def test_cli_builds_to_requested_directory_with_only_standard_library(self):
        result = subprocess.run(
            [sys.executable, "-S", str(SCRIPT), "--output", str(self.output)],
            cwd=self.temporary.name, capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.output / "editstyle-skill.zip").is_file())
        self.assertEqual(json.loads(result.stdout), json.loads((self.output / "checksums.json").read_text()))


if __name__ == "__main__":
    unittest.main()
