# CutAI Desktop (Tauri)

## 2026-09-22 restoration branch

`revival/cutai-editor` restores the editor separately from editstyle's skill-first track.
From the repository root, run `uv sync --extra cutai --extra dev` before the frontend
commands below. Imports use local scene/audio analysis by default, without speech
transcription or an LLM request. Speech transcription is an explicit checkbox and needs
the `cutai-transcription` extra plus a downloaded Whisper model.

Use Source Timeline's Start/End fields to keep/remove source-time ranges, then preview
or render from the restored Edit panel. Undo and later instructions preserve previous
manual cuts; changes invalidate generated outputs. Current edit state is not a saved
project: a reload/restart clears it. Save exported videos before leaving the session.

See [the current restoration record](../docs/CUTAI_RESTORATION.md) for evidence and
limitations. Historical validation notes below are not proof of a distributable release.

CutAI Desktop is the local macOS desktop shell for the CutAI editing engine.
It wraps the Python backend with a Tauri + React UI so the main happy path works without opening a terminal.

## Current desktop scope

Today the desktop app is focused on the practical MVP flow:

- auto-start the bundled/local CutAI backend in the native Tauri app
- upload a video from the UI
- run analysis and generate an edit plan
- review detected scenes and planned operations
- choose a style preset as planning context before creating or refining a plan
- optionally use `Apply now` when you want the preset to generate a plan immediately
- render the final video locally
- save render exports as a local artifact bundle, including subtitle sidecars when sidecar mode is selected
- surface backend/offline errors and allow retry

This is intentionally **local-first**. The app talks to a backend on `127.0.0.1:18910` and does not require a cloud upload pipeline.
The product is also intentionally honest about the bridge here: selecting a preset for planning does not silently apply edits. It only adds context to the next plan/refinement request until you clear it, while `Apply now` remains a separate explicit action.

## Status

**Alpha, but usable for the core flow.**

Recent validation confirmed:

- desktop auto-backend startup works in the native app
- upload → analyze works on the happy path
- render works on the happy path
- subtitles are burned in by default in the current pipeline, with sidecar export preserved as a saved companion artifact when selected
- warm/cinematic-style grading is available through the edit pipeline
- style presets can be kept as planning context separately from immediate `Apply now`
- refinement prompts reuse the selected planning preset as context

## Project structure

- `src/` — React UI
- `src-tauri/` — native Tauri shell and backend launcher integration
- `package.json` — desktop frontend scripts

## Development

### Prerequisites

- Node.js 20+
- pnpm
- Rust toolchain
- Python environment with the CutAI backend dependencies installed
- FFmpeg available on PATH

### Install frontend deps

```bash
cd desktop
pnpm install
```

### Run the desktop frontend in browser dev mode

```bash
cd desktop
pnpm dev
```

In browser dev mode, backend auto-start is **not** available. Start the API server manually in another terminal:

```bash
cutai server --host 127.0.0.1 --port 18910
```

Then open the Vite URL shown in the terminal.

### Run the native Tauri app

```bash
cd desktop
pnpm tauri dev
```

In the native app, CutAI will try to auto-start the local backend when the window opens.
In development, the app can still fall back to an explicit host Python/backend setup. Packaged builds now prefer a bundled backend runtime and no longer silently probe a developer machine's PATH by default.

### Production build

```bash
cd desktop
pnpm build
pnpm tauri build
```

The release build now runs `pnpm backend:bundle` automatically before Tauri packaging. That step writes backend bundle metadata under `desktop/src-tauri/gen/backend` and blocks release builds by default unless the bundle is explicitly marked release-ready.

Today the generated backend runtime is still a host-built `python -m venv --copies` environment, so it is treated as a local-validation artifact instead of a portable redistributable runtime. Release builds fail unless you deliberately bypass the guard with `CUTAI_DESKTOP_SKIP_BACKEND_BUNDLE_CHECK=1`.

If you want the packaged app to carry FFmpeg and FFprobe instead of depending on host installs, provide both binaries during bundling:

```bash
cd desktop
CUTAI_DESKTOP_BUNDLED_FFMPEG_PATH=/absolute/path/to/ffmpeg \
CUTAI_DESKTOP_BUNDLED_FFPROBE_PATH=/absolute/path/to/ffprobe \
pnpm backend:bundle
```

Without those environment variables, packaged builds still depend on external FFmpeg/FFprobe, and the startup gate says so explicitly.

### macOS external-alpha release flow

Use the dedicated release guide and helper scripts in this folder:

- [`RELEASE_MACOS.md`](./RELEASE_MACOS.md)
- `pnpm release:macos:build`
- `pnpm release:macos:notarize`
- `pnpm release:macos:verify`

The repo now includes reproducible helper scripts for app signing, DMG signing, notarization, stapling, and Gatekeeper-oriented verification. Apple credentials/certificates are still required for the actual trust-bearing steps.
The release helpers also clean stale bundle outputs before a fresh build, pick the newest DMG deterministically, and stage artifacts into a local temp directory before signing/verification so synced-workspace metadata does not poison codesign checks.

## Manual QA

Use the validation checklist in [`QA_CHECKLIST.md`](./QA_CHECKLIST.md) before calling the desktop flow release-ready.

## Known limitations

The desktop app is intentionally not pretending to be more finished than it is. Current gaps:

- preview is frame-scrubbing oriented, not full timeline playback
- final credential-backed Developer ID signing/notarization still needs one full machine validation run before wider external sharing
- browser dev mode requires manual backend startup
- packaged backend bundling is currently macOS-oriented and still not a portable Python runtime for redistribution
- packaged builds are only self-contained for media tools when FFmpeg and FFprobe are explicitly bundled during `pnpm backend:bundle`
- advanced edit flows from the CLI are not all exposed in the desktop UI yet
- large/video-edge-case coverage still needs broader QA on real creator footage

## Troubleshooting

### App says backend is unavailable

- if this is a packaged build, read the backend error text first: it now distinguishes a blocked non-portable Python bundle from missing FFmpeg/FFprobe prerequisites
- for local validation of a packaged build made from the current `venv` bundle, set `CUTAI_DESKTOP_ALLOW_UNSUPPORTED_BUNDLED_BACKEND=1`
- if FFmpeg/FFprobe were not bundled into the app, install them and make sure they are available on PATH, or set `CUTAI_FFMPEG_PATH` and `CUTAI_FFPROBE_PATH`
- in source/dev mode, confirm the Python backend environment is installed
- retry from the in-app backend gate
- in browser dev mode, make sure `cutai server --host 127.0.0.1 --port 18910` is running

### Upload or analysis fails

- test with a smaller MP4 first
- check terminal logs from the backend process
- verify the file is readable and not in an unusual codec/container

### Render fails

- verify FFmpeg works from the terminal
- check free disk space in the output directory
- retry with a shorter sample clip to isolate environment issues
