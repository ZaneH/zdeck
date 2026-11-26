# zDeck Agent Guide

## Purpose

Build zDeck as a self-contained application that can control a user's computer and its applications using dashboard
created by the user.

## Workflow

`dev` is the default: iterate and preview there; short-lived branches target `dev`. Promote `dev` to `production` by PR for releases and the live landing page; no direct production edits. No `main`. Report checks and gaps; never infer native parity from browser tests. See [release workflow](docs/releasing.md).

Commit completed work incrementally: one coherent, independently reviewable/revertible change per commit, with its tests and relevant docs. Do not accumulate unrelated changes; report checks and never push unless asked.

## Feature Map

## Invariants

- Settings errors never prevent launch.
- Remember explicit user configuration across sessions by default (including integration enablement and connection details); save when applied, not only on quit. Keep secrets in the OS credential store, separate from decks, exports, logs and browser storage, and offer a way to forget them. Report persistence failures visibly without blocking launch or silently falling back to plaintext. Restore plugin enablement only for unchanged trusted packages; live execution mode, action requests/results and other transient safety state stay session-only. Add restart/round-trip coverage for new persistent settings.
- Windows, macOS, and Linux must all be supported. Platform-specific features require supported implementations and verification on all three; silently unsupported behavior is not acceptable.

## Design invariant

Interactive elements use context-appropriate cursors: `pointer` for actions, `grab`/`grabbing` for dragging, axis-specific cursors for resizing, `text` for text entry, and `not-allowed` when disabled. Clickable labels match their controls.

Checkbox rows align the box and any inline help icon with the vertical center of the label's first line, including wrapped labels. The box and its clickable label use the same pointer cursor; disabled controls and labels consistently use the disabled cursor. Do not rely on browser-default checkbox margins or cursors.

Routine settings explanations stay out of the main reading flow. Use concise labels and compact, keyboard- and touch-accessible help for optional details; keep actual errors, uncertain outcomes, and necessary safety/setup instructions visible. Tooltips show their actual help on hover or keyboard focus, not only on click. Never layer a native `title` tooltip over a custom tooltip. Keep hover help reachable, dismissible with Escape, and gently animated with reduced-motion support.

## UI signal

Do not flash routine loading, saving, or success text for quick operations. Preserve layout and use the control's disabled/busy state instead. Keep errors visible; reserve progress messages for genuinely long waits, not brief status text users cannot read before it disappears.

Reduce noise while retaining actionable signal. Expected platform limitations should not repeat as warnings after an operation completes: native play/pause can send a media key without observable playback state, so keep the state honestly unknown without a warning or forced refresh after each press. Genuine failures and uncertain delivery still need warnings and retry safeguards. A permission-blocked control gets a focused short prompt and one setup CTA, not an appended troubleshooting wall.

