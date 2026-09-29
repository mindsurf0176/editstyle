# CutAI / editstyle foundations

2026-09-28 · First reliability milestone verified locally on `revival/cutai-editor`. Not a production release or complete editor.

## Product responsibilities

editstyle stores editing taste, observations and application instructions in portable style files and supplies them through a skill/read-only MCP. The host agent owns model calls and existing-editor connections. CutAI remains a separate local editor, with its own source media, editing plan and renderer. Success in either track is not evidence of the other track's integration or editing quality.

## First reliability milestone

An imported source, its completed analysis and the user's editing plan must survive restarting both the desktop and Python backend. Undo and output preferences belong to the project. In-flight jobs, previews and unsaved export artifacts are transient and must not be restored as completed work.

Project state lives in a versioned SQLite database beneath `CUTAI_DATA_DIR` (default `~/.cutai/data`). Imported source copies live in its `media` directory. Server-owned paths and analysis cannot be replaced by client autosave data. A save acknowledges a particular revision; later local edits remain unsaved until their own commit succeeds.

Invalid storage, unsupported schema, missing media and save conflicts are explicit errors. They must not cause a new empty project to overwrite the saved one. A local draft journal protects pending edits, with explicit conflict handling when the saved version changed elsewhere. The app must never display “Saved” solely because a request was sent.

Draft records have independent window/controller owners. On a new session, choose **Recover copy** for an unsaved recovery record or **Open saved version** to keep working from the server. Opening saved state leaves other windows' copies intact. A successful save only removes this controller's record; exact-generation markers track copies already recovered and committed without hiding newer edits from their original window. A pending undo is not considered settled just because it currently matches the server.

### Storage and API contract

- `projects.sqlite3` stores one project per imported video. No migration from the old temporary upload registry is implied; import those files again.
- `GET /api/projects/current`, `GET /api/projects`, and `GET /api/projects/{id}` read saved projects. `POST /api/projects/{id}/open` selects the active project. Saving an inactive project does not change that pointer.
- `PUT /api/projects/{id}` takes `schema_version: 1`, `expected_revision`, and `state`. A successful SQLite transaction advances the revision; a stale revision returns HTTP 409.
- Saved editor state includes the edit plan, up to 20 undo states, preview/render/subtitle settings, planning style preset, transcription-on-import preference, and the source playhead. Source metadata and completed analysis are server-owned.
- Chat messages, timeline selection, running jobs, preview URLs and output history are not restored. The playhead is the last position committed by pausing, releasing a scrub, or marking in/out. Playback does not save every frame. Projects saved before this field reopen at the start. Exported media must be saved separately; completed exports are not project backups.
- Missing source files preserve the snapshot. Restore the file to its original managed location and choose **Check source again**. Relinking arbitrary replacement footage is not implemented.
- Storage errors, malformed records and unsupported schemas fail visibly. They are not automatically reset. Browser recovery storage is an additional draft safeguard, not a substitute for backing up the data directory.

The local API remains a loopback desktop service, not an authenticated remote multi-user service. Browser mutations from unapproved origins are rejected. Do not expose it publicly.

## Editing invariants

- Times refer to the source video, not the evolving output.
- Every interval is finite and satisfies `0 <= start < end <= source duration`.
- The source duration uses the existing millisecond metadata precision consistently. Preview proxies carry that original boundary even if their encoded duration differs; this is not permission to clamp out-of-range edits.
- Explicit Keep ranges establish the retained source; Remove ranges subtract from it. With no Keep operations, start with the whole source.
- Overlapping/adjacent ranges merge, source order is retained, and removing everything is an error.
- Preview and final render use the same cut contract.
- Output paths must not overwrite source media or project storage.
- Unsupported effect combinations fail explicitly; saving a draft is distinct from successfully rendering it.

For a 36-second source, Keep `[0,18)` plus Remove `[6,12)` means `[0,6)` and `[12,18)`, totaling 12 seconds. It must never retain `[18,36)`.

## Acceptance evidence

The milestone was checked against all of these:

1. Import, analyze, edit, save, restart backend, reopen the same project and render the same plan.
2. Reload the actual desktop/web surface and recover plan, preferences and undo.
3. Two saves using one revision cannot silently overwrite each other.
4. A late save acknowledgement cannot clear newer unsaved work or switch projects.
5. Missing source or corrupt/unsupported project records retain saved editing intent and block destructive fallback.
6. Actual-media cut tests verify source frames, duration, retained audio and complete decoding.
7. Test data is isolated from the user's project directory; external LLM calls are not part of this milestone.

### Reproducible checks

```bash
uv sync --extra cutai --extra app --extra mcp --extra dev
.venv/bin/python -m pytest tests -q
.venv/bin/python scripts/qa-cutai-projects.py --job-timeout 120
cd desktop
pnpm test
pnpm build
```

The project QA starts and terminates its own backend processes on an unused port, with a new data directory under `out/cutai-projects-qa-*`. It generates a 20-second source with audio by default; `--source /absolute/path/video.mp4` accepts an existing source. It does not use the user's default data directory or an external model. The report records process restart, revision conflicts, missing media, source hashes, HTTP protections, video/audio output and full decode results.

Actual-media tests also cover a fractional source boundary (`10.010667` seconds represented as `10.011`), preserving the last frame through direct cuts, saved-plan rendering and preview. A further `0.001` second beyond that boundary is rejected. Source-path, symlink, hardlink and derived subtitle-sidecar alias protections run before rendering.

### Results on 2026-09-28

- Python: **483 tests and 40 subtests passed**. Four existing OTIO dependency deprecation warnings remain.
- Desktop: **167 tests passed**, TypeScript and production frontend build passed. This is not a packaged native release.
- Targeted Ruff and `git diff --check` passed. Independent source review approved the bounded foundations scope after correcting shared-journal deletion, pending-undo recovery, stale style completion and missing-job WebSocket handling.
- `qa-cutai-projects.py`: generated 20-second media and an existing 36-second clip both passed separate process-restart runs. Reopened mixed Keep/Remove output was 8.042667 seconds for preview and 8.053 seconds for render, with audio, dimensions, full decode and unchanged source hashes confirmed. Latest generated-media rerun: `out/cutai-projects-qa-20260928T061032427003Z/report.json`; existing-media run: `out/cutai-projects-qa-20260928T060316006263Z/report.json`.
- Native Tauri development window: changed preview preference, removed a cut, terminated and relaunched the process, recovered the saved plan/preferences, then undid the removal successfully. Final frontend reopened the saved 36-second source, eight scenes and three-operation plan. Screenshots: `out/foundation-manual/native-restored.png`, `native-undo.png`, `native-final.png`. The existing debug Rust binary loaded the current Vite frontend; this does not prove a redistributable installer.
- Browser against the real backend: failed PUT retained a local draft; reload plus explicit recovery committed it; independent clients exposed HTTP 409 and required a choice. Two tabs sharing the **same localStorage** kept the conflicted tab's draft through another tab's successful and subsequent saves, then recovered it after reload. Reports: `out/foundation-manual/browser-report.json` and `browser-shared-storage-report.json`.
- Actual UI import/analysis, immediate edit-then-project-switch, missing-source gating and source recheck passed: `out/foundation-manual/browser-projects-report.json`.
- Restarting the backend after job creation but before the UI's WebSocket connection produced a real unknown-job message/HTTP 404. The UI reported interruption, preserved the plan, remained mounted and unlocked controls: `out/foundation-manual/browser-job-restart-report.json`.

The browser harness delays/aborts selected requests to exercise failures; it does not substitute fake project or analysis responses. Runtime evidence stays in ignored `out/`. CI now includes generated-media process-restart acceptance; the results above are local evidence, not a claim about an unobserved remote CI run.

## Remaining product gates

- Verify real speech transcription and model-generated editing against labeled footage, including errors and correction workflows.
- Support effect combinations only after one consistent source-to-output time mapping handles cuts, speed, subtitles and transitions.
- Prove editstyle in one real external editor: same source, two documented styles, actual timeline inspection and rendered comparison. Repeat separately for each supported editor/version.
- Test long and variable-frame-rate footage, vertical/rotated media, unsupported codecs, interrupted imports and resource pressure.
- Deliver a redistributable runtime and verify installation on a clean machine before calling this a released desktop product.

These gates remain separate from automated test counts and from restoring the historical CutAI code.
