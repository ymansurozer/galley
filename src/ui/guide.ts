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

// Show the top guide bar whenever a guide is attached and we're not on the Overview page.
export function showGuideBar(): boolean {
  return hasGuide() && !S.overviewOpen;
}

// Distinct categories in guide order, each with its file count + whether it holds a critical.
function categoryPlan(): Array<{ category: string; count: number; critical: boolean }> {
  const out: Array<{ category: string; count: number; critical: boolean }> = [];
  const at = new Map<string, number>();
  for (const g of S.state.guide!.files) {
    let i = at.get(g.category);
    if (i === undefined) { i = out.length; at.set(g.category, i); out.push({ category: g.category, count: 0, critical: false }); }
    out[i]!.count++;
    if (g.critical) out[i]!.critical = true;
  }
  return out;
}

// Render the Overview page into #diff: overview → optional PR description → category plan →
// Start. Called by render() when S.overviewOpen && hasGuide(). Binds the Start button.
export function renderOverview() {
  const g = S.state.guide!;
  const plan = categoryPlan()
    .map((c) => `<span class="go-seg${c.critical ? " crit" : ""}">${c.critical ? "⚑ " : ""}${esc(c.category)} · ${c.count}</span>`)
    .join("");
  const critical = g.files.filter((f) => f.critical).length;
  $("diff").innerHTML = `<div class="guide-overview"><div class="go-card">
    <h1>Guided review</h1>
    <div class="go-sub">${esc(S.state.mode)} · ${esc(S.state.session)} · ${S.state.files.length} files</div>
    <p class="go-overview">${esc(g.overview)}</p>
    ${g.prDescription ? `<div class="go-pr"><b>PR description</b><p>${esc(g.prDescription)}</p></div>` : ""}
    ${plan ? `<div class="go-plan">${plan}</div>` : ""}
    <div class="go-actions"><button class="btn primary" id="guideStart">Start guided review →</button>${critical ? `<span class="go-meta">⚑ ${critical} critical</span>` : ""}</div>
  </div></div>`;
  const start = $("diff").querySelector("#guideStart") as HTMLButtonElement | null;
  if (start) start.onclick = () => S.startGuided?.();
}
