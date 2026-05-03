<p align="center"><img src="assets/icon-final.svg?v=1" width="128" alt="CutAI"></p>

# CutAI

> AI video editor with natural language instructions. Local-first, open-source.

> "Film it. Describe the edit. Done."

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/mindsurf0176-ui/cutai/blob/main/LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![PyPI version](https://img.shields.io/pypi/v/cutai.svg)](https://pypi.org/project/cutai/)
[![CI](https://github.com/mindsurf0176-ui/cutai/actions/workflows/ci.yml/badge.svg)](https://github.com/mindsurf0176-ui/cutai/actions/workflows/ci.yml)

**CutAI** is an open-source, local-first AI video editor. Give it a video and a sentence — it analyzes scenes, generates an edit plan, applies practical edits like cuts / subtitles / grading, and renders the result on your machine.

### 🆕 v0.2.0 highlights

- **🤖 Agent Mode** — goal-driven autonomous editing with self-evaluation loop
- **🔌 MCP Server** — connect CutAI to Claude Code, Cursor, and other AI agents
- **📝 EDITSTYLE.md** — portable editing style format (like DESIGN.md for video)
- **🎨 7 style presets** — cinematic, vlog, cooking, tech, music, podcast, shorts
- **⚡ Performance** — MLX Whisper (Apple Silicon), VideoToolbox hwaccel, analysis cache

### 🆕 Community contributions

- **🎙️ AI Voiceover Narration** — `cutai narrate` generates context-aware voiceover using Edge TTS (free, no API key) with 8 tone presets and 11 languages. Add `--narrate` to any `cutai edit` command.
- **🎬 Multi-Reel Generator** — `cutai reels` splits long videos into short, non-overlapping reels with scene-aware segmentation.
- **🔧 Ollama JSON Fix** — robust JSON parsing that handles markdown fences and malformed responses from Ollama, OpenAI, and Gemini backends.
- **👁️ Vision Analyzer** — extracts frames from scenes and sends them to Ollama vision models (Gemma 4, Mistral Large) for context-aware narration.

## Current status

CutAI is in an **ambitious but practical alpha** stage.

What is in solid shape right now:

- CLI happy path for `analyze`, `plan`, `edit`, `preview`, `style-*`, `highlights`, and `multi`
- local backend server for desktop integration
- desktop upload → analyze → edit plan → render happy path
- default burned-in subtitles in the current render pipeline
- local-first workflow with optional LLM planning

What is **not** fully polished yet:

- desktop preview is currently frame-scrubbing oriented, not full playback
- desktop UX still focuses on the core MVP flow rather than exposing every CLI capability
- release packaging/signing/notarization now has documented helper scripts, but still needs one successful credential-backed machine validation run before external alpha distribution
- edge-case coverage for unusual codecs, long videos, and broader creator workflows is still growing

If you want the most complete experience today, start with the **CLI**. If you want the simplest workflow for demoing the product direction, try the **desktop alpha**.

```bash
$ cutai edit vlog.mp4 -i "remove boring parts, add subtitles, make it warm and cinematic"

🎬 Analyzing vlog.mp4...
  ✅ Detected scenes
  ✅ Transcribed speech
  ✅ Found low-value segments

📋 Edit Plan:
  • Remove dead air and low-value beats
  • Add subtitles
  • Apply warm color grade

🎬 Rendering → output/vlog_edited.mp4
  ✅ Done
```

---

## Features

### Core editing
- **Natural language instructions** — describe edits in English or Korean
- **Scene detection** — content-aware scene boundary detection
- **Silence / low-value trimming** — remove dead air and weak sections
- **Auto subtitles** — Whisper-powered transcription and subtitle generation
- **Color grading** — warm / bright / cool / cinematic style adjustments
- **BGM mixing** — add background music when requested
- **Transitions and speed controls** — available in the editing pipeline

### AI Narration
- **Voiceover generation** — `cutai narrate` adds AI voiceover to any video
- **Edge TTS** — free, no API key required, 322 voices across 11 languages
- **Tone presets** — documentary, calm, excited, sad, happy, serious, funny, teacher
- **Voiceover or replace** — mix narration with original audio or replace it
- **Vision-aware** — `--vision` flag uses AI vision models to understand video frames
- **Edit integration** — add `--narrate` to any `cutai edit` command

### Multi-Reel Generator
- **Scene-aware splitting** — splits long videos into short, non-overlapping reels
- **Gap filling** — handles videos where scene detection misses large sections
- **Duration targeting** — specify target reel duration
- **Non-overlapping** — each reel is a standalone, uploadable MP4

### Edit Style Transfer
- **Style extraction** — turn a reference video's editing patterns into portable Edit DNA
- **Style application** — apply a saved style file or preset to your own video
- **Style learning** — learn a style from multiple reference videos
- **Built-in presets** — includes starter presets like `cinematic` and `vlog-casual`

### Smart highlights
- **Engagement scoring** — rank scenes by interest and energy
- **Highlight generation** — produce short reels from the strongest moments
- **Duration targeting** — fit output to a requested duration

### Local-first workflow
- **No required cloud upload** — editing runs on your machine
- **Rule-based planning works offline** — useful even without an API key
- **Optional LLM planning** — richer instruction handling when a model is configured

---

## Quick start

### Prerequisites

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y ffmpeg

# Windows (via Chocolatey)
choco install ffmpeg
```

### Installation

```bash
pip install cutai
cutai --help
```

### Your first edit

```bash
# Basic edit — remove silence and add subtitles
cutai edit video.mp4 -i "remove silence, add subtitles"

# Apply a warmer look
cutai edit vlog.mp4 -i "자막 추가, 따뜻하고 시네마틱하게"

# Generate a plan without rendering
cutai plan video.mp4 -i "remove boring parts and add subtitles"

# Quick low-res preview
cutai preview video.mp4 -i "remove boring parts"

# Add AI voiceover narration
cutai narrate video.mp4 --tone excited --language English

# Edit + narrate in one command
cutai edit video.mp4 -i "remove silence, add subtitles" --narrate --narrate-tone documentary

# Vision-aware narration (uses AI to understand video frames)
cutai narrate video.mp4 --tone documentary --vision

# Split into multiple reels
cutai reels video.mp4 -n 4 -d 60
```

---

## Desktop app (alpha)

A Tauri desktop app lives in [`desktop/`](./desktop) and is aimed at the practical non-terminal flow:

- launch the native app
- auto-start the local backend in the native shell
- upload a clip
- analyze it
- inspect the generated edit plan
- choose a style preset as planning context for the next plan/refinement
- optionally use `Apply now` to turn a preset into an immediate starting plan
- render locally

The current style-aware planning bridge is intentionally explicit:

- selecting a style preset in the desktop UI adds planning context for the next plan request
- `Apply now` is a separate action that generates a plan immediately
- refinement prompts keep using the selected preset as context until you clear it
- the app still runs through the same local backend on your machine; it is not pretending there is a hidden cloud editing step
- desktop release packaging now explicitly gates non-portable backend bundles and only becomes self-contained for FFmpeg/FFprobe when those binaries are bundled during the desktop backend step

### Desktop development

```bash
cd desktop
pnpm install
pnpm tauri dev
```

### Browser dev mode

If you run only the frontend with `pnpm dev`, backend auto-start is not available. Start the backend manually:

```bash
cutai server --host 127.0.0.1 --port 18910
```

See [`desktop/README.md`](./desktop/README.md) for the desktop-specific guide, [`desktop/RELEASE_MACOS.md`](./desktop/RELEASE_MACOS.md) for the macOS signing/notarization release path, and [`desktop/QA_CHECKLIST.md`](./desktop/QA_CHECKLIST.md) for a practical final-pass validation checklist.

---

## Commands

| Command | Description |
|---------|-------------|
| `cutai edit` | Full pipeline: analyze → plan → render |
| `cutai analyze` | Analyze video (scenes, transcript, quality) |
| `cutai plan` | Generate an edit plan without rendering |
| `cutai preview` | Generate a quick low-resolution preview |
| `cutai narrate` | 🎙️ Generate AI voiceover narration |
| `cutai reels` | 🎬 Split video into multiple short reels |
| `cutai chat` | Interactive chat-based editing session |
| `cutai highlights` | Auto-generate a highlight reel |
| `cutai engagement` | Show per-scene engagement scores |
| `cutai multi` | Combine and edit multiple video files |
| `cutai style-extract` | Extract Edit DNA from a reference video |
| `cutai style-apply` | Apply an Edit DNA style to a video |
| `cutai style-learn` | Learn style from multiple reference videos |
| `cutai style-show` | Display an Edit DNA file |
| `cutai prefs` | View or reset learned preferences |
| `cutai agent` | 🤖 Goal-driven autonomous editing agent |
| `cutai mcp-server` | 🔌 MCP Server for AI coding agent integration |
| `cutai style-convert` | Convert between EDITSTYLE.md and YAML |
| `cutai style-validate` | Validate an EDITSTYLE.md file |
| `cutai server` | Start the API server used by the desktop app |

---

## Style workflow

```bash
# 1. Extract style from a reference video
cutai style-extract reference.mp4 -o style.yaml

# 2. Inspect the extracted DNA
cutai style-show style.yaml

# 3. Apply it during editing
cutai edit myvideo.mp4 --style style.yaml

# Or use a built-in preset
cutai edit myvideo.mp4 --style cinematic
```

Edit DNA captures practical editing preferences such as pacing, transitions, visual tone, audio choices, and subtitle defaults in a portable YAML file.

---

## Agent Mode

Let the AI handle the full editing workflow autonomously:

```bash
# Single video — agent analyzes, plans, renders, evaluates, and iterates
cutai agent video.mp4 --goal "warm casual vlog with subtitles, 5 minutes max"

# Multiple clips — agent selects the best parts
cutai agent clip1.mp4 clip2.mp4 --goal "best moments reel, 3 minutes" -n 5

# With a style preset
cutai agent footage/ --goal "cinematic travel video" --editstyle EDITSTYLE.md
```

---

## EDITSTYLE.md

A portable, markdown-based format for video editing styles — like [DESIGN.md](https://designmd.ai) but for video editing.

```markdown
# My Vlog Style

> Source: custom
> CutAI EDITSTYLE v1

## Rhythm
- **Pacing**: fast (12 cuts/min)
- **Silence tolerance**: 0.8s

## Visual
- **Color temperature**: warm

## Subtitles
- **Enabled**: yes
- **Size**: large
```

Drop it in your project root → CutAI auto-detects and follows your style.

Browse presets: [`awesome-editstyles/`](awesome-editstyles/)

```bash
# Convert between formats
cutai style-convert style.yaml --to md
cutai style-validate EDITSTYLE.md
```

→ [Full spec](docs/EDITSTYLE_SPEC.md)

---

## MCP Server

Connect CutAI to AI coding agents (Claude Code, Cursor, Gemini CLI):

```json
{
  "mcpServers": {
    "cutai": {
      "command": "cutai",
      "args": ["mcp-server"]
    }
  }
}
```

8 tools exposed: analyze, plan, edit, agent, style-extract, highlights, engagement, editstyle-parse.

---

## Configuration

CutAI stores config at `~/.cutai/config.yaml`.

Common environment variables:

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Enables richer LLM-based planning |
| `OLLAMA_MODEL` | Ollama model for LLM planning and narration script generation |
| `OLLAMA_VISION_MODEL` | Vision model for scene analysis (default: mistral-large-3:675b-cloud) |
| `CUTAI_WHISPER_MODEL` | Default Whisper model size |
| `CUTAI_LLM` | Default LLM model |
| `CUTAI_OUTPUT_DIR` | Default output directory |
| `CUTAI_FFMPEG_PATH` | Custom FFmpeg binary path |

### Local-only mode

CutAI works without an API key using rule-based planning for common instructions like:

- remove silence
- add subtitles
- make it warm / cinematic
- trim boring parts

For more open-ended planning, configure an API-backed model or a local LLM setup.

---

## Architecture

```text
Analyzer → Planner → Editor / Renderer
           ↘ Style engine ↗
           ↘ Highlight / engagement ↗
           ↘ Narrator (TTS + Vision) ↗
           ↘ Reels generator ↗
```

Key modules:

- `cutai/analyzer/` — scene detection, transcription, quality signals, engagement
- `cutai/planner/` — rule-based + LLM edit planning
- `cutai/editor/` — cutter, subtitles, color, BGM, speed, transitions, render orchestration
- `cutai/narrator/` — AI voiceover narration (script generation, Edge TTS, vision analysis, audio mixing)
- `cutai/style/` — style extraction / application / learning / YAML IO
- `cutai/server.py` — backend API used by the desktop app
- `desktop/` — Tauri + React desktop shell

---

## Known limitations

These are the most relevant current gaps for contributors and testers:

- desktop preview is not a full playback/timeline experience yet
- some advanced CLI capabilities are not exposed in desktop UI yet
- performance varies heavily with source length, Whisper model, and hardware
- unusual codecs / malformed inputs still need broader robustness testing
- GPU acceleration and plugin-style extensibility are not finished

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/mindsurf0176-ui/cutai.git
cd cutai
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -v
```

Helpful contribution areas:

- better QA coverage for desktop and render edge cases
- more style presets and example projects
- documentation and onboarding improvements
- robustness fixes for analysis / render failures

---

## Roadmap

- [x] Core editing pipeline
- [x] Edit Style Transfer primitives
- [x] Highlight / engagement pipeline
- [x] Desktop happy-path backend integration
- [ ] GPU acceleration (CUDA / Metal)
- [ ] Web UI
- [ ] Plugin system for custom operations
- [ ] Community style preset marketplace
- [ ] Real-time preview during chat
- [ ] Broader desktop polish and release packaging

---

## License

[MIT](LICENSE) — free for personal and commercial use.
