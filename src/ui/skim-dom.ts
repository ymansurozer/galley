// The row-hiding rule behind a skim collapse, store-free so a DOM-only test can build @pierre's
// column shape. skim.ts finds the shadow root and the block's bounding context lines; this walks
// each column's two tracks and hides what lies between them.

// One @pierre diff column: a <code> holding a [data-gutter] and a [data-content] grid track. Split
// renders two (deletions, additions), unified one.
export interface DiffColumn {
  gutter: HTMLElement | null;
  content: HTMLElement | null;
}

// The rendered columns under @pierre's shadow root. Empty while the root exists but @pierre hasn't
// committed the diff into it yet — a cold mount where render() resolved first — so callers read
// "no columns" as not-ready, never as a block they failed to find.
export function diffColumns(root: ParentNode): DiffColumn[] {
  return Array.from(root.querySelectorAll("pre[data-diff] code[data-code]")).map((code) => ({
    gutter: code.querySelector<HTMLElement>("[data-gutter]"),
    content: code.querySelector<HTMLElement>("[data-content]"),
  }));
}

// Marks a row hidden by a collapse, so the next collapse can clear it (a cached @pierre instance
// reuses its row elements across renders).
export const SKIM_HIDDEN = "data-skim-hidden";

const isAnnotationRow = (el: Element) =>
  el.hasAttribute("data-line-annotation") || el.getAttribute("data-gutter-buffer") === "annotation";

// In every column's gutter AND content track, hide the rows strictly between the two bounding
// context lines (matched by their shared data-line-index; null = the hunk's edge): the block's
// change rows on one side and, in split, the paired filler rows on the other. Each track is
// located independently so no gutter/content index alignment is assumed. An annotation (the skim
// strip, or any other inside the band) is two rows to @pierre — a [data-line-annotation] row in the
// content track and a [data-gutter-buffer="annotation"] spacer in the gutter — and both are kept:
// hiding only the spacer leaves the gutter a row short per collapsed block, and every line number
// below it drifts up against its code. The filler buffers ([data-content-buffer],
// [data-gutter-buffer="buffer"]) are hidden with the change rows. Returns how many rows it hid.
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
        if (isAnnotationRow(kid)) continue;
        kid.style.display = "none";
        kid.setAttribute(SKIM_HIDDEN, "1");
        hidden++;
      }
    }
  }
  return hidden;
}

const isShown = (el: Element) => (el as HTMLElement).style.display !== "none";

// The columns whose gutter and content tracks now show a different number of rows — each gutter
// row is the line number of one content row, so any difference is drift between numbers and code.
// Structural, not geometric, so it holds in afterRender before layout. Returns their indexes.
export function misalignedColumns(columns: DiffColumn[]): number[] {
  const out: number[] = [];
  columns.forEach((col, i) => {
    if (!col.gutter || !col.content) return;
    const gutterRows = Array.from(col.gutter.children).filter(isShown).length;
    const contentRows = Array.from(col.content.children).filter(isShown).length;
    if (gutterRows !== contentRows) out.push(i);
  });
  return out;
}
