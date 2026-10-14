import type { FileDiffMetadata } from "@pierre/diffs";
import { changePosition } from "./replay";
import type { ChangeState, Side } from "./types";

// ── Which hunks a part view folds ────────────────────────────────────────────
// A part or Rest view replays every block it doesn't cover as plain code (replay.ts), so a hunk
// holding only other steps' blocks renders as unchanged lines; fold.ts folds those into an
// unchanged-lines expander. Pure (no store), so which hunks fold is unit-testable.

// The hunks of `shown` (the replayed diff) that hold none of the step's blocks (`inStep`, see
// steps.ts) and render no change rows. A hunk with a step block keeps its rows even when that
// block is decided and so renders as context too: the reviewer's own decisions stay on screen.
// Indexes address the raw and replayed diffs alike (replay.ts changePosition).
export function foldedHunks(
  raw: FileDiffMetadata,
  shown: FileDiffMetadata,
  changes: ChangeState[],
  inStep: (c: ChangeState) => boolean,
): number[] {
  const kept = new Set<number>();
  for (const c of changes) {
    const pos = inStep(c) ? changePosition(raw, c) : null;
    if (pos) kept.add(pos.hunkIndex);
  }
  const out: number[] = [];
  shown.hunks.forEach((h, i) => {
    if (!kept.has(i) && !h.hunkContent.some((part) => part.type === "change")) out.push(i);
  });
  return out;
}

// The hunk whose rows on `side` include `line` (in the diff's own numbering), or undefined for a
// line between hunks — in a collapsed region, or not in the diff at all.
export function hunkAt(diff: FileDiffMetadata, side: Side, line: number): number | undefined {
  const i = diff.hunks.findIndex((h) => {
    const [start, count] =
      side === "additions"
        ? [h.additionStart, h.additionCount]
        : [h.deletionStart, h.deletionCount];
    return line >= start && line < start + count;
  });
  return i === -1 ? undefined : i;
}
