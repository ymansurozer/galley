import { S, $ } from "./store";
import { guideProgress, progressWeight } from "./guide";
import { fileReviewState, flowIndex } from "./changes";
import { fileOutOfFlow } from "./skim";
import { approvePreview, approveTag, progressSummary } from "./progress-derive";

// Review progress lives on the top bar's bottom edge, with or without a guide: a quiet gauge with
// the ⇧A tail ahead of its fill, and no resting percentage. A tag beside the title speaks when
// asked (hover the bar or the title) or when a sign-off raises progress, then fades. Imperative
// rather than Alpine because the *moment* of progress is animated: the fill glides from where it
// stood and the bar swells for a beat.

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
// A rise's tag holds the stage until then; hovering doesn't replace it.
let riseUntil = 0;
let riseTimer = 0;
let swellTimer = 0;
let hovering = false;
const RISE_MS = 2000;
const SWELL_MS = 300;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// Fill the tag: its figure, then the rest.
function showTag(figure: string, rest: string, rise: boolean) {
  const tag = $("progressTag");
  const b = document.createElement("b");
  b.textContent = figure;
  tag.replaceChildren(b, rest);
  tag.classList.toggle("up", rise);
  tag.classList.remove("out");
  tag.classList.add("show");
}

function hideTag() {
  const tag = $("progressTag");
  if (!tag.classList.contains("show")) return;
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

// The hover tag: where progress stands, with the files (and lines) behind it. Its counts are
// guideProgress's, and the files the same in-flow scope it weighs.
function showSummary() {
  if (!S.state?.files?.length || S.view === "ui") return;
  const p = guideProgress();
  const ix = flowIndex();
  const scope = S.state.files.filter((f) => !ix.outOfFlow.has(f.path));
  const files = {
    done: scope.filter((f) => ix.reviewState(f.path) !== "pending").length,
    total: scope.length,
  };
  const byLines = S.settings.progressBy !== "files";
  const s = progressSummary(p.pct, files, byLines ? { done: p.done, total: p.total } : null);
  showTag(s.pct, ` · ${s.detail}`, false);
}

// A sign-off raised progress: the tag says by how much and where it stands, for a moment.
function showRise(gain: number, to: number) {
  showTag(`+${gain}%`, ` → ${to}%`, true);
  riseUntil = performance.now() + RISE_MS;
  clearTimeout(riseTimer);
  riseTimer = window.setTimeout(() => {
    riseUntil = 0;
    if (hovering) showSummary();
    else hideTag();
  }, RISE_MS);
}

function swell(strip: HTMLElement) {
  strip.classList.add("swell");
  clearTimeout(swellTimer);
  swellTimer = window.setTimeout(() => strip.classList.remove("swell"), SWELL_MS);
}

// Hovering the bar or the title asks for the numbers.
export function installProgress() {
  for (const el of [$("progressStrip"), document.querySelector(".top-name")]) {
    el?.addEventListener("pointerenter", () => {
      hovering = true;
      if (performance.now() >= riseUntil) showSummary();
    });
    el?.addEventListener("pointerleave", () => {
      hovering = false;
      if (performance.now() >= riseUntil) hideTag();
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
  const p = guideProgress();
  const pct = p.pct;
  document.title = pct >= 100 ? `✓ ${baseTitle}` : pct > 0 ? `(${pct}%) ${baseTitle}` : baseTitle;
  // The ⇧A tail: what approving the file open in the diff would add (not a preview, which isn't
  // in the review). CSS transitions glide the fill and the tail from where they stood.
  const file = S.view === "code" && !S.overviewOpen && !S.preview && S.state.files[S.fileIndex];
  const ahead = approvePreview(
    p,
    file
      ? {
          weight: progressWeight(file.path),
          outOfFlow: fileOutOfFlow(file.path),
          state: fileReviewState(file.path),
        }
      : null,
  );
  $("progressFill").style.width = `${pct}%`;
  $("progressTail").style.left = `${pct}%`;
  $("progressTail").style.width = `${ahead?.tail ?? 0}%`;
  // A rise is a sign-off's moment: the bar swells while the fill glides, and the tag says what it
  // gained. The first paint and a switch of what progress counts by aren't moments, and a drop
  // just glides back (its toast says why).
  const byLines = S.settings.progressBy !== "files";
  const rise = shown?.byLines === byLines ? approveTag(shown.pct, pct) : null;
  shown = { pct, byLines };
  if (rise) {
    if (!reducedMotion.matches) swell(strip);
    showRise(rise.gain, rise.to);
  } else if (hovering && performance.now() >= riseUntil) showSummary();
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
