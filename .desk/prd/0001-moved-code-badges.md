# Moved-code badges in the diff viewer

**Status:** proposed · **Size:** M · **Owner:** unassigned

## Problem

When a coding agent relocates a block of code (deletes it in one place, re-adds it
elsewhere — same file or across files), Galley's diff renders it as an unrelated deletion in
one hunk and an addition in another. The reviewer has to recognize by eye that the two are the
same lines moved, which is exactly the tedium Galley exists to remove. GitHub, VS Code, and
Difftastic all mark moves as moves; we don't.

## Why it isn't a config flag

`@pierre/diffs` (v1.2.4) has **no move-detection capability**, and neither does its underlying
diff engine (`jsdiff` / `diff@8`, a Myers LCS line diff). Verified against the library type
surface:

- `BaseDiffOptions` / `BaseCodeOptions` expose no `detectMoves`/`moved`/`moveDetection` option;
  the only hook into the algorithm is `parseDiffOptions` (forwarded to jsdiff), which has no move
  concept.
- The library's line model is additions / deletions / context / change only — there is no
  "moved" `LineType`.

So there is nothing to switch on. Move highlighting must be a **custom pass layered on top of
the parsed diff**, or a different diff engine. This issue scopes the custom-pass approach.

## Approach (lightweight, content-matching)

A best-effort pass that runs after the diff is parsed and pairs up deleted vs. added runs whose
content matches, then surfaces the pairing in the UI. Deliberately conservative: only flag a
move when confident; a missed move just renders as today (add + delete), which is safe.

1. **Collect runs.** From the parsed changes, gather contiguous deletion runs and addition runs
   (per file and across files in the review).
2. **Match by normalized content.** Hash each run on its trimmed, whitespace-normalized line
   text. A deletion run and an addition run with equal (or near-equal, reusing the Dice
   similarity helper now in `state.ts` `lineSimilarity`) content and a minimum size (e.g. ≥ 3
   lines, to avoid pairing a lone `}`) are a **move pair**. Require uniqueness: if a run's hash
   matches more than one candidate, don't guess — leave it un-flagged.
3. **Surface it.** Mark both ends as `moved`:
   - A "Moved from `path:line`" / "Moved to `path:line`" badge in the row annotation (the app
     already authors annotations via `renderAnnotation` in `src/ui/annotations.ts`).
   - De-emphasize the row tint for a pure move (it's not a real add/delete) so genuine changes
     stand out — a move that was also edited stays tinted.
   - Optional: a click on one end scrolls to its partner.

## Where it plugs in

- Parse + change derivation: `src/ui/render.ts` (`D.parseDiffFromFile`, `ensureChangesFromFileDiff`,
  `replayDecisions`) and `src/ui/changes.ts` (`deriveChanges`, `changeStableKey`).
- The move pass consumes the derived changes for the whole review (all files), so it likely lives
  next to `deriveChanges` or as a post-step over `S.state.changes`.
- Rendering: `renderAnnotation` / `setLineAnnotations` in `src/ui/render.ts` + `annotations.ts`;
  add a `moved` variant to the annotation metadata (`AnnotationMeta` in `src/ui/types.ts`).
- Reuse `lineSimilarity` from `src/state.ts` (extract to a shared util if used on both sides).

## Acceptance criteria

- A block of ≥ 3 lines deleted in one location and re-added verbatim elsewhere renders with a
  "moved" badge on both ends instead of two independent add/delete hunks.
- Works within a file and across two files in the same review.
- A move that was also lightly edited still renders (badge + the residual intra-line diff), not
  a false "identical move."
- Ambiguous matches (same content in >1 place) are NOT auto-paired — they render as today.
- No regression to accept/reject, comment anchoring, or the decision/approval flow.
- A unit test covers: exact move (flagged), edited move (flagged + diff), ambiguous (not
  flagged), too-small run (not flagged).

## Out of scope

- Detecting moves against the pre-review base that aren't part of the diff.
- Reordering the diff so moved blocks sit next to each other.
- Swapping the diff engine (revisit only if the content-matching pass proves too weak).

## Notes

Spun out of the 2025-07-06 review batch (item #3). Related helper: the Dice bigram
`lineSimilarity` added for best-effort comment re-anchoring (`src/state.ts`).
