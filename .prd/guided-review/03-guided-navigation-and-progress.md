---
status: done
created_at: 2026-06-05
completed_at: 2026-06-05
---

## Parent

[00-prd.md](00-prd.md)

## What to build

Turn the guide bar into a navigator. Add the far-left action cluster `[⌂ · ← Prev · Next →]`
to the bar and a minimal progress indicator.

- **Logical order:** Next/Prev walk the files in the guide's `order` (general → specific), not
  tree order. Maintain a guide-order list of `state.files` indices; "current position" is the
  index within it. At the ends, Prev from the first file returns to the Overview page; Next is
  disabled on the last file.
- **Tree still jumps:** clicking any file in the full tree selects it (existing `selectFile`),
  and the bar/position update to match — the tree remains free navigation.
- **⌂ Overview:** returns to the Overview page (from Slice 1) at any time; **Start guided
  review →** there enters at the first file.
- **Progress:** a minimal `n / total reviewed` count + a slim bar, driven by the existing
  `reviewedFiles` (the diff header's Viewed toggle already maintains it). Optional J/K keys for
  Next/Prev.

## Acceptance criteria

- [x] Next/Prev move through files in `guide.order`; the diff swaps to one file at a time
      (existing single-file render), and the tree highlight + bar follow.
- [x] Prev on the first file shows the Overview page; Next is disabled on the last file.
- [x] Clicking a file in the tree selects it and syncs the guided position.
- [x] ⌂ returns to the Overview page; Start re-enters at the first file in order.
- [x] Progress shows `n/total reviewed` + a slim bar that advances as files are marked Viewed,
      and reflects already-viewed files on load.
- [x] No guide → no nav actions/progress; tree + diff behave as today.

## Blocked by

- [02-top-guide-bar-per-file.md](02-top-guide-bar-per-file.md)
