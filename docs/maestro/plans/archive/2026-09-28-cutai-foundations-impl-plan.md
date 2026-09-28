---
title: CutAI foundations implementation
design_ref: 2026-09-28-cutai-foundations-design.md
created: 2026-09-28
status: implementation-authorized
total_phases: 4
task_complexity: complex
---

# Implementation plan

## Strategy

Backend persistence, cut correctness, and desktop recovery have separate file ownership and run in parallel against the contract established by the read-only architecture investigation. The final phase integrates all three and verifies process restarts and real media. User authorization: “제대로 만들자 기초부터 탄탄히” following the saved-state and accuracy assessment. Execution scheduling is an implementation detail under this authorization.

## Phase 1: Durable project and media storage

Agent: coder. Files: cutai/project_store.py, cutai/server.py, tests/test_project_store.py, tests/test_server_projects.py.

Use an isolated configurable CUTAI_DATA_DIR (default ~/.cutai data), durable uploads, SQLite schema version and transactional revisions. Save backend-owned video metadata/analysis and typed editor snapshots, resolve sources on reopen. API: create/list/read/update projects; updates carry expected_revision and return canonical revision. Return conflict, missing media and schema errors without deleting data. Restart must not claim old running jobs complete. Server-specific tests must not write the real user's data directory.

Validate Python compile, targeted Ruff, and project/server pytest suites, including independent store reopen, CAS conflict, unknown/corrupt schema, source loss, registry restoration and interrupted analysis.

## Phase 2: Source-time contract

Agent: coder. Files: cutai/editor/cutter.py, cutai/editor/renderer.py, tests/test_cutter.py, tests/test_renderer.py, tests/test_cut_contract.py, desktop/src/timeline.ts, desktop/src/timeline.test.ts.

Validate finite positive source duration and in-bounds finite intervals. Keep union minus remove union; no cuts means full source. Never silently replace empty output with original video. Preview/render and source timeline use the same rules. Preserve prior unsupported-effect guards. Validate model/API boundary without expanding unrelated effects.

Run targeted Python tests and desktop timeline tests; actual generated media verifies source frames and audio for mixed operations, rejects invalid bounds, and confirms no output for all-removed plans.

## Phase 3: Desktop save and recovery

Agent: coder. Contract-first parallel implementation; no shared owned files with 1 or 2. Files: desktop/src/{App.tsx,api.ts,store.ts,types.ts,projectPersistence.ts,useProjectPersistence.ts,projectPersistence.test.ts,useProjectPersistence.test.tsx,store.project.test.ts}, desktop/src/components/{ProjectBar.tsx,ChatPanel.tsx,StylePanel.tsx,JobProgress.tsx} and their regression tests. Style completion and interrupted-job handling were added to this owner's scope after review exposed project-crossing and restart failures.

Implement typed project API, serialized autosave with revision conflict handling, recent-project reopening and last-project restore. Persist edit plan, bounded undo, render/preview/subtitle preferences and planning preset; selection and playhead remain transient. Do not restore stale preview/render/active job values. Gate hydration, maintain dirty state through failed writes and connectivity changes, make saved/saving/failed visible. Protect switching while dirty; avoid old acknowledgements crossing projects. Recovery journals must preserve independent same-origin windows' drafts. Match current UI tokens, no redesign.

Run TypeScript build and Vitest. Tests exercise reload, late responses, backend reconnect, conflict, local-draft failure, project switching, missing media and undo restoration.

## Phase 4: Acceptance and documentation

Agent: tester. Process-level acceptance depends on 1 and 2 and runs alongside desktop implementation. Root performs UI acceptance after 3. Files: scripts/qa-cutai-projects.py, docs/FOUNDATIONS.md, docs/CUTAI_RESTORATION.md, .github/workflows/cutai-editor.yml. Browser acceptance scripts/reports are isolated in ignored out/foundation-manual; no extra repository browser dependency.

Implement a bounded isolated process-level QA using real video: import/analyze/edit/save, terminate backend, restart on same data directory, reopen and render the same plan, assert media dimensions/duration/audio/decode. Exercise stale-save rejection and missing-media errors. Keep test user data isolated and no external models. Document the concrete contract, known limits, launch and verification commands, and remaining external-editor/style gates. Enable required regression checks in existing CI if necessary.

## Completion

Root runs whole Python/desktop regressions once, frontend build, actual browser/native reload path as available, and a read-only reviewer. Critical/major findings return to the owning agent. Update durable wiki. No merge/release implied. Four phases; two parallel siblings; final review serial. Main risks: data-loss races (high), imported-media ownership (high), compatibility with existing server tests (medium).
