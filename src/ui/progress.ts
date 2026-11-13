import { S, $ } from "./store";
import { currentSlot, progressDetail } from "./guide";
import { slotOutOfFlow } from "./steps";
import { flowIndex } from "./changes";
import { approvePreview, type Progress } from "./progress-derive";
import { topicSettled, topicsDone } from "./topics-derive";

// Review progress lives on the top bar's bottom edge, with or without a guide: a quiet gauge with
// the ⇧A tail ahead of its fill. Imperative rather than Alpine because the *moment* of progress is
// animated: the fill glides from where it stood and a rise swells the bar for a beat.

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

// What the bar last drew, and what progress counted by then (lines, files, or in Decisions mode
// topics); null until the first paint.
let shown: { pct: number; by: "lines" | "files" | "topics" } | null = null;
let swellTimer = 0;
const SWELL_MS = 300;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function swell(strip: HTMLElement) {
  strip.classList.add("swell");
  clearTimeout(swellTimer);
  swellTimer = window.setTimeout(() => strip.classList.remove("swell"), SWELL_MS);
}

// Called from render(): every state mutation that can move progress ends in a render, so
// this is the single repaint point (and it must stay cheap — progressDetail is one pass).
export function updateProgress() {
  const strip = $("progressStrip");
  if (!strip) return;
  const hasFiles = !!S.state?.files?.length;
  strip.style.display = hasFiles ? "" : "none";
  if (!hasFiles) {
    document.title = baseTitle;
    return;
  }
  const { progress, ahead, by } = S.view === "topics" ? topicsProgress() : codeProgress();
  const { pct } = progress;
  document.title = pct >= 100 ? `✓ ${baseTitle}` : pct > 0 ? `(${pct}%) ${baseTitle}` : baseTitle;
  $("progressFill").style.width = `${pct}%`;
  $("progressTail").style.left = `${pct}%`;
  $("progressTail").style.width = `${ahead?.tail ?? 0}%`;
  // A rise is a sign-off's moment: the bar swells while the fill glides. The first paint and a
  // switch of what progress counts by aren't moments, and a drop just glides back.
  const rose = shown?.by === by && pct > shown.pct;
  shown = { pct, by };
  if (rose && !reducedMotion.matches) swell(strip);
}

// Code mode's progress, and the ⇧A tail: what approving the step open in the diff would add (a
// part, a Rest, or the file whole; not a preview, which isn't in the review). CSS transitions glide
// the fill and the tail from where they stood.
function codeProgress() {
  const d = progressDetail();
  const slot = S.view === "code" && !S.overviewOpen ? currentSlot() : null;
  const ahead = approvePreview(
    d.progress,
    slot
      ? {
          weight: d.aheadWeight(slot),
          outOfFlow: slotOutOfFlow(slot, (p) => d.ix.outOfFlow.has(p)),
          state: d.ix.stepState(slot),
        }
      : null,
  );
  return { progress: d.progress, ahead, by: d.byLines ? ("lines" as const) : ("files" as const) };
}

// Decisions mode's: the share of topics settled, and the open topic as the ⇧A tail while it is to
// do.
function topicsProgress() {
  const stages = S.state.guide?.stages ?? [];
  const { done, total } = topicsDone(stages, S.state);
  const progress: Progress = { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  const open = S.topicAt !== null && !topicSettled(S.state, S.topicAt);
  const ahead = approvePreview(
    progress,
    open ? { weight: 1, outOfFlow: false, state: "pending" } : null,
  );
  return { progress, ahead, by: "topics" as const };
}

// Whole-review numbers for the Send receipt and the completion prompt.
export function reviewStats(): { files: number; rejections: number } {
  // Files out of the flow — fully skimmed or pure renames (issue 01/07) — stay out of the
  // completion prompt's file count so it matches the progress bar and the gate. One flow-index
  // pass instead of a per-file rescan (see flow-index.ts).
  const outOfFlow = flowIndex().outOfFlow;
  return {
    files: (S.state?.files ?? []).filter((f) => !outOfFlow.has(f.path)).length,
    rejections: (S.state?.changes ?? []).filter((c) => c.status === "rejected").length,
  };
}
