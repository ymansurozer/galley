import type { FileDiffMetadata } from "@pierre/diffs";
import { S, D } from "./store";
import type { Side } from "./types";
import { currentComments, currentFile, toDisplayLine } from "./changes";
import { isUnanchored } from "./unanchored";

// ── Revealing lines hidden in collapsed unmodified regions ───────────────────
// In "collapse" mode, long unchanged runs fold into "N unmodified lines" separators —
// and an annotation on a folded line simply never renders. A comment thread that ends
// up there after the agent's edits (its block became unchanged) would be invisible,
// and an open change request blocks approval. So after each render we auto-expand a
// small window around any open thread's line.
//
// @pierre's model: the collapsed region before hunk `i` is keyed `i` (the trailing
// region after the last hunk is keyed `hunks.length`); expandHunk(i, "up", n) reveals
// n lines from the region's TOP (just after the previous hunk), "down" from its BOTTOM
// (just before hunk i). Expansion state lives on the renderer instance, so it survives
// re-renders for as long as the instance is cached.

const REVEAL_CONTEXT = 3; // extra lines past the target so the thread has some code around it

type Loc =
  | { kind: "visible" }
  | { kind: "collapsed"; regionIndex: number; distFromTop: number; distFromBottom: number }
  | { kind: "missing" };

// Where a DISPLAY-space line currently sits in the rendered diff.
export function locateDisplayLine(fd: FileDiffMetadata, side: Side, line: number): Loc {
  const start = (h: FileDiffMetadata["hunks"][number]) =>
    side === "additions" ? h.additionStart : h.deletionStart;
  const count = (h: FileDiffMetadata["hunks"][number]) =>
    side === "additions" ? h.additionCount : h.deletionCount;
  for (let i = 0; i < fd.hunks.length; i++) {
    const h = fd.hunks[i];
    if (h.collapsedBefore > 0) {
      const gapStart = start(h) - h.collapsedBefore;
      const gapEnd = start(h) - 1;
      if (line >= gapStart && line <= gapEnd)
        return {
          kind: "collapsed",
          regionIndex: i,
          distFromTop: line - gapStart + 1,
          distFromBottom: gapEnd - line + 1,
        };
    }
    if (line >= start(h) && line <= start(h) + count(h) - 1) return { kind: "visible" };
  }
  const last = fd.hunks[fd.hunks.length - 1];
  if (last) {
    const lastEnd = start(last) + count(last) - 1;
    const total = side === "additions" ? fd.additionLines.length : fd.deletionLines.length;
    if (line > lastEnd && line <= total)
      return {
        kind: "collapsed",
        regionIndex: fd.hunks.length,
        distFromTop: line - lastEnd,
        distFromBottom: total - line + 1,
      };
  }
  return { kind: "missing" };
}

// Expand the collapsed region containing this RAW line (no-op if it already renders).
export function revealLine(side: Side, rawLine: number): void {
  if (S.settings.unchangedLines === "expand") return; // everything renders already
  const fd = D.fileDiff;
  const inst = D.instance;
  if (!fd || !inst) return;
  const loc = locateDisplayLine(fd, side, toDisplayLine(side, rawLine));
  if (loc.kind !== "collapsed") return;
  const fromTop = loc.distFromTop <= loc.distFromBottom;
  inst.expandHunk(
    loc.regionIndex,
    fromTop ? "up" : "down",
    (fromTop ? loc.distFromTop : loc.distFromBottom) + REVEAL_CONTEXT,
  );
}

// Once-per-rendered-diff guard: expandHunk triggers its own rerender, and our render()
// runs again on every decision — without this each pass would re-expand cumulatively.
const revealed = new Map<string, Set<string>>();

export function revealThreadLines(diffKey: string) {
  const file = currentFile();
  if (!file) return;
  let done = revealed.get(diffKey);
  if (!done) {
    done = new Set();
    revealed.set(diffKey, done);
    // Keep the guard map from growing unboundedly across many files/option changes.
    if (revealed.size > 24) revealed.delete(revealed.keys().next().value as string);
  }
  const seen = new Set<string>();
  for (const c of currentComments()) {
    if (c.status !== "open" || isUnanchored(c, file)) continue;
    const key = `${c.side}:${c.lineNumber}`;
    if (seen.has(key) || done.has(key)) continue;
    seen.add(key);
    done.add(key);
    revealLine(c.side, c.lineNumber);
  }
}
