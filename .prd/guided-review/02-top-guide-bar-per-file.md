---
status: done
created_at: 2026-06-05
completed_at: 2026-06-05
---

## Parent

[00-prd.md](00-prd.md)

## What to build

The **top guide bar** above the diff that frames the file you're currently on. For the current
file, look up its entry in `state.guide.files` (by path) and render, on a bar directly above
`#diff`: the **change-category chip** (e.g. Config/Core/Wiring/Routes/Tests/Docs), the file
name, and the AI **per-file summary** (ellipsis if long). For a `critical` file, also show a
**"why flagged"** note. The bar updates whenever the current file changes (tree selection or,
later, Next/Prev). Remove the now-unused empty right pane (and its resizer), since guidance no
longer lives there.

Graceful absence: no guide, or a current file with no matching guide entry → no bar renders
and the diff sits where it does today.

## Acceptance criteria

- [x] With a guide attached, selecting a file shows a bar above the diff with that file's
      category chip, filename, and summary; the bar updates when the selected file changes.
- [x] Critical files (`critical: true`) show the "why flagged" note from `why`; non-critical
      files don't.
- [x] A long summary truncates cleanly (ellipsis) rather than pushing the diff down.
- [x] The empty right pane and its resizer are removed; layout still fills the width correctly
      in repo and PR modes.
- [x] No guide (or current file absent from the guide) → no bar, desk unchanged.
- [x] `pnpm check` + build clean; single `dist/ui.js`.

## Blocked by

- [01-attach-guide-and-overview-page.md](01-attach-guide-and-overview-page.md)
