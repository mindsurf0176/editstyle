---
title: CutAI foundations
created: 2026-09-28
status: implementation-authorized
design_depth: standard
task_complexity: complex
---

# CutAI foundations

## Scope and authorization

The user asked to build properly from solid foundations after the functional-completeness assessment. Earlier product decisions remain: editstyle supplies portable style knowledge; the preserved CutAI desktop is a separate editing/runtime track. This is the first reliability milestone, not a promise of complete professional editing or verified external-editor compatibility. Existing authorization covers implementation and verification; routine storage and test choices do not need a repeated approval dialogue.

## Problem and requirements

1. Project editing state currently disappears on reload. Backend video and analysis registries also disappear on process exit, while uploaded media resides in temporary storage.
2. Keep/remove operations mixed in a single plan ignore the keep intervals. Out-of-source ranges reach the cutter. An all-removed direct cutter call silently copies the input.
3. A usable foundation must preserve imported media, analysis, editing plan, undo history and output preferences across UI/backend restarts. Transient jobs must not reappear as running or completed without evidence.
4. Failed writes, unavailable/missing media, unsupported schema, and stale concurrent saves must surface actionable errors and never silently replace valid saved work.
5. Preview and render must share the same validated source-time cut semantics, with tests checking actual frames and audio as well as API responses.

## Approach and alternatives

Keep the existing Python/FastAPI + React/Tauri stack. Use backend-owned local project storage with versioned records, atomic transactions, revision checks, and durable imported media. Prefer SQLite from the standard library for transactional records and compare-and-swap updates. Persist only explicitly modeled editor state. A small local recovery buffer may protect changes pending server acknowledgement, but browser storage is not the authoritative project catalog.

Browser-only persistence would keep the stale video IDs and fail on backend restart. Whole-store serialization would resurrect invalid jobs and couple file schema to transient UI details. A complete editor rewrite would expand scope without correcting these failure modes sooner.

Cut contract: validate finite source duration and finite ranges with 0 <= start < end <= duration; merge explicit keep ranges or start with the full source if none; subtract remove ranges from that base. Empty output is an error. Same contract in Python and TypeScript, tested with shared behavioral cases.

## Data flow

Import -> durable backend media/video record -> analysis persisted -> desktop plan/undo/preferences -> revision-checked project save -> project list/reopen -> fresh backend media/analysis resolution -> edit/preview/render.

## Risks and validation

- Lost save acknowledgements: serialize saves, retain dirty draft, resolve revisions explicitly; never label newer unsaved changes as saved.
- Hydration races: block editing until restoration finishes; invalidate old callbacks on source/project change.
- Corrupt or missing data: preserve bytes and report errors, no reset-to-empty overwrite.
- Interrupted jobs: clear transient work on restart; preserve editing intent and allow retry without claiming success.
- User data: tests use isolated CUTAI_DATA_DIR and generated/media fixtures. Do not migrate unknown old temporary folders or change external editor projects.

Acceptance includes two backend processes using one isolated data directory, reopening the same edited project, stale update rejection, missing-media handling, render duration/frame checks, UI reload recovery, and independent code review.

## Subsequent product gates

Real LLM/transcription evaluation; complex effect combinations; a real external editor receiving two distinct style profiles on the same source; portable signed distribution. Each needs separate observable evidence and remains open after this milestone.
