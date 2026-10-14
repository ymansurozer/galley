// The row-hiding rule behind a skim collapse, store-free so a DOM-only test can build @pierre's
// column shape. skim.ts finds the shadow root and the block's bounding context lines; this walks
// each column's two tracks and hides what lies between them.

// One @pierre diff column: a <code> holding a [data-gutter] and a [data-content] grid track. Split
// renders two (deletions, additions), unified one.
export interface DiffColumn {
  gutter: HTMLElement | null;
  content: HTMLElement | null;
}

// Marks a row hidden by a collapse, so the next collapse can clear it (a cached @pierre instance
// reuses its row elements across renders).
export const SKIM_HIDDEN = "data-skim-hidden";

// In every column's gutter AND content track, hide the rows strictly between the two bounding
// context lines (matched by their shared data-line-index; null = the hunk's edge): the block's
// change rows on one side and, in split, the paired filler rows on the other. Each track is
// located independently so no gutter/content index alignment is assumed. The annotation rows
// ([data-line-annotation]) are kept — that's where the skim strip lives. Returns how many rows it
// hid.
export function hideBetween(
  columns: DiffColumn[],
  beforeLi: string | null,
  afterLi: string | null,
): number {
  let hidden = 0;
  for (const col of columns) {
    for (const track of [col.gutter, col.content]) {
      if (!track) continue;
      const kids = Array.from(track.children) as HTMLElement[];
      const idxOf = (li: string) => kids.findIndex((k) => k.getAttribute("data-line-index") === li);
      const start = beforeLi ? idxOf(beforeLi) : -1;
      const end = afterLi ? idxOf(afterLi) : kids.length;
      // A bound the diff placed only on the other side isn't in this track — skip rather than
      // risk hiding from the wrong edge.
      if ((beforeLi && start === -1) || (afterLi && end === -1)) continue;
      for (let j = start + 1; j < end; j++) {
        const kid = kids[j]!;
        if (kid.hasAttribute("data-line-annotation")) continue;
        kid.style.display = "none";
        kid.setAttribute(SKIM_HIDDEN, "1");
        hidden++;
      }
    }
  }
  return hidden;
}
