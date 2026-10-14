import { S, D } from "./store";
import {
  currentChanges,
  currentComments,
  currentFile,
  inCurrentStep,
  toDisplayLine,
} from "./changes";
import { render } from "./render";
import { diffShadowRoot } from "./diff-dom";
import { diffColumns, misalignedColumns } from "./skim-dom";
import { clearFolds, foldHunks, foldLabel, type FoldRun } from "./fold-dom";
import { foldedHunks, openedFor, shownFolds, type Opened } from "./fold-derive";
import { isUnanchored } from "./unanchored";

// ── Folding other parts' hunks ───────────────────────────────────────────────
// A part or Rest view renders the blocks it doesn't cover as plain code (replay.ts), so a hunk
// holding only other steps' changes reads as unchanged lines. It folds into an expander that looks
// exactly like @pierre's own unchanged-lines separators; clicking it shows the hunk as plain
// context. Display only: no decision, sign-off or saved state reads a fold. Never in the
// whole-file view, a preview, or with unchanged lines expanded (no separators to match there).
//
// Like the skim collapse, it hides @pierre's rendered rows by hand (fold-dom.ts): @pierre folds
// only the unchanged lines between hunks, and the replayed diff must keep every hunk in place,
// since block positions address hunks by index in raw and replayed diffs alike. The pass runs
// synchronously from onPostRender (cold mount, @pierre's own re-renders) and afterRender (the
// cached-instance path), before paint, clearing its own previous pass first. It never touches a
// skim collapse's rows: those belong to the step's own blocks, and a hunk holding one never folds.

// The fallback switch. The fold reaches into @pierre's shadow DOM, the most fragile pass in the
// desk; set this to false and other parts' hunks show as plain context instead — the replay has
// already resolved them, so nothing else changes.
const FOLD_OTHER_PARTS = true;

// The folds the reviewer opened in the view on screen (shown-diff hunk indexes). They survive
// re-renders and layout switches, and start over in another view (openedFor): a reload that moved
// the diff, a guide swap, another step — and on every step selection, so re-opening a part starts
// folded.
let opened: Opened = { view: "", hunks: new Set() };

export function resetFolds() {
  opened = { view: "", hunks: new Set() };
}

function unfold(hunks: number[]) {
  for (const h of hunks) opened.hunks.add(h);
  render();
}

// The expander for one run, in every track: the same markup @pierre builds for an unchanged-lines
// separator (createSeparator), so its own shadow CSS gives it the same row height, type, colours,
// icon and hover. The empty expand index keeps the expandable look while @pierre's click handler
// finds no hunk index in it; the click is ours. The "simple" and "metadata" separator styles have
// no expander to copy, so those take the plainer line-info-basic one.
function expander(run: FoldRun): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute(
    "data-separator",
    S.settings.hunkSeparators === "line-info" ? "line-info" : "line-info-basic",
  );
  el.setAttribute("data-expand-index", "");
  if (run.first) el.setAttribute("data-separator-first", "");
  if (run.last) el.setAttribute("data-separator-last", "");
  const dir = !run.first && !run.last ? "both" : run.first ? "down" : "up";
  const icon = dir === "both" ? "diffs-icon-expand-all" : "diffs-icon-expand";
  el.innerHTML = `<div data-separator-wrapper><div role="button" data-expand-button data-expand-${dir}><svg width="16" height="16" viewBox="0 0 16 16" data-icon><use href="#${icon}"></use></svg></div><div data-separator-content><span data-unmodified-lines>${foldLabel(run)}</span></div></div>`;
  el.addEventListener("click", (e) => {
    const hit = e.target instanceof Element ? e.target : null;
    if (!hit?.closest("[data-expand-button],[data-separator-content]")) return;
    e.stopPropagation();
    unfold(run.hunks);
  });
  return el;
}

export function applyHunkFolds() {
  const shadow = diffShadowRoot();
  // Not ready on a cold mount's first pass; onPostRender re-invokes us (see applySkimCollapse).
  const columns = shadow ? diffColumns(shadow) : [];
  if (!shadow || !columns.length) return;
  clearFolds(shadow);
  const raw = D.rawFileDiff;
  const shown = D.fileDiff;
  const partView = !S.preview && S.stepPart !== undefined;
  if (!FOLD_OTHER_PARTS || !partView || S.settings.unchangedLines === "expand" || !raw || !shown)
    return;
  const file = currentFile();
  opened = openedFor(
    opened,
    JSON.stringify([S.state.baseDiffHash, S.state.guide ?? null, file.path, S.stepPart]),
  );
  const threads = currentComments()
    .filter((c) => c.status === "open" && !isUnanchored(c, file))
    .map((c) => ({ side: c.side, line: toDisplayLine(c.side, c.lineNumber) }));
  const folds = shownFolds(
    shown,
    foldedHunks(raw, shown, currentChanges(), inCurrentStep),
    opened.hunks,
    threads,
  );
  if (!folds.length) return;
  // Rows carry data-line-index "unified,split"; each layout numbers them by its own half.
  const split = shadow.querySelector("pre[data-diff]")?.getAttribute("data-diff-type") === "split";
  const ranges = folds.flatMap((h) => {
    const hunk = shown.hunks[h];
    if (!hunk) return [];
    return split
      ? [{ h, start: hunk.splitLineStart, count: hunk.splitLineCount }]
      : [{ h, start: hunk.unifiedLineStart, count: hunk.unifiedLineCount }];
  });
  const hunkOf = (li: string) => {
    const n = Number(li.split(",")[split ? 1 : 0]);
    return ranges.find((r) => n >= r.start && n < r.start + r.count)?.h;
  };
  // Hunks to fold but no rows hidden = @pierre's DOM drifted from the shape fold-dom expects.
  if (!foldHunks(columns, hunkOf, expander))
    console.debug(`[fold] hid nothing for ${folds.length} hunk(s)`);
  const drifted = misalignedColumns(columns);
  if (drifted.length)
    console.debug(`[fold] left gutter and content misaligned in column(s) ${drifted}`);
}
