import { clearHidden, hideRow, type DiffColumn } from "./skim-dom";

// The row walk behind a hunk fold, store-free so a DOM-only test can build @pierre's column shape.
// fold.ts decides which hunks fold and builds the expander; this hides their rows in every track
// and stands an expander in for each run of them.

// Marks a row a fold hid, and an expander a fold inserted, so the next pass can undo both.
export const FOLD_HIDDEN = "data-fold-hidden";
export const FOLD_EXPANDER = "data-fold-expander";

// One expander's worth of folded rows, as every track of every column reports it.
export interface FoldRun {
  // The folded hunks whose rows it hides, in order: what clicking the expander unfolds.
  hunks: number[];
  // The unmodified lines it hides — its line rows plus each separator it took — for the label.
  lines: number;
  // Nothing renders above / below it: the expander takes @pierre's first / last separator look.
  first: boolean;
  last: boolean;
}

// The line count an @pierre unchanged-lines separator shows ("8 unmodified lines"), or null for a
// row that isn't one (a "simple" or "metadata" separator has no count and stays put).
function separatorLines(row: Element): number | null {
  const label = row.hasAttribute("data-separator")
    ? row.querySelector("[data-unmodified-lines]")
    : null;
  return label ? Number.parseInt(label.textContent ?? "", 10) || 0 : null;
}

// In every column's gutter AND content track, hide the rows of the folded hunks (`hunkOf` names a
// line row's folded hunk from its data-line-index, undefined for a row that stays) and insert one
// `expander` before each run of them. A row riding on a line — its annotation's row, a filler
// buffer, a no-newline marker — goes with that line, and an annotation is two rows (content row,
// gutter spacer) that sit after the same line in their tracks, so both halves always go together
// and every line number below the fold stays beside its code; a thread on a hidden line drops out
// as it does in @pierre's own collapsed regions. An unchanged-lines separator touching a folded row
// joins its run, so the run reads as one stretch of unchanged lines rather than separators stacked
// around an expander. Each track is walked independently, as hideBetween does. Returns how many
// rows it hid.
export function foldHunks(
  columns: DiffColumn[],
  hunkOf: (lineIndex: string) => number | undefined,
  expander: (run: FoldRun) => HTMLElement,
): number {
  let hidden = 0;
  for (const col of columns) {
    for (const track of [col.gutter, col.content]) {
      if (!track) continue;
      const rows = Array.from(track.children) as HTMLElement[];
      let hunk: number | undefined;
      const owner = rows.map((row) => {
        const li = row.getAttribute("data-line-index");
        if (li !== null) hunk = hunkOf(li);
        else if (row.hasAttribute("data-separator")) hunk = undefined;
        return hunk;
      });
      const folded = rows.map(
        (row, i) =>
          owner[i] !== undefined ||
          (separatorLines(row) !== null &&
            (owner[i - 1] !== undefined || owner[i + 1] !== undefined)),
      );
      for (let start = 0; start < rows.length; start++) {
        if (!folded[start]) continue;
        let end = start;
        while (end + 1 < rows.length && folded[end + 1]) end++;
        const run: FoldRun = {
          hunks: [],
          lines: 0,
          first: start === 0,
          last: end === rows.length - 1,
        };
        const taken = rows.slice(start, end + 1);
        taken.forEach((row, k) => {
          const h = owner[start + k];
          if (h !== undefined && !run.hunks.includes(h)) run.hunks.push(h);
          run.lines += row.hasAttribute("data-line-index") ? 1 : (separatorLines(row) ?? 0);
          hideRow(row, FOLD_HIDDEN);
        });
        hidden += taken.length;
        const el = expander(run);
        el.setAttribute(FOLD_EXPANDER, "");
        track.insertBefore(el, taken[0] ?? null);
        start = end;
      }
    }
  }
  return hidden;
}

// Undo a fold pass under `root`: drop its expanders and show its rows again.
export function clearFolds(root: ParentNode) {
  for (const el of root.querySelectorAll(`[${FOLD_EXPANDER}]`)) el.remove();
  clearHidden(root, FOLD_HIDDEN);
}
