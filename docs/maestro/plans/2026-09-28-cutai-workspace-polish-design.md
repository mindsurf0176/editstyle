---
title: CutAI video-first workspace polish
created: 2026-09-28
status: approved
authors: [User, Codex]
type: design
design_depth: quick
task_complexity: medium
---

# CutAI workspace polish

## Problem Statement

The current editor gives too much width to chat and the inspector, uses low-contrast
small text on navy surfaces, and blurs the distinction between saving a project and
exporting a video. The user approved a Runway-inspired monochrome, video-first
direction and its application to the actual desktop on 2026-09-28 ("그래").

## Requirements

- Keep the footage and source-time timeline prominent, including at 1024px width.
- Make AI instructions collapsible without losing chat drafts or in-flight work.
- Clarify tool selection, Keep/Remove labels, saved state and preview/export actions.
- Preserve project persistence, recovery choices, source-missing guards, undo, stale
  response guards and rendering semantics. No provider, API, database or package changes.
- Keep the existing English UI language; no unrelated translation or brand rename.
- Preserve the existing companion/plugin DESIGN.md content as a separate scope.

## Approach

Selected: refine the existing React/Tailwind/Tauri surfaces. Primary visual reference
is the bundled Runway design reference: neutral near-black surfaces, restrained
geometry, no decorative gradients/shadows, footage as the only rich visual asset.
The existing CutAI workflow and Refero craft rules supply interaction and accessibility
details. Do not transplant a marketing hero into the editor.

Rejected: a CSS-only recolor leaves the canvas cramped; replacing the editor architecture
would risk the recently verified persistence contract and exceed this visual request.

## Architecture

App workspace shell → persistent project bar + collapsible instruction panel + canvas
and source timeline + inspector. Panel visibility is presentation state, not project data.
Use existing components and local state; keep a hidden chat mounted so drafts survive.
No fabricated AI or waveform activity. Existing source footage supplies all imagery.

## Agent Team

1. Design system engineer: desktop-scoped DESIGN.md additions and CSS tokens.
2. Coder: consume those tokens and refine workspace components.
3. Tester: interaction regressions, real-backend screenshots and evidence document.
Independent read-only code review follows. Dependencies require sequential execution.

## Risk Assessment

- Hidden-panel state loss: keep the component mounted and test draft preservation.
- Crowded small windows: verify 1024, 1280 and 1440px layouts and short-height scrolling.
- Inert/recovery regression: retain guards and run the complete desktop suite.
- Token contrast: measure normal, secondary and muted text against their actual surfaces.

## Success Criteria

Build and full desktop tests pass; explicit collapse/reopen tests pass; actual rendered
screens show no clipped primary controls; empty and loaded states remain usable; source
editing and save/recovery controls remain reachable. No claim of packaged release.
