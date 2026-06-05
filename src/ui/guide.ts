import { S, $, esc } from "./store";

// Whether the current review carries an agent-attached guide with at least one file.
export function hasGuide(): boolean {
  return !!(S.state && S.state.guide && S.state.guide.files && S.state.guide.files.length);
}

// state.files indices in the guide's order (skip guide entries whose file isn't in the diff).
export function guideOrder(): number[] {
  if (!hasGuide()) return [];
  const byPath = new Map(S.state.files.map((f, i) => [f.path, i] as const));
  return S.state.guide!.files.map((g) => byPath.get(g.path)).filter((i): i is number => i !== undefined);
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

// Overall review progress for the guide-bar indicator: files marked viewed / total files.
export function guideProgress(): { done: number; total: number; pct: number } {
  const total = S.state?.files?.length ?? 0;
  const done = S.state?.reviewedFiles?.length ?? 0;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

export type CategoryStep = { category: string; total: number; viewed: number; pct: number; critical: boolean; active: boolean };

// Per-category macro-progress for the top-bar stepper: distinct categories in guide order,
// each with viewed/total (count + fill) and whether it holds the current file / a critical.
export function categorySteps(): CategoryStep[] {
  if (!hasGuide()) return [];
  const reviewed = new Set(S.state.reviewedFiles ?? []);
  const curCat = !S.overviewOpen ? currentGuideEntry()?.category : undefined;
  const out: CategoryStep[] = [];
  const at = new Map<string, number>();
  for (const g of S.state.guide!.files) {
    let i = at.get(g.category);
    if (i === undefined) { i = out.length; at.set(g.category, i); out.push({ category: g.category, total: 0, viewed: 0, pct: 0, critical: false, active: g.category === curCat }); }
    const step = out[i]!;
    step.total++;
    if (reviewed.has(g.path)) step.viewed++;
    if (g.critical) step.critical = true;
  }
  for (const s of out) s.pct = s.total ? Math.round((s.viewed / s.total) * 100) : 0;
  return out;
}

// Jump target for a category click: its first not-yet-viewed file (guide order), else its first.
export function firstFileOfCategory(category: string): number | null {
  if (!hasGuide()) return null;
  const byPath = new Map(S.state.files.map((f, i) => [f.path, i] as const));
  const reviewed = new Set(S.state.reviewedFiles ?? []);
  const inCat = S.state.guide!.files.filter((g) => g.category === category);
  const target = inCat.find((g) => !reviewed.has(g.path)) ?? inCat[0];
  return target ? byPath.get(target.path) ?? null : null;
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
  return hasGuide() && !!S.state.guide!.baseDiffHash && S.state.guide!.baseDiffHash !== S.state.baseDiffHash;
}

// Render the Overview page into #diff: overview → optional PR description → the category
// plan as a count+fill progress list → Start. Called by render() when overviewOpen &&
// hasGuide(). Binds the Start button + per-category jumps.
export function renderOverview() {
  const g = S.state.guide!;
  const plan = categorySteps()
    .map((c) => `<button class="go-cat${c.critical ? " crit" : ""}${c.viewed === c.total ? " done" : ""}" data-cat="${esc(c.category)}" title="Jump to ${esc(c.category)}">
      <span class="go-cat-top"><span class="go-cat-lab">${c.critical ? "⚑ " : ""}${esc(c.category)}</span><span class="go-cat-cnt">${c.viewed}/${c.total}</span></span>
      <span class="go-cat-bar"><i style="width:${c.pct}%"></i></span>
    </button>`)
    .join("");
  const title = g.title || S.state.target || "Review";
  $("diff").innerHTML = `<div class="guide-overview"><div class="go-card">
    <h1>${esc(title)}</h1>
    <div class="go-sub">${esc(S.state.mode)} · ${esc(S.state.session)} · ${S.state.files.length} files</div>
    ${guideStale() ? `<div class="go-stale">⚠ This guide was generated for an earlier version of the diff. Regenerate it and restart the desk with <code>--guide</code> to refresh.</div>` : ""}
    <p class="go-overview">${esc(g.overview)}</p>
    ${g.prDescription ? `<div class="go-pr"><b>PR description</b><p>${esc(g.prDescription)}</p></div>` : ""}
    ${plan ? `<div class="go-plan">${plan}</div>` : ""}
    <div class="go-actions"><button class="btn primary" id="guideStart">Start Review</button></div>
  </div></div>`;
  const start = $("diff").querySelector("#guideStart") as HTMLButtonElement | null;
  if (start) start.onclick = () => S.startGuided?.();
  $("diff").querySelectorAll<HTMLElement>(".go-cat").forEach((el) => { el.onclick = () => S.jumpToCategory?.(el.dataset.cat!); });
}
