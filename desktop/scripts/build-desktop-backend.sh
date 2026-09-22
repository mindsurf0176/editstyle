#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/desktop"
GEN_DIR="$DESKTOP_DIR/src-tauri/gen/backend"
RUNTIME_DIR="$GEN_DIR/runtime"
DEFAULT_PYTHON="${CUTAI_DESKTOP_BUNDLE_PYTHON:-python3}"
BUNDLED_FFMPEG_PATH="${CUTAI_DESKTOP_BUNDLED_FFMPEG_PATH:-}"
BUNDLED_FFPROBE_PATH="${CUTAI_DESKTOP_BUNDLED_FFPROBE_PATH:-}"

log() {
  printf '[backend-bundle] %s\n' "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

require_cmd "$DEFAULT_PYTHON"

rm -rf "$GEN_DIR"
mkdir -p "$GEN_DIR"
cat > "$GEN_DIR/.gitignore" <<'EOF'
*
!.gitignore
EOF

log "Creating isolated backend runtime with $DEFAULT_PYTHON"
"$DEFAULT_PYTHON" -m venv --copies "$RUNTIME_DIR"

RUNTIME_PYTHON="$RUNTIME_DIR/bin/python"
RUNTIME_PIP="$RUNTIME_DIR/bin/pip"

log "Installing CutAI backend into the bundled runtime"
"$RUNTIME_PIP" install --upgrade pip setuptools wheel
"$RUNTIME_PIP" install "$ROOT_DIR[cutai]"

python_version="$("$RUNTIME_PYTHON" -c 'import platform; print(platform.python_version())')"
release_ready=false
release_blockers=(
  "Bundled backend runtime is built with python -m venv --copies from the release machine and is not guaranteed to be relocatable across clean user machines."
)

ffmpeg_mode="external"
ffprobe_mode="external"
ffmpeg_manifest_path=""
ffprobe_manifest_path=""

if [[ -n "$BUNDLED_FFMPEG_PATH" || -n "$BUNDLED_FFPROBE_PATH" ]]; then
  if [[ -z "$BUNDLED_FFMPEG_PATH" || -z "$BUNDLED_FFPROBE_PATH" ]]; then
    printf 'CUTAI_DESKTOP_BUNDLED_FFMPEG_PATH and CUTAI_DESKTOP_BUNDLED_FFPROBE_PATH must be set together.\n' >&2
    exit 1
  fi

  [[ -f "$BUNDLED_FFMPEG_PATH" ]] || {
    printf 'Bundled FFmpeg binary not found: %s\n' "$BUNDLED_FFMPEG_PATH" >&2
    exit 1
  }
  [[ -f "$BUNDLED_FFPROBE_PATH" ]] || {
    printf 'Bundled FFprobe binary not found: %s\n' "$BUNDLED_FFPROBE_PATH" >&2
    exit 1
  }

  mkdir -p "$GEN_DIR/tools"
  install -m 0755 "$BUNDLED_FFMPEG_PATH" "$GEN_DIR/tools/ffmpeg"
  install -m 0755 "$BUNDLED_FFPROBE_PATH" "$GEN_DIR/tools/ffprobe"
  ffmpeg_mode="bundled"
  ffprobe_mode="bundled"
  ffmpeg_manifest_path="tools/ffmpeg"
  ffprobe_manifest_path="tools/ffprobe"
  log "Bundled FFmpeg/FFprobe binaries into app resources"
else
  release_blockers+=(
    "FFmpeg and FFprobe are not bundled. Packaged builds still depend on external tools from PATH unless CUTAI_DESKTOP_BUNDLED_FFMPEG_PATH and CUTAI_DESKTOP_BUNDLED_FFPROBE_PATH are provided."
  )
fi

cat > "$GEN_DIR/run-backend.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$SCRIPT_DIR/tools/ffmpeg" ]]; then
  export CUTAI_FFMPEG_PATH="$SCRIPT_DIR/tools/ffmpeg"
fi
if [[ -x "$SCRIPT_DIR/tools/ffprobe" ]]; then
  export CUTAI_FFPROBE_PATH="$SCRIPT_DIR/tools/ffprobe"
fi
exec "$SCRIPT_DIR/runtime/bin/python" -m cutai.desktop_backend "$@"
EOF
chmod +x "$GEN_DIR/run-backend.sh"

python_reason="Built from the release machine with python -m venv --copies; this bundle is suitable for local validation only and is not treated as a redistributable portable runtime."
RELEASE_BLOCKERS="$(printf '%s\n' "${release_blockers[@]}")" \
MANIFEST_PATH="$GEN_DIR/manifest.json" \
PYTHON_VERSION="$python_version" \
PYTHON_REASON="$python_reason" \
FFMPEG_MODE="$ffmpeg_mode" \
FFPROBE_MODE="$ffprobe_mode" \
FFMPEG_MANIFEST_PATH="$ffmpeg_manifest_path" \
FFPROBE_MANIFEST_PATH="$ffprobe_manifest_path" \
RELEASE_READY="$release_ready" \
"$RUNTIME_PYTHON" - <<'PY'
import json
import os
from pathlib import Path

release_blockers = [
    line for line in os.environ.get("RELEASE_BLOCKERS", "").splitlines() if line.strip()
]

manifest = {
    "entrypoint": "run-backend.sh",
    "module": "cutai.desktop_backend",
    "python": "runtime/bin/python",
    "release_ready": os.environ["RELEASE_READY"].lower() == "true",
    "runtime": {
        "mode": "venv-copy",
        "portable": False,
        "python_version": os.environ["PYTHON_VERSION"],
        "reason": os.environ["PYTHON_REASON"],
    },
    "tools": {
        "ffmpeg": {
            "mode": os.environ["FFMPEG_MODE"],
            "path": os.environ["FFMPEG_MANIFEST_PATH"] or None,
        },
        "ffprobe": {
            "mode": os.environ["FFPROBE_MODE"],
            "path": os.environ["FFPROBE_MANIFEST_PATH"] or None,
        },
    },
    "release_blockers": release_blockers,
}

Path(os.environ["MANIFEST_PATH"]).write_text(json.dumps(manifest, indent=2) + "\n")
PY

if [[ ! -x "$RUNTIME_PYTHON" ]]; then
  printf 'Bundled backend runtime missing executable python: %s\n' "$RUNTIME_PYTHON" >&2
  exit 1
fi

log "Bundled backend prepared at $GEN_DIR"
if [[ "$release_ready" != "true" ]]; then
  log "Release readiness: blocked"
  for blocker in "${release_blockers[@]}"; do
    log "Blocker: $blocker"
  done
fi
