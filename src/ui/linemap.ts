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
  // The raw line a rendered row shows, with the side whose file holds it. A resolved block renders
  // one version of its code in both gutters — the new lines for an accept, the old for a reject —
  // so a row of it anchors to that version from either gutter. Any other row is fromDisplay's.
  anchorAt(side: Side, line: number): { side: Side; line: number };
};

type Break = { after: number; delta: number }; // raw lines > `after` shift by `delta`
// A resolved block's rows on the side that now shows the other side's version: they render after
// raw line `after` of `side`, and show `rows` lines of `shows` from raw line `first`.
type Kept = { after: number; rows: number; shows: Side; first: number };

export type DecidedPosition = {
  hunkIndex: number;
  changeIndex: number;
  status: "accepted" | "rejected";
};

const IDENTITY: LineMap = {
  toDisplay: (_s, l) => l,
  fromDisplay: (_s, l) => l,
  anchorAt: (side, line) => ({ side, line }),
};

export function identityLineMap(): LineMap {
  return IDENTITY;
}

// Build the map from the RAW diff plus the set of decided change blocks. Raw
// positions (hunkIndex, contentIndex) are invariant under resolveRegion, so the
// breakpoints can be read straight off the unresolved diff in document order.
export function buildLineMap(rawDiff: FileDiffMetadata, decided: DecidedPosition[]): LineMap {
  const breaks: Record<Side, Break[]> = { additions: [], deletions: [] };
  const kept: Record<Side, Kept[]> = { additions: [], deletions: [] };
  for (const d of decided) {
    const part = rawDiff.hunks[d.hunkIndex]?.hunkContent?.[d.changeIndex];
    if (part?.type !== "change") continue;
    const dels = part.deletions || 0;
    const adds = part.additions || 0;
    if (d.status === "accepted") {
      // Accept keeps the additions; the deletion side now shows them as context.
      if (adds !== dels)
        breaks.deletions.push({ after: part.deletionLineIndex + dels, delta: adds - dels });
      kept.deletions.push({
        after: part.deletionLineIndex,
        rows: adds,
        shows: "additions",
        first: part.additionLineIndex + 1,
      });
    } else {
      // Reject keeps the deletions; the addition side now shows them as context.
      if (adds !== dels)
        breaks.additions.push({ after: part.additionLineIndex + adds, delta: dels - adds });
      kept.additions.push({
        after: part.additionLineIndex,
        rows: dels,
        shows: "deletions",
        first: part.deletionLineIndex + 1,
      });
    }
  }
  if (!kept.additions.length && !kept.deletions.length) return IDENTITY;
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
  const anchorAt = (side: Side, line: number) => {
    for (const k of kept[side]) {
      // Its rows start right after the raw line before it, which only earlier blocks shift.
      const start = toDisplay(side, k.after) + 1;
      if (line >= start && line < start + k.rows)
        return { side: k.shows, line: k.first + line - start };
    }
    return { side, line: fromDisplay(side, line) };
  };
  return { toDisplay, fromDisplay, anchorAt };
}

// The raw anchor of a selection of rendered rows on `side`, `end` its last row for a range. Each
// end anchors to the line its row shows (anchorAt). A range whose ends land on different sides —
// across a resolved block's rows and real rows — keeps the selection's side and maps each end
// with fromDisplay, so its real rows anchor as they always have.
export function anchorSelection(
  map: LineMap,
  side: Side,
  line: number,
  end?: number,
): { side: Side; line: number; endLine?: number } {
  const first = map.anchorAt(side, line);
  if (end === undefined) return first;
  const last = map.anchorAt(side, end);
  if (last.side === first.side) return { ...first, endLine: last.line };
  return { side, line: map.fromDisplay(side, line), endLine: map.fromDisplay(side, end) };
}
