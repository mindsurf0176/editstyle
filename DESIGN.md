# CutAI desktop — workspace polish, 2026-09-28

Scope: `desktop/src/` on `revival/cutai-editor`. The approved target is a neutral,
video-first editing workspace with collapsible AI instructions. The companion and
plugin design below remains a separate, unchanged scope. Keep the CutAI identity,
English UI, editing behavior and persistence contract.

## Desktop reference lock

Primary: [Runway](https://runwayml.com), using the fully reviewed bundled snapshot at
`/Users/minseo/.codex/data/references/runwayml/DESIGN.md`. This is snapshot research,
not a live-site audit.
Preserve its near-black canvas, neutral layered surfaces, restrained 4–8px geometry,
400–600 sans typography, zero decorative shadows and footage-led composition.
Its marketing display scale, generated samples and cool-slate text colors are not
desktop requirements: use the user's real video and contrast-correct work-tool text.

Secondary: the existing `App`, `ChatPanel`, `CanvasPanel` and `EditorTimeline` flow
owns project/source/selection semantics. Refero's typography, color and craft-details
guides supply readable small text, measured contrast, keyboard focus and native
controls. Refero MCP is unavailable; these bundled sources are the research basis.
Direct build was approved on 2026-09-28; no new brand discovery or generated assets.

| Decision | Source and bounded role | Desktop adaptation |
|---|---|---|
| Neutral layered canvas | Runway surfaces and footage role | `#030303` canvas, `#1a1a1a` panels, `#262626` controls; real footage owns color |
| Quiet chrome with clear selection | Runway geometry + user tool-state request | Small neutral fills, visible selected boundary and `aria-pressed`; no violet or glow |
| Readable compact typography | Runway sans + Refero work-tool typography | 14px body, 13px controls, 12px metadata minimum; monospace tabular timecodes |
| More space for footage and timeline | User brief + existing editor flow | 260px instruction panel, 280px inspector, flexible center; 48px folded AI rail |
| Distinct save and export | User brief + existing persistence contract | Project save state stays in project bar; preview/export stay with video/output controls |
| Explicit Keep/Remove semantics | Existing source editing + Refero color/focus craft | Preserve words and undo; green/red may support meaning, never replace labels |

## Desktop tokens and contrast

`desktop/src/index.css` is the implementation source. Tailwind v4 semantic utility
names are retained; conventional component tokens alias the same values. Ratios
below use sRGB relative luminance on opaque colors. Text values must not be faded
with opacity when the information is required.

| Utility role | Value | Use / contrast |
|---|---|---|
| `bg-bg-base` | `#030303` | Footage surround and application canvas |
| `bg-bg-panel` | `#1a1a1a` | Instruction panel, inspector, timeline |
| `bg-bg-surface` | `#262626` | Inputs and small contained controls |
| `bg-bg-elevated` | `#303030` | Hovered neutral controls; brightest normal text surface |
| `text-text-primary` | `#f5f5f5` | Main text; 12.11:1 on elevated, 15.96:1 on panel |
| `text-text-secondary` | `#c4c4c4` | Supporting labels; 7.57:1 on elevated, 9.98:1 on panel |
| `text-text-muted` | `#a7a7a7` | Metadata / placeholders; 5.49:1 on elevated, 7.23:1 on panel |
| `border-border` | `#27272a` | Decorative panel separators only, not control identification |
| `border-border-strong` | `#808080` | Input/selected control boundary; 3.34:1 on elevated, 4.41:1 on panel |
| `bg-accent` / `hover:bg-accent-hover` | `#eeeeee` / `#ffffff` | Restrained primary action or active tool |
| `text-on-accent` | `#141414` | Required foreground on solid accent; 15.88:1 on accent |
| `outline-focus` / `ring-focus` | `#eeeeee` | Keyboard focus; 11.38:1 against elevated |
| `text-success` / `text-warning` / `text-error` | `#34d399` / `#fbbf24` / `#f87171` | Status, Keep/Remove only; 6.87 / 7.91 / 4.77:1 on elevated |

For tinted semantic backgrounds, verify the actual composite. Solid semantic fills
use dark text (`text-bg-base`); error text must not sit on a solid error fill.
White or primary text on `bg-accent` fails: migrate existing consumers explicitly
to `text-on-accent`. Do not patch this with global selector overrides.

## Desktop typography, composition and states

Keep the existing Inter/system sans and local monospace fallback stacks; no font
download. Use `text-sm` (14px) for reading, `text-ui` (13px / 1.4) for controls,
and `text-xs` (12px) for secondary metadata. Avoid 10/11px required text. Use weights
400/500/600 and `tracking-wide` for uppercase labels. The `timecode` utility provides
monospace tabular numbers without wrapping; combine with `text-xs` or `text-ui`.
Spacing remains 4/8/12/16/24px; controls are 32–36px high, icon targets at least 32px,
with 4/6px radii and 8px only for larger containment. No decorative cards or shadows.

Use a 48–56px project bar, then three workspace columns with `min-w-0 min-h-0` on
the flexible center and independently scrolling panel bodies. Expanded AI is 260px;
the inspector is 280px; folded AI is a 48px rail with a labelled toggle. Keep chat
mounted when folded, remove its hidden controls from focus, and expose `aria-expanded`
and `aria-controls`. Collapse is local presentation state, not project data.

| Viewport | Width budget before borders | Composition commitment |
|---|---|---|
| 1440px | 260 + 900 + 280 expanded; 48 + 1112 + 280 folded | Footage remains the largest surface |
| 1280px | 260 + 740 + 280 expanded; 48 + 952 + 280 folded | Same density and readable controls |
| 1024px | 260 + 484 + 280 expanded; 48 + 696 + 280 folded | Default to folded AI when space is tight; reopening remains possible |

Use the full center width for the source timeline; do not put it inside a narrow
preview card. Source/operation tracks should each provide at least 32px visible
height, with readable labels or an adjacent selected-operation summary. Range inputs
and Keep/Remove controls may wrap. Reserve approximately 180–220px for timeline and
range editing; on short windows let the center scroll so all controls remain reachable.
The source view plays the managed file from the same playhead. Playback can skip
removed ranges. Speed and transitions are not applied there; they stay in the rendered
preview. A committed playhead is project data. In/out marks are not.
Maintain video aspect ratio, prevent flex clipping, and avoid horizontal page overflow.

Selected tools need a neutral fill/boundary plus their existing text/icon; scene and
operation selection need visible state beyond `aria-pressed`. Keep `Saved`, `Saving…`,
unsaved/recovery and exported-output states truthful and separate. Existing busy,
missing-source, recovery, stale-response and undo guards remain authoritative.

Focus uses a 2px light outline with a 2px gap. Use `focus-inset` on clipped timeline
controls; remove bare `focus:outline-none` unless a visible replacement is provided.
Use `transition-colors` only where useful, never `transition-all`. CSS suppresses
decorative motion under reduced motion; explicit JavaScript smooth scrolling must
also respect that preference. Scrollbars are 8px with visible neutral thumbs.

Phase 1 checks cover CSS compilation and token contrast. Rendered layouts, focus,
fold/reopen state retention and existing interaction regressions require phase 2/3 QA.

---

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
