---
status: done
created_at: 2026-06-05
completed_at: 2026-06-05
---

## Parent

[00-prd.md](00-prd.md)

## What to build

The end-to-end pipe for a guided review: the coding agent attaches a guide to a review and the
desk renders it as an **Overview page**. This is the tracer bullet through every layer
(schema → validation → API → CLI → merge → UI), mirroring the existing comment-attach flow.

- **Schema:** `ReviewState` gains an optional `guide` — `{ overview: string, prDescription?:
  string, files: Array<{ path, order, category, summary, critical?, why? }> }`. A
  `validateGuide(input)` deep module returns the validated guide or rejects malformed input
  (missing `overview`/`files`, non-array `files`, entries missing `path`/`summary`, etc.).
- **Attach (start flag):** the guide is attached at desk start via a `--guide <file>` flag
  (`galley [file|pr] --guide guide.json`). The flag **requires** a readable JSON file path;
  the CLI reads + `validateGuide`s it and sets `state.guide` before serving (errors + exits on
  a missing path or invalid guide). No standalone subcommand and no HTTP attach endpoint — to
  refresh a guide, restart the desk with a new `--guide` (regen flow is slice 5).
- **Survives reload:** `mergeReviewState` carries the guide forward (prefer the saved guide,
  fall back to base) so a `reload` doesn't drop it; `loadLatestReview` passes it through.
- **Render (Overview page):** when `state.guide` is present, the desk can show an Overview page
  — the overview text, the optional PR description (PR mode), the **category plan** (the
  distinct categories in `order` with a count each), and a **Start guided review →** action
  that selects the first file in guide order. A ⌂ control returns to it. When `state.guide` is
  absent, nothing new renders and the desk behaves exactly as today.

## Acceptance criteria

- [x] `ReviewState.guide` type added; `validateGuide()` accepts a well-formed guide and rejects
      malformed ones with a clear reason.
- [x] `galley … --guide <file>` attaches a valid guide at start; a missing path or an invalid
      guide errors out (non-zero exit) with a clear message.
- [x] After `POST /api/reload`, an attached guide is still present in `/api/state`.
- [x] With a guide attached, the Overview page renders (overview, PR description when present,
      category plan) and **Start guided review →** selects the first file in guide order.
- [x] With no guide, the desk is unchanged from today (no errors, no new chrome).
- [x] Tests: valid guide attaches and survives the reload merge; invalid guide is rejected;
      absent guide leaves the review fully usable (node:test, alongside the comment/merge tests).

## Blocked by

- None - can start immediately
