"""Build unsigned development bundles, not an Adobe-signed CCX or native installer."""

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(destination):
    destination.mkdir(parents=True, exist_ok=True)
    bundles = []
    for host in ("premiere", "resolve"):
        files = [p for p in (ROOT / "plugins" / host).iterdir() if p.is_file()]
        path = destination / f"editstyle-{host}-dev.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for source in sorted(files):
                archive.write(source, f"editstyle-{host}/{source.name}")
            archive.write(ROOT / "docs" / "PLUGINS.md", f"editstyle-{host}/INSTALL.md")
        bundles.append({"host": host, "file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        "distribution": "unsigned-development", "host_runtime_verified": False})
    (destination / "checksums.json").write_text(json.dumps(bundles, indent=2) + "\n", encoding="utf-8")
    return bundles


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "plugins")
    print(json.dumps(build(parser.parse_args().out), indent=2))
