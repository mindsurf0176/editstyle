---
title: CutAI workspace polish implementation
design_ref: 2026-09-28-cutai-workspace-polish-design.md
created: 2026-09-28
status: approved-scope
total_phases: 3
task_complexity: medium
---

# Implementation plan

## Plan Overview

Implements only the visual/workspace changes approved in conversation. Existing
React/Tailwind stack and backend contracts remain unchanged. No installation or release.

## Dependency Graph

Design/tokens → Workspace components → Verification/evidence → Independent review

## Execution Strategy

All three phases are sequential: each consumes the previous phase's visual contract.
No parallel-eligible phases (validated by Maestro); sequential mode is auto-selected.

## Phase 1: Design and tokens

Agent: design-system-engineer. Modify DESIGN.md and desktop/src/index.css only.
Preserve existing companion rules, add desktop-specific reference lock, decision ledger,
tokens, density and states. Replace navy/indigo with role-based neutrals, retain semantic
status colors. Add usable focus, reduced-motion and scrollbar treatments without new tooling.
Validation: desktop pnpm build; contrast calculations; git diff --check.
Blocked by: none. Blocks: phase 2.

## Phase 2: Workspace components

Agent: coder. Modify desktop/src/App.tsx, components/{ProjectBar,ChatPanel,CanvasPanel,
EditorTimeline,VideoPreview,EditPlanPanel,StylePanel,HighlightsPanel}.tsx and
AppMainContent.test.tsx. Narrow visual-only token/typography cleanup is also allowed
in JobProgress.tsx and legacy Sidebar/InstructionBar consumers; their behavior stays
unchanged. Use the phase 1 design contract. Add accessible panel toggle,
clear inspector selection and export hierarchy; keep all editing/persistence request guards.
Use native button semantics and labels. Avoid changing storage/API/model/renderer files.
Validation: pnpm build; pnpm test; git diff --check.
Blocked by: phase 1. Blocks: phase 3.

## Phase 3: Verification and evidence

Agent: tester. Own desktop/src/components/WorkspaceDesign.test.tsx,
docs/WORKSPACE_DESIGN.md and ignored out/workspace-design-qa/ artifacts.
Test collapse/reopen without state loss, accessible controls, recovery/inert compatibility.
Run full tests/build and real-backend browser captures at 1440,1280,1024 widths plus
short-height/empty/error states, including the native minimum 900×600 window.
Separate fixture tests from real backend evidence.
Do not modify production source; report actionable issues to the coder.
Blocked by: phase 2. Blocks: independent review.

## File Inventory

The phase file sets above are exclusive during each phase. No dependencies, lockfiles,
backend code, stored user projects, native configuration or companion UI changes.

## Risk Classification

Phase 1 low (tokens/docs); phase 2 medium (layout and mounted component lifecycle);
phase 3 low (tests/evidence). Failures return to their source owner before handoff.

## Execution Profile

3 phases, 0 parallelizable, 3 sequential. No wall-time or cost promises. Native workers
operate within the listed file ownership; main performs visual inspection and handoff.
