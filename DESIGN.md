# editstyle companion — implementation target

2026-09-22. Direct implementation requested by the user.

## Reference lock

Primary: the existing CutAI desktop work surface (`desktop/src/App.tsx`), with
its persistent side panel, large video canvas and restrained editing controls.
Preserve the working-tool density and source preview; replace the editor's chat
surface with a style library and a reviewable list of cuts.

Secondary: DaVinci Resolve's media-pool → source viewer → in/out selection flow
(https://www.blackmagicdesign.com/products/davinciresolve/edit). Borrow timed source
navigation, not a full timeline editor. LM Studio's user-selected server/model
connection (https://lmstudio.ai/docs/developer/openai-compat) informs model settings.
Refero live tools are unavailable; bundled craft-details and visual-workflow rules
govern form labels, focus, loading/error states, and rendered QA.

## Decisions and roles

| Decision | Source | Reason |
|---|---|---|
| Library rail + source and proposal workbench | Existing desktop + user style focus | Reuse styles without hiding the current video |
| Neutral dark canvas, light text | Existing editing surface + source video role | Footage is the primary visual asset |
| Blue accent for the main action and selected style | Active selection/action role | Distinguish what will run from stored content |
| Explicit source in/out and reason rows | Resolve source marking + user review goal | Changes remain inspectable |
| Connection settings in a dialog | BYOK user request | Model selection is setup, not the main task |
| No stock/generated imagery | User footage is the asset | An empty player should describe the next action |

## Tokens

Canvas #111315; panel #191c1f; surface #22262a; border #373d43.
Primary text #f4f5f6; secondary #aeb8c2; action #92c8ff with dark text.
System sans, 14px body, 12px labels, 22px workspace heading, monospace timecodes.
Spacing 4/8/12/16/24/32; radius 6/10; no gradients or decorative shadows.

## Flow and states

Bring a local video → select/write a style → connect a model if needed → request a
proposal → review/edit source ranges and captions → export a reviewed snapshot.
Manual source-range planning works without a model. No sample activity or fake AI
responses. Explain frame transmission next to the AI action; API keys stay in
server memory. Disable only in-flight actions, announce status, preserve unsaved
edits, and invalidate downloads when the proposal changes.

Desktop: 260px library and flexible workbench. Below 800px stack the library above
the workbench. Dialogs fit the viewport; keyboard focus stays inside dialogs.
