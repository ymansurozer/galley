import { S, $, esc } from "./store";
import { fileReviewState } from "./changes";
import { renderMarkdown, renderMarkdownInline } from "./markdown";
import { lineStats, walkthroughGroups, walkRows } from "./walkthrough";
import type { WalkGroup, WalkRow, WalkFile } from "./walkthrough";

// Whether the current review carries an agent-attached guide with at least one file.
export function hasGuide(): boolean {
  return !!(S.state && S.state.guide && S.state.guide.files && S.state.guide.files.length);
}

// state.files indices in the guide's order (skip guide entries whose file isn't in the diff).
export function guideOrder(): number[] {
  if (!hasGuide()) return [];
  const byPath = new Map(S.state.files.map((f, i) => [f.path, i] as const));
  return S.state
    .guide!.files.map((g) => byPath.get(g.path))
    .filter((i): i is number => i !== undefined);
}

// Where "Start guided review" lands — the first file in guide order (else the first file).
export function firstGuideIndex(): number {
  const order = guideOrder();
  return order.length ? order[0]! : 0;
}

// The next file to review after `cur`: the next in guide order when a guide is attached
// (and `cur` is in it), else the next file sequentially. null when `cur` is the last.
export function nextFileIndex(cur: number): number | null {
  if (hasGuide()) {
    const order = guideOrder();
    const pos = order.indexOf(cur);
    if (pos >= 0) return pos + 1 < order.length ? order[pos + 1]! : null;
  }
  return cur + 1 < (S.state?.files?.length ?? 0) ? cur + 1 : null;
}

// The previous file before `cur` (guide order, else sequential). null at the first file —
// the caller treats that as "go back to the Overview page".
export function prevFileIndex(cur: number): number | null {
  if (hasGuide()) {
    const order = guideOrder();
    const pos = order.indexOf(cur);
    if (pos >= 0) return pos - 1 >= 0 ? order[pos - 1]! : null;
  }
  return cur - 1 >= 0 ? cur - 1 : null;
}

// Changed lines (additions + deletions) per file path — the weight used for progress, so
// finishing a big file advances the bar more than a tiny one. Min 1 so every file counts.
function locByPath(): Map<string, number> {
  const m = new Map<string, number>();
  for (const [path, s] of lineStats(S.state?.files ?? []))
    m.set(path, Math.max(s.added + s.removed, 1));
  return m;
}

// Guide categories + their files (plus the trailing "Other" group of unlisted diff files) —
// the data behind the Walkthrough sidebar tab and the Overview file list.
export function walkGroups(): WalkGroup[] {
  if (!hasGuide()) return [];
  return walkthroughGroups(S.state.guide!.files, S.state.files ?? [], fileReviewState);
}

// Flat rows for the Walkthrough tab's x-for. Same active-path rule as the tree: nothing is
// active on the Overview; a previewed file wins over the indexed review file.
export function walkthroughRows(): WalkRow[] {
  const activePath = S.overviewOpen
    ? null
    : (S.preview?.path ?? S.state?.files?.[S.fileIndex]?.path ?? null);
  return walkRows(walkGroups(), activePath);
}

// Overall review progress for the guide-bar indicator, weighted by changed lines (LOC) rather
// than file count: "done" sums the LOC of files the reviewer finished (approved OR
// changes-requested), "approved" the clean-signoff LOC.
export function guideProgress(): { done: number; approved: number; total: number; pct: number } {
  const byLines = S.settings.progressBy !== "files";
  const loc = byLines ? locByPath() : null;
  let total = 0,
    done = 0,
    approved = 0;
  for (const f of S.state?.files ?? []) {
    const w = byLines ? (loc!.get(f.path) ?? 1) : 1;
    total += w;
    const st = fileReviewState(f.path);
    if (st !== "pending") done += w;
    if (st === "approved") approved += w;
  }
  return { done, approved, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// The guide entry for the file currently shown (or null) — drives the top guide bar.
export function currentGuideEntry() {
  if (!hasGuide()) return null;
  const f = S.state.files[S.fileIndex];
  if (!f) return null;
  return S.state.guide!.files.find((g) => g.path === f.path) ?? null;
}

export function currentFileName(): string {
  return S.state?.files?.[S.fileIndex]?.path.split("/").pop() ?? "";
}

// Show the top guide bar whenever a guide is attached — including on the Overview page
// (where the overview is treated as the position before the first file).
export function showGuideBar(): boolean {
  return hasGuide();
}

// The guide was generated against an older diff than the one now loaded (e.g. the agent
// edited code and the desk reloaded). Advisory only — the guide still renders.
export function guideStale(): boolean {
  return (
    hasGuide() &&
    !!S.state.guide!.baseDiffHash &&
    S.state.guide!.baseDiffHash !== S.state.baseDiffHash
  );
}

// One file row in the Overview list: path (dimmed dir, bright basename) + flag icon +
// ±counts + a read-only review-state badge on top, the guide's orientation beneath.
// Read-only by design — decisions stay where the diff is visible; clicking opens the file.
function overviewFileRow(f: WalkFile): string {
  const badge =
    f.state === "approved"
      ? `<svg class="ic badge approved" title="Approved"><use href="#gly-check"></use></svg>`
      : f.state === "changes-requested"
        ? `<svg class="ic badge changes" title="Changes requested"><use href="#gly-flag"></use></svg>`
        : `<svg class="ic badge pending" title="Pending review"><use href="#gly-dot"></use></svg>`;
  return `<button class="go-file" data-i="${f.fileIndex}">
    <span class="go-file-top">
      <span class="go-file-path"><span class="fdir">${esc(f.dir)}</span><span class="fname">${esc(f.name)}</span></span>
      ${f.flag ? `<svg class="ic crit" title="${esc(f.flag)}"><use href="#gly-flag"></use></svg>` : ""}
      <span class="go-file-stats">${f.added ? `<i class="add">+${f.added}</i>` : ""}${f.removed ? `<i class="del">−${f.removed}</i>` : ""}${badge}</span>
    </span>
    ${f.orientation ? `<span class="go-file-sum">${renderMarkdownInline(f.orientation)}</span>` : ""}
  </button>`;
}

// Render the Overview page into #diff: overview → optional PR description → the per-file
// list grouped by category → Start. Called by render() when overviewOpen && hasGuide().
// Binds the Start button + per-file jumps.
export function renderOverview() {
  const g = S.state.guide!;
  const fileList = walkGroups()
    .map(
      (grp) => `<div class="go-grp">
      <div class="go-grp-h"><span class="go-grp-name">${esc(grp.category)}</span><span class="go-grp-meta">${grp.total} file${grp.total === 1 ? "" : "s"}${grp.added ? ` · <i class="add">+${grp.added}</i>` : ""}${grp.removed ? ` <i class="del">−${grp.removed}</i>` : ""}</span></div>
      ${grp.files.map(overviewFileRow).join("")}
    </div>`,
    )
    .join("");
  const title = g.title || S.state.target || "Review";
  $("diff").innerHTML = `<div class="guide-overview"><div class="go-card">
    <h1>${esc(title)}</h1>
    <div class="go-sub">${esc(S.state.mode)} · ${esc(S.state.session)} · ${S.state.files.length} files</div>
    ${guideStale() ? `<div class="go-stale"><svg class="ic"><use href="#gly-warn"></use></svg> This guide was generated for an earlier version of the diff. Regenerate it and restart the desk with <code>--guide</code> to refresh.</div>` : ""}
    <div class="go-overview md">${renderMarkdown(g.overview)}</div>
    ${g.prDescription ? `<div class="go-pr"><b>PR description</b><div class="md">${renderMarkdown(g.prDescription)}</div></div>` : ""}
    ${fileList ? `<div class="label go-files-h">Files in this review</div><div class="go-files">${fileList}</div>` : ""}
    <div class="go-actions"><button class="btn primary" id="guideStart">Start Review <kbd>↵</kbd></button></div>
  </div></div>`;
  const start = $("diff").querySelector("#guideStart") as HTMLButtonElement | null;
  if (start) start.onclick = () => S.startGuided?.();
  $("diff")
    .querySelectorAll<HTMLElement>(".go-file")
    .forEach((el) => {
      el.onclick = () => S.selectFile?.(Number(el.dataset.i));
    });
}
