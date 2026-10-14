import type { FileDiffMetadata } from "@pierre/diffs";
import type { Side } from "./types";

// Pure grouping of a file's threads into the rests the diff mounts (store-free, so it unit-tests):
// threads that sit close together gather under the last of their lines, as one Pierre annotation.

// Lines of the rendered diff on each side: the first one there, and how many. With none on a side
// (a pure deletion's additions side), `from` is the line the span sits before.
export type Span = Record<Side, { from: number; count: number }>;
export type ChangeBlock = { id: string } & Span;

// The rendered (decision-replayed) diff's shape: its change blocks, keyed by hunk and part, and
// its hunks. A decided change has folded into plain lines there, so it's no block. Lines between
// hunks are folded until the reviewer unfolds them.
export type DiffLayout = { changes: ChangeBlock[]; hunks: Span[] };

export function diffLayout(rendered: Pick<FileDiffMetadata, "hunks">): DiffLayout {
  const changes: ChangeBlock[] = [];
  const hunks = rendered.hunks.map((h, hi) => {
    const ends = { additions: 0, deletions: 0 };
    h.hunkContent.forEach((p, pi) => {
      const added = p.type === "change" ? p.additions : p.lines;
      const deleted = p.type === "change" ? p.deletions : p.lines;
      ends.additions = p.additionLineIndex + added;
      ends.deletions = p.deletionLineIndex + deleted;
      if (p.type === "change")
        changes.push({
          id: `${hi}:${pi}`,
          additions: { from: p.additionLineIndex + 1, count: p.additions },
          deletions: { from: p.deletionLineIndex + 1, count: p.deletions },
        });
    });
    const first = h.hunkContent[0];
    const from = {
      additions: (first?.additionLineIndex ?? 0) + 1,
      deletions: (first?.deletionLineIndex ?? 0) + 1,
    };
    return {
      additions: { from: from.additions, count: ends.additions - from.additions + 1 },
      deletions: { from: from.deletions, count: ends.deletions - from.deletions + 1 },
    };
  });
  return { changes, hunks };
}

export type ThreadGroup<T> = {
  side: Side;
  // The display line the group mounts under: its last thread's.
  line: number;
  threads: (T & { display: number })[];
};

const holds = (s: Span, side: Side, line: number) =>
  s[side].count > 0 && line >= s[side].from && line < s[side].from + s[side].count;

// Where a display line sits: inside a change block; in a hunk, in the unchanged run between two
// blocks there (counted by the blocks that start at or before the line, so any block, a pure
// deletion too, splits the run around it); or in the folded stretch between two hunks.
function region({ changes, hunks }: DiffLayout, side: Side, line: number): string {
  const change = changes.find((b) => holds(b, side, line));
  if (change) return `change:${change.id}`;
  const hunk = hunks.findIndex((h) => holds(h, side, line));
  if (hunk < 0) return `fold:${hunks.filter((h) => h[side].from <= line).length}`;
  return `run:${hunk}:${changes.filter((b) => b[side].from <= line).length}`;
}

// The groups, top to bottom. A thread anchors at its first line (a range thread too, where it
// mounts), converted to where it renders (`toDisplay`: decisions renumber lines). Threads gather
// on the same side, in the same change block, unchanged run or folded stretch, each within 2
// lines of the one before it, so a group never mounts on a folded line its other threads are
// shown above.
export function threadGroups<T extends { side: Side; line: number }>(
  threads: readonly T[],
  toDisplay: (side: Side, line: number) => number,
  layout: DiffLayout,
): ThreadGroup<T>[] {
  const placed = threads
    .map((t) => ({ ...t, display: toDisplay(t.side, t.line) }))
    .sort(
      (a, b) => a.display - b.display || (a.side === b.side ? 0 : a.side === "deletions" ? -1 : 1),
    );
  const groups: ThreadGroup<T>[] = [];
  // Each side's latest group, and the region it sits in.
  const last = new Map<Side, { group: ThreadGroup<T>; at: string }>();
  for (const t of placed) {
    const at = region(layout, t.side, t.display);
    const prev = last.get(t.side);
    const tail = prev?.group.threads.at(-1);
    if (prev && tail && prev.at === at && t.display - tail.display <= 2) {
      prev.group.threads.push(t);
      prev.group.line = t.display;
    } else {
      const group = { side: t.side, line: t.display, threads: [t] };
      groups.push(group);
      last.set(t.side, { group, at });
    }
  }
  return groups;
}
