# editstyle companion — implementation target

## Native panel extension — 2026-09-22

User requested an in-editor plugin. Direct build against this existing design system;
retain neutral dense canvas, blue action role, explicit source-range review and native
text controls. Premiere UXP's official starter panel is the dominant **layout** reference
(narrow vertically scrolling tool panel); existing editstyle owns color/type tokens.
Resolve UIManager uses host-native widgets, not an attempted web visual imitation.
No generated imagery: the editor already owns footage preview.

| Decision | Source / role | Adaptation |
|---|---|---|
| Single-column 320–420px panel | Adobe official UXP panel tutorial | Setup, active sequence, review, apply in reading order |
| Existing neutral/blue tokens | Existing editstyle UI | Blue only for generate/apply; no new brand palette |
| Separate review and write action | User's editing-style workflow + craft guide | Consent lists unmapped effects; original preserved |
| Masked, cleared credential fields | BYOK constraint + craft forms | No saved API key; pairing separate from model auth |

Reference: https://developer.adobe.com/premiere-pro/uxp/plugins/ .
Refero MCP unavailable; the bundled craft/visual QA guides and these existing surfaces
are the reference lock. Browser UI QA is not proof of UXP or UIManager rendering.

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
