import type { Side } from "./types";

export type Row = {
  el: HTMLElement;
  side: Side;
  line: number;
  top: number;
  height: number;
  change: boolean;
  // The split-view twin of a context row (see mergeRows): the deletions-side coordinates of the
  // same visual line, kept so a cursor seeded from a left-column click still matches this row.
  alt?: { side: Side; line: number };
};

// Sort measured rows top-to-bottom (additions before deletions when they share a y) and merge the
// split-view twins of a context line — the additions- and deletions-column cells that render at
// the same visual line — into ONE row, keeping the additions side primary and the deletions
// coordinate as `alt` so a cursor seeded from either column still matches. Pure over the measured
// list; the getBoundingClientRect sweep that produces `out` lives in cursor.ts (rows()).
export function mergeRows(out: Row[]): Row[] {
  out.sort((a, b) => a.top - b.top || (a.side === b.side ? 0 : a.side === "additions" ? -1 : 1));
  const seen = new Map<number, Row>();
  const list: Row[] = [];
  for (const r of out) {
    const k = Math.round(r.top);
    const kept = seen.get(k);
    if (kept) {
      kept.alt = { side: r.side, line: r.line };
      continue;
    }
    seen.set(k, r);
    list.push(r);
  }
  return list;
}
