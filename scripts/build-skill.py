"""Build the portable editstyle skill ZIP using only the Python standard library."""

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from editstyle.catalog import read_style  # noqa: E402

SKILL_FILES = {
    "SKILL.md",
    "references/editstyle.md",
    "references/editor-handoff.md",
    "assets/EDITSTYLE.template.md",
}
OPTIONAL_SKILL_FILES = {"agents/openai.yaml"}
PRESET_FILES = {
    "cinematic.md", "cooking-show.md", "music-video.md", "podcast-clip.md",
    "shorts-reels.md", "tech-review.md", "vlog-casual.md",
}
ALLOWED_SUFFIXES = {".md", ".yaml", ".json"}


def read_files(directory: Path, required: set[str], optional: set[str]) -> dict[str, bytes]:
    """Read explicitly named files, rejecting links, unknown entries and path escapes."""
    current = ROOT
    for part in directory.relative_to(ROOT).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Symlinks are not allowed: {current}")
    if not directory.is_dir() or not directory.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError(f"Missing or unsafe source directory: {directory}")
    allowed = required | optional
    allowed_dirs = {
        parent.as_posix()
        for name in allowed
        for parent in Path(name).parents
        if parent != Path(".")
    }
    files = {}
    for path in sorted(directory.rglob("*")):
        name = path.relative_to(directory).as_posix()
        if path.is_symlink() or not path.resolve().is_relative_to(directory.resolve()):
            raise ValueError(f"Symlink or path escape is not allowed: {path}")
        if path.is_dir() and name in allowed_dirs:
            continue
        if not path.is_file() or name not in allowed or path.suffix not in ALLOWED_SUFFIXES:
            raise ValueError(f"Unexpected bundle source: {path}")
        content = path.read_bytes()
        if not content.strip():
            raise ValueError(f"Empty bundle source: {path}")
        files[name] = content
    missing = required - files.keys()
    if missing:
        raise ValueError(f"Missing required bundle files: {', '.join(sorted(missing))}")
    return files


def build(destination: Path) -> list[dict]:
    skill = read_files(ROOT / "skills" / "editstyle", SKILL_FILES, OPTIONAL_SKILL_FILES)
    presets = read_files(ROOT / "editstyle" / "presets", PRESET_FILES, set())
    for content in presets.values():
        read_style(content.decode("utf-8"))
    files = {f"editstyle/{name}": data for name, data in skill.items()}
    files.update({f"editstyle/presets/{name}": data for name, data in presets.items()})
    destination.mkdir(parents=True, exist_ok=True)
    path = destination / "editstyle-skill.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    bundles = [{
        "skill": "editstyle",
        "file": path.name,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }]
    (destination / "checksums.json").write_text(json.dumps(bundles, indent=2) + "\n", encoding="utf-8")
    return bundles


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "skills")
    args = parser.parse_args()
    try:
        result = build(args.output)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2))
