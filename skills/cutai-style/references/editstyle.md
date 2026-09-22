# Portable editing style

Retain the existing CutAI v1 header and section names for compatibility. Numeric
fields are optional. The legacy parser substitutes defaults for missing fields;
the new style bridge preserves omissions. Never pass an incomplete profile through
the legacy parser and present its defaults as observations.

```markdown
# Interview — concise, conversational

> Source: user brief; no reference measurement
> Author: user + AI assistant
> CutAI EDITSTYLE v1

## Rhythm
- Preserve complete answers; trim repetition after the first clear explanation.
- Keep pauses that convey hesitation or emotion.

## Transitions
- Use direct cuts within an answer. Mark topic changes only when needed.

## Visual
- Preserve natural skin tones; grading depends on the source footage.

## Audio
- Keep speech intelligible. Music is optional and must not cover words.

## Subtitles
- Caption complete phrases; emphasize only the key phrase of an answer.
- Keep captions clear of faces and the target platform's controls.

## Patterns
- Open with a clear question or a self-contained answer.
- Retain the context needed to understand the final point.

## Rules
- Do not change the speaker's meaning through reordered cuts.

## Evidence
- User-specified: concise conversational interview.
- Unknown: reference cut timing, caption typography, music and color treatment.
```

When measured, use existing field names such as `**Average cut length**: 4s`,
`**Pacing curve**: dynamic`, `**Transition duration**: 0.2s`, and subtitle
`**Position**: bottom`. Include timestamped evidence and describe the measurement
method. Do not infer exact transition ratios, font sizes or grading settings from
the video's overall impression.

An editing brief should associate each relevant style rule with source evidence,
the proposed action and any unsupported editor capability. It is a proposal until
the connected editor has executed it and the result has been checked.
