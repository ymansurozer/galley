---
status: done
created_at: 2026-06-05
completed_at: 2026-06-06
---

## Parent

[00-prd.md](00-prd.md)

## What to build

The **category plan** as a "count + fill" progress list, using the decided treatment (from
`prototypes/guided-review-v5.html`, variant V1). _Placement changed during review:_ it lives
on the **Overview page** (not the top bar — the bar was deliberately slimmed to nav +
progress, and per-file category moved into the diff header).

- Derive categories in `guide.order` (Config / Core / Wiring / Routes / Tests / Docs …). Each
  is a row showing its name + `n/m` (files viewed / total in that category) and a **fill bar**
  that grows with `n/m` and turns **green at `m/m`** (done). Critical categories are amber.
- A multi-file category is one row that fills as those files are viewed — e.g. a 5-file Wiring
  reads `Wiring 2/5`; the exact file is shown in the tree + diff header.
- **Click a category** → jump to its first not-yet-viewed file (or its first file if all
  viewed), entering the guided flow.

Counts/fills derive from `reviewedFiles` (same source as Slice 3 progress).

## Acceptance criteria

- [x] The Overview renders one row per category in `guide.order`, each with `n/m` + a fill bar;
      a category at `m/m` shows as done (green), critical categories amber.
- [x] A multi-file category (e.g. Core 1/2) shows `n/m` and fills as its files are viewed.
- [x] Clicking a category jumps to its first unviewed file (or first file if all viewed).
- [x] No guide → no plan; desk unchanged.
- [x] `pnpm check` + build clean (26/26 tests).

## Blocked by

- [03-guided-navigation-and-progress.md](03-guided-navigation-and-progress.md)
