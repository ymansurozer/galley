import type { FileDiffMetadata } from "@pierre/diffs";
import { changeStableKey } from "./decisions-derive";
import type { DecidedPosition } from "./linemap";
import type { ChangeState, Side } from "./types";

// ── Which blocks the rendered diff resolves ──────────────────────────────────
// The rendered diff is the raw diff with some change blocks resolved onto it: an accepted block
// becomes context showing its new code, a rejected one context showing its old code. Pure (no
// store), so what a view resolves is unit-testable; changes.ts applies it and builds the line map.

export function findChangePosition(diff: FileDiffMetadata, stableKey: string) {
  for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
    const h = diff.hunks[hunkIndex];
    for (let changeIndex = 0; changeIndex < (h.hunkContent || []).length; changeIndex++) {
      const part = h.hunkContent[changeIndex];
      if (part?.type === "change" && changeStableKey(part) === stableKey)
        return { hunkIndex, changeIndex };
    }
  }
  return null;
}

// Resolutions renumber lines but preserve hunk count and per-hunk content-entry count
// 1:1 (a resolved change becomes a context entry at the same index), so the recorded
// (hunkIndex, changeIndex) addresses the block in raw AND replayed diffs alike. The
// stableKey lookup (which embeds a line number) only remains as a fallback for legacy
// persisted changes that predate changeIndex — and is only sound against the raw diff.
export function changePosition(diff: FileDiffMetadata, change: ChangeState) {
  const pos =
    change.changeIndex !== undefined
      ? { hunkIndex: change.hunkIndex, changeIndex: change.changeIndex }
      : change.stableKey
        ? findChangePosition(diff, change.stableKey)
        : null;
  if (!pos) return null;
  const part = diff.hunks[pos.hunkIndex]?.hunkContent?.[pos.changeIndex];
  return part?.type === "change" ? pos : null;
}

// The blocks a view resolves, as positions in the RAW diff in document order — the one list both
// the replay and the line map read, so anchors land on the rows @pierre renders. A decided block
// resolves as its decision in every view. A pending block the step doesn't cover (`inStep`, see
// steps.ts) resolves as accepted, for display only: it renders as its new code, while its status
// stays pending — never recorded, saved or staged. A pending block in the step stays a diff.
export function replayPositions(
  diff: FileDiffMetadata,
  changes: ChangeState[],
  inStep: (c: ChangeState) => boolean,
): DecidedPosition[] {
  const resolved: DecidedPosition[] = [];
  // Resolve every position against the RAW diff up front (the fallback lookup would
  // mis-match against a partially resolved one); the caller applies them by invariant indexes.
  for (const change of changes) {
    if (change.status === "pending" && inStep(change)) continue;
    const pos = changePosition(diff, change);
    if (pos)
      resolved.push({ ...pos, status: change.status === "rejected" ? "rejected" : "accepted" });
  }
  return resolved.sort((a, b) => a.hunkIndex - b.hunkIndex || a.changeIndex - b.changeIndex);
}

// The block whose raw lines on `side` include `line`, read off the RAW diff — a ChangeState
// carries only its own side's lines, and a comment can sit on the old side of a replaced block.
export function blockAt(
  diff: FileDiffMetadata,
  changes: ChangeState[],
  side: Side,
  line: number,
): ChangeState | undefined {
  return changes.find((c) => {
    const pos = changePosition(diff, c);
    const part = pos && diff.hunks[pos.hunkIndex]?.hunkContent?.[pos.changeIndex];
    if (part?.type !== "change") return false;
    const [start, count] =
      side === "additions"
        ? [part.additionLineIndex, part.additions]
        : [part.deletionLineIndex, part.deletions];
    return line > start && line <= start + count;
  });
}
