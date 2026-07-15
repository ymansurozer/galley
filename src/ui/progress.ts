import { S, $ } from "./store";
import { guideProgress } from "./guide";
import { flowIndex } from "./changes";

// Persistent review-progress chrome: a full-width fill strip along the bottom edge of the
// topbar plus a "% reviewed" label beside the actions, visible with or without a guide (the
// guidebar used to be progress's only home, so guideless desks showed none). Imperative
// rather than Alpine because the *moment* of progress is animated — the number counts up
// odometer-style and the strip pulses when the bar advances — which is rAF work.

// Tab title carries progress too ("(58%) Galley — repo"), so it reads from other tabs.
// main.ts names the base title at init; updateProgress stamps the prefix.
let baseTitle = document.title;
export function setBaseTitle(title: string) {
  baseTitle = title;
}

let shownPct: number | null = null; // % the label currently shows; null until first paint
let raf = 0;

// Count the label from `from` to `to` over ~450ms (ease-out) instead of jumping.
function countUp(label: HTMLElement, from: number, to: number) {
  cancelAnimationFrame(raf);
  const start = performance.now();
  const tick = (now: number) => {
    const k = Math.min(1, (now - start) / 450);
    const eased = 1 - (1 - k) ** 3;
    label.textContent = `${Math.round(from + (to - from) * eased)}% reviewed`;
    if (k < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

// Restart the .pulse CSS animation even when the class is already on the element.
function pulse(el: HTMLElement) {
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
}

// Called from render(): every state mutation that can move progress ends in a render, so
// this is the single repaint point (and it must stay cheap — guideProgress is one pass).
export function updateProgress() {
  const strip = $("progressStrip");
  const label = $("progressPct");
  if (!strip || !label) return;
  const hasFiles = !!S.state?.files?.length;
  strip.style.display = hasFiles ? "" : "none";
  label.style.display = hasFiles ? "" : "none";
  if (!hasFiles) {
    document.title = baseTitle;
    return;
  }
  const pct = guideProgress().pct;
  document.title = pct >= 100 ? `✓ ${baseTitle}` : pct > 0 ? `(${pct}%) ${baseTitle}` : baseTitle;
  ($("progressFill") as HTMLElement).style.width = `${pct}%`; // CSS transition animates the fill
  if (shownPct === null || pct === shownPct) {
    // First paint, or no movement (a re-render that didn't change progress): no ceremony.
    label.textContent = `${pct}% reviewed`;
    shownPct = pct;
    return;
  }
  if (pct > shownPct) pulse(strip);
  countUp(label, shownPct, pct);
  shownPct = pct;
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
