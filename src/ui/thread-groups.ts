import type { Side } from "./types";

// Pure grouping of a file's threads into the rests the diff mounts (store-free, so it unit-tests):
// threads that sit close together gather under the last of their lines, as one Pierre annotation.

// A change block of the rendered diff, on each side: its first line there, and how many lines it
// has. With none on a side (a pure deletion's additions side), `from` is the line it sits before.
export type ChangeBlock = { id: string } & Record<Side, { from: number; count: number }>;

export type ThreadGroup<T> = {
  side: Side;
  // The display line the group mounts under: its last thread's.
  line: number;
  threads: (T & { display: number; open: boolean })[];
};

// Where a display line sits: inside a change block, or in the unchanged run between two. A run
// is counted by the blocks that start at or before the line, so any block, a pure deletion too,
// splits the run around it.
function region(blocks: readonly ChangeBlock[], side: Side, line: number): string {
  let before = 0;
  for (const b of blocks) {
    const { from, count } = b[side];
    if (count && line >= from && line < from + count) return `change:${b.id}`;
    if (from <= line) before++;
  }
  return `run:${before}`;
}

// The groups, top to bottom. A thread anchors at its first line (a range thread too, where it
// mounts), converted to where it renders (`toDisplay`: decisions renumber lines). Threads gather
// on the same side, in the same change block or unchanged run, each within 2 lines of the one
// before it. `openKey` marks the one thread open as a card.
export function threadGroups<T extends { key: string; side: Side; line: number }>(
  threads: readonly T[],
  toDisplay: (side: Side, line: number) => number,
  blocks: readonly ChangeBlock[],
  openKey: string | null,
): ThreadGroup<T>[] {
  const placed = threads
    .map((t) => ({ ...t, display: toDisplay(t.side, t.line), open: t.key === openKey }))
    .sort(
      (a, b) => a.display - b.display || (a.side === b.side ? 0 : a.side === "deletions" ? -1 : 1),
    );
  const groups: ThreadGroup<T>[] = [];
  // Each side's latest group, and the region it sits in.
  const last = new Map<Side, { group: ThreadGroup<T>; at: string }>();
  for (const t of placed) {
    const at = region(blocks, t.side, t.display);
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
