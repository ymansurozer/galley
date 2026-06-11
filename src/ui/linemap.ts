import type { FileDiffMetadata } from "@pierre/diffs";
import type { Side } from "./types";

// ── Raw ↔ display line mapping ───────────────────────────────────────────────
// Galley keeps every persisted anchor (decisions, comments, ChangeState) in RAW
// coordinates: line numbers in the actual old/new file, as the unresolved diff
// numbers them. But the rendered diff is the *replayed* one, and @pierre's
// resolveRegion renumbers it on every resolution: an accepted block's additions
// are spliced into the deletion side as context (shifting every later
// deletion-side line by additions − deletions), and a rejected block shifts the
// addition side symmetrically. This map converts between the two spaces so
// annotations land on rendered rows and selections persist as real file lines.

export type LineMap = {
  toDisplay(side: Side, line: number): number;
  fromDisplay(side: Side, line: number): number;
};

type Break = { after: number; delta: number }; // raw lines > `after` shift by `delta`

export type DecidedPosition = {
  hunkIndex: number;
  changeIndex: number;
  status: "accepted" | "rejected";
};

const IDENTITY: LineMap = { toDisplay: (_s, l) => l, fromDisplay: (_s, l) => l };

export function identityLineMap(): LineMap {
  return IDENTITY;
}

// Build the map from the RAW diff plus the set of decided change blocks. Raw
// positions (hunkIndex, contentIndex) are invariant under resolveRegion, so the
// breakpoints can be read straight off the unresolved diff in document order.
export function buildLineMap(rawDiff: FileDiffMetadata, decided: DecidedPosition[]): LineMap {
  const breaks: Record<Side, Break[]> = { additions: [], deletions: [] };
  for (const d of decided) {
    const part = rawDiff.hunks[d.hunkIndex]?.hunkContent?.[d.changeIndex];
    if (part?.type !== "change") continue;
    const dels = part.deletions || 0;
    const adds = part.additions || 0;
    if (d.status === "accepted") {
      // Accept keeps the additions; the deletion side now shows them as context.
      if (adds !== dels)
        breaks.deletions.push({ after: part.deletionLineIndex + dels, delta: adds - dels });
    } else {
      // Reject keeps the deletions; the addition side now shows them as context.
      if (adds !== dels)
        breaks.additions.push({ after: part.additionLineIndex + adds, delta: dels - adds });
    }
  }
  if (!breaks.additions.length && !breaks.deletions.length) return IDENTITY;
  breaks.additions.sort((a, b) => a.after - b.after);
  breaks.deletions.sort((a, b) => a.after - b.after);
  const toDisplay = (side: Side, line: number) => {
    let off = 0;
    for (const b of breaks[side]) {
      if (b.after >= line) break;
      off += b.delta;
    }
    return line + off;
  };
  const fromDisplay = (side: Side, line: number) => {
    // Invert the step function piecewise. Negative deltas (a resolved block removed
    // lines from this side) make naive piece ranges overlap with phantom values for the
    // removed lines — but rendered numbering is contiguous and monotone, so the LAST
    // piece whose display range contains the line is the one actually rendered there.
    const bs = breaks[side];
    let prefix = bs.reduce((sum, b) => sum + b.delta, 0);
    for (let i = bs.length - 1; i >= 0; i--) {
      if (line > bs[i].after + prefix) return line - prefix;
      prefix -= bs[i].delta;
    }
    return line; // before the first break: identity
  };
  return { toDisplay, fromDisplay };
}
