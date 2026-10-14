import { S, $ } from "./store";
import { currentSlot, progressDetail } from "./guide";
import { slotOutOfFlow } from "./steps";
import { flowIndex } from "./changes";
import { approvePreview, progressSummary } from "./progress-derive";

// Review progress lives on the top bar's bottom edge, with or without a guide: a quiet gauge with
// the ⇧A tail ahead of its fill, and no resting percentage. A tag beside the title speaks when
// asked (hover the bar or the title), then fades. Imperative rather than Alpine because the
// *moment* of progress is animated: the fill glides from where it stood and a rise swells the bar
// for a beat.

// Tab title carries progress too ("(58%) Galley — repo · main"), so it reads from other tabs.
// The base names the project and what of it is under review, so multiple desks are
// distinguishable in the browser. Context: repo mode → the branch; pr mode → the (truncated) head
// branch; file mode → the file name. A detached HEAD has no branch, so the title drops it.
// Re-derived wherever S.state is replaced (init, and poll adoption — a reload can move the
// branch); updateProgress stamps the prefix.
let baseTitle = document.title;
export function refreshBaseTitle() {
  const base = (p?: string) => p?.replace(/\/+$/, "").split("/").pop() || "";
  const { mode, target, branch, project, root } = S.state;
  const ref = (mode === "pr" ? target : branch) ?? "";
  const context = mode === "file" ? base(target) : ref.slice(0, 32) + (ref.length > 32 ? "…" : "");
  baseTitle = `Galley — ${project ?? base(root)}${context ? ` · ${context}` : ""}`;
}

// What the bar last drew, and what progress counted by then; null until the first paint.
let shown: { pct: number; byLines: boolean } | null = null;
let swellTimer = 0;
const SWELL_MS = 300;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// Fill the tag: its figure, then the rest.
function showTag(figure: string, rest: string) {
  const tag = $("progressTag");
  const b = document.createElement("b");
  b.textContent = figure;
  tag.replaceChildren(b, rest);
  tag.classList.remove("out");
  tag.classList.add("show");
}

function hideTag() {
  const tag = $("progressTag");
  if (!tag.classList.contains("show") || tag.classList.contains("out")) return;
  tag.classList.add("out");
  tag.addEventListener(
    "animationend",
    () => {
      // A show since the fade began took the tag back.
      if (tag.classList.contains("out")) tag.classList.remove("show", "out");
    },
    { once: true },
  );
}

// Whether the pointer rests on the bar or the title, read live: a hidden bar (the App view) never
// gets the pointerleave a kept flag would wait for.
const hovered = () =>
  $("progressStrip").matches(":hover") || !!document.querySelector(".top-name:hover");

// The hover tag: where progress stands, with the steps (and lines) behind it, all guideProgress's.
function showSummary(d = progressDetail()) {
  if (!S.state?.files?.length || S.view === "ui") return hideTag();
  const p = d.progress;
  const lines = d.byLines ? { done: p.done, total: p.total } : null;
  const s = progressSummary(p.pct, d.steps, lines, d.steps.unit);
  showTag(s.pct, ` · ${s.detail}`);
}

function swell(strip: HTMLElement) {
  strip.classList.add("swell");
  clearTimeout(swellTimer);
  swellTimer = window.setTimeout(() => strip.classList.remove("swell"), SWELL_MS);
}

// Hovering the bar or the title asks for the numbers.
export function installProgress() {
  for (const el of [$("progressStrip"), document.querySelector(".top-name")]) {
    el?.addEventListener("pointerenter", () => showSummary());
    el?.addEventListener("pointerleave", () => {
      if (!hovered()) hideTag();
    });
  }
}

// Called from render(): every state mutation that can move progress ends in a render, so
// this is the single repaint point (and it must stay cheap — guideProgress is one pass).
export function updateProgress() {
  const strip = $("progressStrip");
  if (!strip) return;
  const hasFiles = !!S.state?.files?.length;
  strip.style.display = hasFiles ? "" : "none";
  if (!hasFiles) {
    document.title = baseTitle;
    return;
  }
  const d = progressDetail();
  const { pct } = d.progress;
  document.title = pct >= 100 ? `✓ ${baseTitle}` : pct > 0 ? `(${pct}%) ${baseTitle}` : baseTitle;
  // The ⇧A tail: what approving the step open in the diff would add (a part, a Rest, or the file
  // whole; not a preview, which isn't in the review). CSS transitions glide the fill and the tail
  // from where they stood.
  const slot = S.view === "code" && !S.overviewOpen ? currentSlot() : null;
  const ahead = approvePreview(
    d.progress,
    slot
      ? {
          weight: d.weight(slot),
          outOfFlow: slotOutOfFlow(slot, (p) => d.ix.outOfFlow.has(p)),
          state: d.ix.stepState(slot),
        }
      : null,
  );
  $("progressFill").style.width = `${pct}%`;
  $("progressTail").style.left = `${pct}%`;
  $("progressTail").style.width = `${ahead?.tail ?? 0}%`;
  // A rise is a sign-off's moment: the bar swells while the fill glides. The first paint and a
  // switch of what progress counts by aren't moments, and a drop just glides back (its toast says
  // why).
  const rose = shown?.byLines === d.byLines && pct > shown.pct;
  shown = { pct, byLines: d.byLines };
  if (rose && !reducedMotion.matches) swell(strip);
  // The tag follows the pointer, whatever happened while the bar was away.
  if (hovered()) showSummary(d);
  else hideTag();
}

// Whole-review numbers for the completion prompt — a small receipt of the work done.
export function reviewStats(): {
  files: number;
  lines: number;
  comments: number;
  rejections: number;
} {
  // Files out of the flow — fully skimmed or pure renames (issue 01/07) — stay out of the
  // completion receipt's file and line totals so the numbers match the progress bar and the gate.
  // One flow-index pass instead of a per-file rescan (see flow-index.ts).
  const outOfFlow = flowIndex().outOfFlow;
  const scope = (S.state?.files ?? []).filter((f) => !outOfFlow.has(f.path));
  let lines = 0;
  for (const f of scope)
    for (const h of f.hunks ?? []) for (const l of h.lines) if (l.kind !== "context") lines++;
  return {
    files: scope.length,
    lines,
    comments: (S.state?.comments ?? []).filter((c) => c.role === "user" && c.status === "open")
      .length,
    rejections: (S.state?.changes ?? []).filter((c) => c.status === "rejected").length,
  };
}
