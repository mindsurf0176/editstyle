"""Local persistence with server-generated IDs, atomic writes, and no API keys."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from uuid import uuid4

KINDS = {"styles", "media", "plans", "exports", "host_snapshots", "host_exports"}


class Workspace:
    def __init__(self, root: Path):
        self.root = root.resolve()
        for directory in KINDS:
            (self.root / directory).mkdir(parents=True, exist_ok=True, mode=0o700)

    def path(self, kind: str, identifier: str) -> Path:
        if kind not in KINDS or not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("올바르지 않은 작업 ID입니다.")
        return self.root / kind / identifier

    def save(self, kind: str, value: dict, identifier: str | None = None) -> dict:
        identifier = identifier or uuid4().hex
        target = self.path(kind, identifier).with_suffix(".json")
        value = {**value, "id": identifier}
        fd, temporary = tempfile.mkstemp(dir=target.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return value

    def read(self, kind: str, identifier: str) -> dict:
        path = self.path(kind, identifier).with_suffix(".json")
        if not path.is_file():
            raise ValueError("저장된 작업을 찾을 수 없습니다.")
        return json.loads(path.read_text(encoding="utf-8"))

    def list(self, kind: str) -> list[dict]:
        return [self.read(kind, p.stem) for p in sorted((self.root / kind).glob("*.json"),
                                                       key=lambda p: p.stat().st_mtime, reverse=True)]
