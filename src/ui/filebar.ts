import type { FileDiffMetadata } from "@pierre/diffs";
import { getIconForType, SVGSpriteSheet } from "@pierre/diffs";
import { S, $ } from "./store";
import { currentFile, currentSplittable, fileFinished, fileObjections } from "./changes";
import { buildCommentThread, lineThread } from "./annotations";
import { unanchoredThreads } from "./unanchored";
import { approveCurrentFile, resetReview } from "./decisions";
import { blockersChip } from "./blockers";
import { renderMarkdown } from "./markdown";
import { currentGuideEntry } from "./guide";
import { isFileSkim, isFileSkimCollapsed, movedFrom, toggleFileSkim } from "./skim";
import { keycapsHtml } from "./keycaps";

// ── The open file's bar ──────────────────────────────────────────────────────
// One Galley-DOM header serves every file view (diff, skim strip, pure rename, oversized card,
// rendered markdown, preview). render() mounts it as #diff's first child, where it sits sticky
// under the top bar while the view scrolls beneath it. #diff is also where every jump scrolls
// (cursor, go-to-line, blockers, the change-request walk), so the bar's height is mirrored into
// --file-bar-h, which #diff's scroll-padding-top reads: a scrollIntoView then lands below the bar
// instead of under it. The element persists across renders (its contents are rebuilt), so one
// observer tracks it for the session — including its wrap at narrow widths.
let bar: HTMLElement | null = null;
function barElement(): HTMLElement {
  if (bar) return bar;
  const el = document.createElement("div");
  el.className = "file-bar";
  new ResizeObserver(() =>
    $("diff").style.setProperty("--file-bar-h", `${el.offsetHeight}px`),
  ).observe(el);
  bar = el;
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
// @pierre mounts its icon sprite into each diff's shadow root, so a light-DOM `<use>` can't
// reach it. Inject the same sprite into the document once so the bar can reuse @pierre's exact
// change-type icons.
let spriteInjected = false;
function ensureSprite() {
  if (spriteInjected) return;
  const holder = document.createElement("div");
  holder.innerHTML = SVGSpriteSheet;
  const svg = holder.firstElementChild;
  // Out of the flow, like icons.ts's sprite: an inline svg after .app adds a line box below the
  // full-height layout, and a jump scrolling a row into view would scroll the page by that much.
  svg?.setAttribute("style", "position:absolute");
  if (svg) document.body.appendChild(svg);
  spriteInjected = true;
}
// Change-type accent color for the bar's icon.
function ctColor(type: string | undefined): string {
  switch (type) {
    case "new":
      return "var(--green)";
    case "change":
      return "var(--blue)";
    case "deleted":
      return "var(--red)";
    case "rename-pure":
    case "rename-changed":
      return "var(--orange)";
    default:
      return "var(--ink-2)";
  }
}
// @pierre's change-type icon as light-DOM SVG (the lib's createIconElement returns HAST).
function changeIcon(type: string | undefined): SVGElement {
  ensureSprite();
  const t = type ?? "file";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "ghdr-icon");
  svg.setAttribute("data-change-icon", t);
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#" + (getIconForType(t as never) || "diffs-icon-file-code"));
  svg.appendChild(use);
  return svg;
}

// Subtle Split/Stacked segmented control right of the filename. Kept low-contrast so it doesn't
// compete with the filename; clicking re-renders the diff, which rebuilds this control with the
// new active state.
function layoutToggle(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "ghdr-layout seg xs";
  wrap.dataset.tip = "Split / Stacked";
  wrap.dataset.tipKeys = "v";
  const mk = (label: string, style: "split" | "unified") => {
    const b = document.createElement("button");
    b.textContent = label;
    if (S.diffStyle === style) b.className = "active";
    b.onclick = () => S.setStyle?.(style);
    wrap.appendChild(b);
  };
  mk("Split", "split");
  mk("Stacked", "unified");
  return wrap;
}

// Icon-only "jump to this file in the local editor" button — file-scoped, so it lives in the
// file's bar rather than the app chrome (the top bar is for review-final actions).
function openEditorButton(): HTMLElement {
  const b = document.createElement("button");
  b.className = "ghdr-open";
  b.dataset.tip = "Open in editor";
  b.dataset.tipKeys = "⇧E";
  b.innerHTML = `<svg class="ic"><use href="#gly-open-editor"></use></svg>`;
  b.onclick = () => S.openInEditor?.();
  return b;
}

// The per-file sign-off actions. Unfinished → one context button: "Approve" (clean) or "Mark
// reviewed" (has a rejected hunk / open requested-change), which accepts pending hunks, signs off,
// and advances. Finished → a quiet Reset to undo.
function fileActions(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "ghdr-actions";
  const filePath = currentFile().path;
  const reset = () => {
    const b = document.createElement("button");
    b.className = "diff-header-action undo";
    b.textContent = "Reset";
    b.onclick = () => resetReview(filePath);
    return b;
  };
  // The chip lists what keeps the file from Approved (rejected hunks, open change
  // requests) with jump-to actions — rendered whenever objections exist, finished or not.
  const chip = blockersChip();
  // A skim-flagged file that's been expanded gets a quiet re-collapse control (the counterpart
  // to the collapsed strip's Expand), so the reviewer can fold it back after a look.
  if (isFileSkim(filePath) && !isFileSkimCollapsed(filePath)) {
    const collapse = document.createElement("button");
    collapse.className = "diff-header-action skim-collapse";
    collapse.textContent = "Collapse";
    collapse.title = "Collapse this skimmed file";
    collapse.onclick = () => toggleFileSkim(filePath);
    wrap.appendChild(collapse);
  }
  if (fileFinished(filePath)) {
    // The file-tree badge carries the approved / changes-requested state; the bar just
    // offers a quiet Reset to undo the sign-off (plus the blockers chip when relevant).
    if (chip) wrap.appendChild(chip);
    wrap.appendChild(reset());
  } else {
    const objections = fileObjections(filePath);
    // Reset (clear in-progress hunk decisions) sits on the left; Approve is always far right.
    if (S.state.decisionFiles?.includes(filePath)) wrap.appendChild(reset());
    if (chip) wrap.appendChild(chip);
    const button = document.createElement("button");
    button.className = "diff-header-action fill" + (objections ? " warn" : "");
    button.innerHTML = `${objections ? "Mark Reviewed" : "Approve"} ${keycapsHtml("⇧A")}`;
    button.onclick = () => approveCurrentFile();
    wrap.appendChild(button);
  }
  return wrap;
}

// Fill the bar for the current file and return it for render() to mount. `fd` is the rendered
// (decision-replayed) diff when the view is @pierre's, so +/− track what's still on screen; the
// other views count from the file's own stats. A preview gets a minimal bar: a neutral file icon,
// the path and an "Unchanged" tag — no counts, change-type icon or actions, all of which would
// mislabel an unchanged file rendered as one-sided content.
export function renderFileBar(fd?: FileDiffMetadata): HTMLElement {
  const el = barElement();
  const f = currentFile();
  const previewing = !!S.preview;
  const row = document.createElement("div");
  row.className = "ghdr-row1";
  row.appendChild(changeIcon(previewing ? "file" : fd?.type));
  el.style.setProperty("--ct-color", ctColor(previewing ? undefined : fd?.type));
  const name = document.createElement("span");
  name.className = "ghdr-file";
  name.textContent = f.path;
  row.appendChild(name);
  // Rename+edit files (git -M): note where the file moved from, right of the new path.
  const from = previewing ? "" : movedFrom(f.path);
  if (from) {
    const moved = document.createElement("span");
    moved.className = "ghdr-moved";
    moved.title = `moved from ${from}`;
    moved.textContent = `moved from ${from}`;
    row.appendChild(moved);
  }
  // Layout toggle right of the filename — only when Split actually applies (a two-sided diff).
  if (!previewing && fd && currentSplittable()) row.appendChild(layoutToggle());
  row.appendChild(openEditorButton());
  const grow = document.createElement("span");
  grow.className = "ghdr-grow";
  row.appendChild(grow);
  if (previewing) {
    const tag = document.createElement("span");
    tag.className = "ghdr-readonly";
    tag.textContent = "Unchanged";
    row.appendChild(tag);
    el.replaceChildren(row);
    return el;
  }
  let add = f.added ?? 0,
    del = f.removed ?? 0;
  if (fd) {
    add = del = 0;
    for (const h of fd.hunks) {
      add += h.additionLines ?? 0;
      del += h.deletionLines ?? 0;
    }
  }
  const counts = document.createElement("span");
  counts.className = "ghdr-counts";
  counts.innerHTML = `<span class="a">+${add}</span><span class="d">−${del}</span>`;
  row.appendChild(counts);
  row.appendChild(fileActions());
  el.replaceChildren(row);
  return el;
}

// What reads before the diff, under the bar and scrolling with the code: the guide's note on this
// file, then any open threads whose anchor line no longer renders. Null when there's neither.
export function fileLead(): HTMLElement | null {
  const entry = currentGuideEntry();
  const orphans = unanchoredThreads();
  if (!entry && !orphans.length) return null;
  const lead = document.createElement("div");
  lead.className = "file-lead";
  if (entry) {
    // Group the AI guidance into a subtle card, set apart from the bar + the code. The prose
    // fields render as markdown (renderMarkdown sanitizes) — the guidance is the main reading
    // content of a guided review, so identifiers/lists the agent writes survive.
    const guide = document.createElement("div");
    guide.className = "ghdr-guide";
    const chip = document.createElement("span");
    chip.className = "ghdr-cat" + (entry.flag ? " crit" : "");
    chip.textContent = entry.category;
    guide.appendChild(chip);
    // A whole-file skim entry may omit its orientation; the skim reason (if any) takes the
    // slot. Only the expanded file reaches the diff view — the collapsed strip shows the reason.
    if (entry.orientation) {
      const expl = document.createElement("div");
      expl.className = "ghdr-expl md";
      expl.innerHTML = renderMarkdown(entry.orientation);
      guide.appendChild(expl);
    } else if (entry.skimReason) {
      const why = document.createElement("div");
      why.className = "ghdr-skim";
      why.textContent = `skimmed · ${entry.skimReason}`;
      guide.appendChild(why);
    }
    // A flagged file gets its own readable callout within the card.
    if (entry.flag) {
      const flag = document.createElement("div");
      flag.className = "ghdr-flag";
      flag.innerHTML = `<svg class="ic"><use href="#gly-flag"></use></svg><div class="md">${renderMarkdown(entry.flag)}</div>`;
      guide.appendChild(flag);
    }
    lead.appendChild(guide);
  }
  // Open threads whose anchor line no longer renders — shown before the diff's first row so they
  // stay actionable (they block approval until resolved).
  if (orphans.length) {
    const strip = document.createElement("div");
    strip.className = "unanchored-strip";
    const head = document.createElement("div");
    head.className = "unanchored-head";
    head.textContent = `${orphans.length} comment thread${orphans.length === 1 ? "" : "s"} lost ${orphans.length === 1 ? "its" : "their"} place in this diff — resolve or reply here`;
    strip.appendChild(head);
    for (const t of orphans) {
      // Reuse the annotation thread styling (it's all scoped under .annotation).
      const box = document.createElement("div");
      box.className = "annotation";
      box.dataset.thread = `${t.side}:${t.lineNumber}`; // blockers jump target
      box.appendChild(buildCommentThread(t, lineThread(t)));
      strip.appendChild(box);
    }
    lead.appendChild(strip);
  }
  return lead;
}
