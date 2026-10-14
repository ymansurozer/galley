import { S, $, esc } from "./store";
import { flowIndex } from "./changes";
import type { FlowIndex } from "./flow-index";
import { isGuideBaseStale } from "./guide-derive";
import { navFileOrder, nextUnreviewed, wrapNextTarget, wrapPrevTarget } from "./seek";
import { isSkimGroupExpanded } from "./skim";
import {
  adjacentStep,
  anchorStep,
  carryStep,
  neighborStep,
  planSteps,
  slotOutOfFlow,
  stepEntry,
  stepKey,
  stepPlan,
  type Step,
} from "./steps";
import { treeOrder } from "./tree";
import { renderMarkdown } from "./markdown";
import { lineStats, walkthroughGroups, walkRows } from "./walkthrough";
import type { WalkGroup, WalkRow } from "./walkthrough";
import type { GuideFile } from "./types";

// Whether the current review carries an agent-attached guide with at least one file.
export function hasGuide(): boolean {
  return !!(S.state && S.state.guide && S.state.guide.files && S.state.guide.files.length);
}

// The step on screen: the current file, and which part of it (none = the whole file).
export function currentStep(): Step {
  return S.stepPart === undefined
    ? { fileIndex: S.fileIndex }
    : { fileIndex: S.fileIndex, part: S.stepPart };
}

// The guided review's steps in walkthrough order (see stepPlan). Callers check hasGuide().
function guidePlan(ix: FlowIndex) {
  return stepPlan(S.state.guide!.files, S.state.files, (p) => ix.changesByPath.get(p) ?? []);
}

// What navigation needs from one flow-index pass (per-candidate rescans froze big desks — see
// flow-index.ts): the guided plan (null without a guide), whether a step left the flow (a fully
// skimmed file or part, a pure rename), and whether it's finished.
function navWith(ix: FlowIndex) {
  const plan = hasGuide() ? guidePlan(ix) : null;
  const slots = plan ? [...plan.listed, ...plan.other] : [];
  const slotOf = new Map(slots.map((s) => [stepKey(s.step), s] as const));
  const fileOut = (p: string) => ix.outOfFlow.has(p);
  const pathOf = (s: Step) => S.state?.files?.[s.fileIndex]?.path;
  const outOfFlow = (s: Step) => {
    const slot = slotOf.get(stepKey(s));
    if (slot) return slotOutOfFlow(slot, fileOut);
    const p = pathOf(s);
    return !!p && fileOut(p);
  };
  // "Finished" for the seek: the step's file is signed off in the current state, matching the
  // tree badges and floating approve button (an agent edit after sign-off invalidates the hash,
  // so the file counts as unreviewed again). File-derived for now, so every step of a signed-off
  // file is finished.
  const finished = (s: Step) => {
    const p = pathOf(s);
    return !!p && ix.finished(p);
  };
  return { ix, plan, slots, outOfFlow, finished };
}
type Nav = ReturnType<typeof navWith>;

// The order the wrap/approve-advance seeks walk. Without a guide it's the Files tree's
// top-to-bottom order; with one it's the walkthrough's: the guide's steps followed by the Other
// group (each changed file the guide DIDN'T list, and each split file's Rest), in file-array
// order — so the seek reaches unlisted files and never dead-ends on a partial guide. Steps out of
// the flow are excluded (issue 07) unless `keep` says otherwise: this is the single choke point
// that keeps the wrap/approve-advance seeks off them. Plain mid-list stepping (nextStep) walks the
// same order but in its own band.
function navStepsWith(nav: Nav, keep = (s: Step) => !nav.outOfFlow(s)): Step[] {
  if (nav.plan) return planSteps(nav.plan, (s) => keep(s.step));
  const n = S.state?.files?.length ?? 0;
  return navFileOrder(n, treeOrder(nav.ix), (i) => keep({ fileIndex: i })).map((fileIndex) => ({
    fileIndex,
  }));
}
export function navSteps(): Step[] {
  return navStepsWith(navWith(flowIndex()));
}

// navSteps with the out-of-flow steps kept: the order the change-request walk (requests.ts)
// crosses files in. A skimmed file left the flow, but an open request on it still waits to be
// checked.
export function reviewSteps(): Step[] {
  return navStepsWith(navWith(flowIndex()), () => true);
}

// Where "Start guided review" lands — the first in-flow step in nav order (fully-skimmed steps
// are excluded from navSteps), else, when every step is skimmed, the first guide step so Start
// still opens something.
export function firstGuideStep(): Step {
  const nav = navWith(flowIndex());
  return navStepsWith(nav)[0] ?? nav.plan?.listed[0]?.step ?? { fileIndex: 0 };
}

// Plain next/prev stepping skips steps that left the flow — UNLESS the reviewer is currently on
// one (opened from the Skimmed group), in which case stepping walks the skimmed band so the
// group's siblings stay reachable. Off either band's end returns null and the caller wraps
// (guideNext/guidePrev), where the wrap seeks (navSteps) only ever target the in-flow band.
// The order: without a guide the Files tree's top-to-bottom order, so "next" is the row below;
// with one, the walkthrough's (see neighborStep).
function stepFrom(cur: Step, dir: 1 | -1): Step | null {
  const nav = navWith(flowIndex());
  if (nav.plan) return neighborStep(nav.plan, cur, dir, nav.outOfFlow);
  const band = nav.outOfFlow(cur);
  const order = treeOrder(nav.ix).map((fileIndex) => ({ fileIndex }));
  return adjacentStep(order, cur, dir, (s) => nav.outOfFlow(s) !== band);
}

// The next step to review after `cur`: the next in-band step in step order. null when `cur` is
// the last of its band.
export function nextStep(cur: Step): Step | null {
  return stepFrom(cur, 1);
}

// The previous in-band step before `cur`. null at the first — the caller treats that as "go back
// to the Overview page" (or, without a guide, wraps).
export function prevStep(cur: Step): Step | null {
  return stepFrom(cur, -1);
}

// The seeks (seek.ts) compare order entries with ===, so they run over step keys.
function seekStep(
  nav: Nav,
  run: (order: string[], finished: (key: string) => boolean) => string | null,
  keep?: (s: Step) => boolean,
): Step | null {
  const byKey = new Map(navStepsWith(nav, keep).map((s) => [stepKey(s), s] as const));
  const key = run([...byKey.keys()], (k) => {
    const s = byKey.get(k);
    return !!s && nav.finished(s);
  });
  return key === null ? null : (byKey.get(key) ?? null);
}

// Is there any unreviewed step left anywhere in the nav order?
export function anyUnreviewed(): boolean {
  const nav = navWith(flowIndex());
  return navStepsWith(nav).some((s) => !nav.finished(s));
}

// The next unreviewed step after `cur`, wrapping past the end — approve-advance's seek.
// null when no unreviewed step remains (the caller falls back to the review-complete prompt).
// A split file opened whole seeks from its first step's place (see anchorStep), kept in the order
// even when that step left the flow so the seek doesn't restart from the top.
export function nextUnreviewedStep(cur: Step): Step | null {
  const nav = navWith(flowIndex());
  const from = stepKey(nav.plan ? anchorStep(nav.slots, cur, nav.outOfFlow).at : cur);
  const anchored = from !== stepKey(cur);
  return seekStep(
    nav,
    (order, finished) => nextUnreviewed(order, from, finished),
    (s) => !nav.outOfFlow(s) || (anchored && stepKey(s) === from),
  );
}

// Where plain "next" lands when it steps off the last step: first unreviewed, else first step.
export function nextWrapStep(): Step | null {
  return seekStep(navWith(flowIndex()), wrapNextTarget);
}

// Where plain "prev" lands when it steps off the first position: last unreviewed, else last step.
export function prevWrapStep(): Step | null {
  return seekStep(navWith(flowIndex()), wrapPrevTarget);
}

// The title of the part on screen (undefined off a part step) — what a reload re-finds it by.
export function currentPartTitle(): string | undefined {
  return typeof S.stepPart === "number"
    ? S.state?.guide?.files[S.stepPart]?.part?.title
    : undefined;
}

// After a reload or a guide swap moved guide indices under the current step, put the reviewer
// back on it: the same part by path + title, Rest while the file still has unclaimed blocks,
// else the whole file (see carryStep). Call once S.state and S.fileIndex are the new ones.
export function reseatStep(part: Step["part"], title: string | undefined) {
  S.stepPart = hasGuide()
    ? carryStep(guidePlan(flowIndex()), S.fileIndex, part, title).part
    : undefined;
}

// Changed lines (additions + deletions) per file path — the weight used for progress, so
// finishing a big file advances the bar more than a tiny one. Min 1 so every file counts.
function locByPath(): Map<string, number> {
  const m = new Map<string, number>();
  for (const [path, s] of lineStats(S.state?.files ?? []))
    m.set(path, Math.max(s.added + s.removed, 1));
  return m;
}

// Guide categories + their steps (plus the trailing "Other" group of unlisted diff files and
// Rest steps) — the data behind the Walkthrough sidebar tab.
export function walkGroups(): WalkGroup[] {
  if (!hasGuide()) return [];
  // One flow-index pass backs every lookup for the whole group derivation.
  const ix = flowIndex();
  return walkthroughGroups(
    S.state.guide!.files,
    S.state.files ?? [],
    (p) => ix.reviewState(p),
    (p) => ix.outOfFlow.has(p),
    (p) => ix.changesByPath.get(p) ?? [],
  );
}

// Flat rows for the Walkthrough tab's x-for. The "active" highlight is deliberately NOT derived
// here (activePath = null): reading S.fileIndex/S.preview/S.overviewOpen made every file switch
// re-run this whole x-for. applyActiveRow (tree.ts) patches the class imperatively for both
// sidebars. The trailing "Skimmed" group's file rows appear only while the group is expanded.
export function walkthroughRows(): WalkRow[] {
  return walkRows(walkGroups(), null, isSkimGroupExpanded());
}

// Overall review progress for the guide-bar indicator, weighted by changed lines (LOC) rather
// than file count: "done" sums the LOC of files the reviewer finished (approved OR
// changes-requested), "approved" the clean-signoff LOC.
export function guideProgress(): { done: number; approved: number; total: number; pct: number } {
  const byLines = S.settings.progressBy !== "files";
  const loc = byLines ? locByPath() : null;
  // One flow-index pass for the whole loop (see flow-index.ts).
  const ix = flowIndex();
  let total = 0,
    done = 0,
    approved = 0;
  for (const f of S.state?.files ?? []) {
    // Fully-skimmed files carry no progress weight — they left the flow (issue 07).
    if (ix.outOfFlow.has(f.path)) continue;
    const w = byLines ? (loc!.get(f.path) ?? 1) : 1;
    total += w;
    const st = ix.reviewState(f.path);
    if (st !== "pending") done += w;
    if (st === "approved") approved += w;
  }
  // total === 0 means every changed file is fully skimmed (a desk always has ≥1 file, and the
  // strip is hidden when there are none): nothing needs review, so the bar reads complete rather
  // than a misleading 0%.
  return { done, approved, total, pct: total ? Math.round((done / total) * 100) : 100 };
}

// The guide entry for the step currently shown (or null) — drives the diff header's guidance: a
// part step's own entry, an unsplit file's entry, none for a Rest step or a split file opened
// whole (see stepEntry).
export function currentGuideEntry(): GuideFile | null {
  if (!hasGuide()) return null;
  const f = S.state.files[S.fileIndex];
  if (!f) return null;
  return stepEntry(S.state.guide!.files, f.path, S.stepPart);
}

// The titles of the current file's parts, in guide order — empty unless the guide splits it.
// The whole-file view's header names them.
export function currentFileParts(): string[] {
  if (!hasGuide()) return [];
  return guidePlan(flowIndex()).listed.flatMap((s) =>
    s.step.fileIndex === S.fileIndex && s.entry?.part ? [s.entry.part.title] : [],
  );
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
  return hasGuide() && isGuideBaseStale(S.state.baseDiffHash, S.state.guide!.baseDiffHash);
}

// Render the Overview page into #diff: overview → optional PR description → Start. No file
// list — the sidebar (tree/walkthrough, including the Skimmed group) already lists every file,
// so repeating them here was redundant; per-file orientation renders in each file's header.
// Called by render() when overviewOpen && hasGuide().
export function renderOverview() {
  const g = S.state.guide!;
  const title = g.title || S.state.target || "Review";
  $("diff").innerHTML = `<div class="guide-overview"><div class="go-card">
    <h1>${esc(title)}</h1>
    <div class="go-sub">${esc(S.state.mode)} · ${esc(S.state.session)} · ${S.state.files.length} files</div>
    ${g.focused ? `<div class="go-focused"><svg class="ic"><use href="#gly-collapse-all"></use></svg> Focused review — mechanical churn skimmed</div>` : ""}
    ${guideStale() ? `<div class="go-stale"><svg class="ic"><use href="#gly-warn"></use></svg> This guide was generated for an earlier version of the diff. Regenerate it and restart the desk with <code>--guide</code> to refresh.</div>` : ""}
    <div class="go-overview md">${renderMarkdown(g.overview)}</div>
    ${g.prDescription ? `<div class="go-pr"><b>PR description</b><div class="md">${renderMarkdown(g.prDescription)}</div></div>` : ""}
    <div class="go-actions"><button class="btn primary" id="guideStart">Start Review <kbd>↵</kbd></button></div>
  </div></div>`;
  const start = $("diff").querySelector("#guideStart") as HTMLButtonElement | null;
  if (start) start.onclick = () => S.startGuided?.();
}
