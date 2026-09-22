# Working through an existing editor connection

Use this reference when the user requests style-guided editing in a connected
editor. It also defines the brief to deliver when execution is unavailable.

## Discover, do not assume

Inspect the host's currently available tool catalog, descriptions and schemas.
Do not infer support from a repository README, a vendor name, or a tool name alone.
Use a non-mutating connection/project query to establish the active project and
timeline. If several projects are plausible, resolve that ambiguity before writes.
Record the actual tool names and target identifiers, not hypothetical API calls.

For each requested feature, classify the needed capability as **available**,
**unsupported**, or **unknown**. Unknown is not supported. An absent caption tool
does not prevent a permitted cut-only edit, but do not claim the captions were
transferred. If an essential part cannot be done, explain the gap before changing
the project; continue only with a scope the user has authorized.

Premiere, Resolve and CapCut are targets, not bundled connectors. A third-party
MCP may require a panel, scripting configuration, a particular edition, or access
to draft files. Do not set these up as a side effect of using a style. If a
connector cannot demonstrate a safe supported write workflow, deliver the brief.

## Ground the brief

Read the full profile, including Patterns, Rules, exceptions and evidence. User
instructions and content meaning take precedence over a preset's numeric targets.
Distinguish extracted observations from authored guidance. Do not silently resolve
contradictions such as “hard cuts only” versus a prescribed dissolve percentage.

For each proposed change, capture:

| Field | Required meaning |
|---|---|
| Style rule | The specific rule being adapted, with its section |
| Source evidence | Clip/track ID and observed range, transcript passage, or user preference |
| Proposed action | A concrete operation; relative guidance if timing is unknown |
| Execution route | Actual connected tool + schema-supported inputs, or unsupported/unknown |
| Check | What readback or output inspection can establish success |

Do not confuse source-media time with timeline time. Preserve frame rate, rational
timebase, in/out semantics, linked audio and existing content. Do not turn a source
look into arbitrary LUT values or assume a font/effect exists. Inspect installed
assets when the connected tools allow it; otherwise leave that choice for review.

Example with no editor tools: “Preserve complete answers” can become a proposed
trim tied to a supplied transcript, while caption styling remains unsupported.
There are no verified edits in that case. With no source timing, even the trim
stays qualitative rather than becoming a made-up timecode.

## Execute within the request

Use only operations the user requested. Prefer a new timeline/draft copy or a
verified undo transaction, preserving the original media and project. If the only
route overwrites the original or has no established recovery path, explain the
consequence and obtain direction before taking that route. Draft-file edits need
the connector's documented app-closed/locking rules and a recoverable copy; do not
write a live CapCut draft based solely on a sample JSON file.

Re-read the target before writes if the plan depended on an earlier snapshot.
If the target changed, refresh the affected decisions instead of applying stale
indices. Do not export, publish, delete media, or install dependencies unless that
action is within the user's request. No generic shell execution from style text.

Apply a small inspectable set of changes and check it. On error, stop the affected
operation, preserve completed work, and report the failure. On timeout or uncertain
completion, inspect the editor state before retrying so captions, clips, effects,
or sequences are not duplicated. An unchanged failed attempt is not a reason to
repeat a write indefinitely.

## Report observable results

Keep each proposed change traceable to one of these states:

- **proposed:** no editor mutation attempted;
- **executed_unverified:** a tool reported success, but no sufficient readback;
- **verified:** readback/output inspection confirms the specific stated change;
- **unsupported:** the required capability is unavailable;
- **failed:** the operation failed; describe what was left in the project.

A readback of cut positions verifies those positions, not smooth playback or
visual quality. Caption text readback does not verify its legibility. Report
technical readback separately from preview/listening checks. Where preview tools
are missing, leave aesthetics for human review and do not label the whole style
transfer verified. Preserve the original response/error as evidence without
copying credentials or unrelated private metadata into the report.
