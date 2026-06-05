---
status: open
created_at: 2026-06-05
---

## Parent

[00-prd.md](00-prd.md)

## What to build

The **category stepper** across the top guide bar — the macro-progress view, using the
decided **"count + fill"** treatment (from `prototypes/guided-review-v5.html`, variant V1).

- Derive categories in `guide.order` (Config › Core › Wiring › Routes › Tests › Docs …). Each
  category is a segment showing its name + `n/m` (files viewed / total in that category) and a
  thin **fill bar** that grows with `n/m` and turns **green at `m/m`** (done).
- The **current file's category** segment is highlighted (and tinted if that category contains
  the current critical file). A multi-file category stays one segment that fills as you walk
  its files — e.g. a 5-file Wiring reads `Wiring 2/5`; the exact file is shown in the tree and
  the bar's filename.
- **Click a category** → jump to its first not-yet-viewed file (or its first file if all
  viewed), advancing the guided position.

Counts/fills are derived from `reviewedFiles` (same source as Slice 3 progress), so viewing a
file updates both its category fill and the overall progress.

## Acceptance criteria

- [ ] The stepper renders one segment per category in `guide.order`, each with `n/m` + a fill
      bar; a category at `m/m` shows as done (green).
- [ ] The current file's category is highlighted; marking a file Viewed advances its category
      fill and the overall progress together.
- [ ] A multi-file category (e.g. 5 files) shows `n/5` and is walked file-by-file by Next; the
      tree/bar show which file.
- [ ] Clicking a category jumps to its first unviewed file (or first file if all viewed).
- [ ] No guide → no stepper; desk unchanged.
- [ ] `pnpm check` + build clean.

## Blocked by

- [03-guided-navigation-and-progress.md](03-guided-navigation-and-progress.md)
