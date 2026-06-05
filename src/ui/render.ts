import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import { getIconForType, SVGSpriteSheet } from "@pierre/diffs";
import { S, D, $ } from "./store";
import { currentFile, currentChanges, ensureChangesFromFileDiff, replayDecisions } from "./changes";
import type { AnnotationMeta } from "./types";
import { applyLayoutClasses } from "./tree";
import { annotations, renderAnnotation } from "./annotations";
import { handleLineNumberClick, handleDiffSelection, attachDiffSelectionHandlers } from "./selection";
import { keepAllCurrentFile, resetReview, toggleReviewed } from "./decisions";
import { isMarkdownPath, renderMarkdownFile } from "./mdfile";
import { hasGuide, renderOverview, currentGuideEntry } from "./guide";

const SVG_NS = "http://www.w3.org/2000/svg";
// @pierre mounts its icon sprite into each diff's shadow root, so a light-DOM `<use>` can't
// reach it. Inject the same sprite into the document once so our custom header can reuse
// @pierre's exact change-type icons.
let spriteInjected = false;
function ensureSprite() {
  if (spriteInjected) return;
  const holder = document.createElement("div");
  holder.innerHTML = SVGSpriteSheet;
  const svg = holder.firstElementChild;
  if (svg) document.body.appendChild(svg);
  spriteInjected = true;
}
// Change-type accent color, shared by the header icon and the guidance blockquote line.
function ctColor(type: string | undefined): string {
  switch (type) {
    case "new": return "var(--green)";
    case "change": return "var(--cyan)";
    case "deleted": return "var(--red)";
    case "rename-pure": case "rename-changed": return "var(--amber)";
    default: return "var(--muted)";
  }
}
// @pierre's change-type icon as light-DOM SVG (the lib's createIconElement returns HAST).
function changeIcon(type: string | undefined): SVGElement {
  ensureSprite();
  const t = type ?? "file";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "ghdr-icon"); svg.setAttribute("data-change-icon", t);
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#" + (getIconForType(t as never) || "diffs-icon-file-code"));
  svg.appendChild(use);
  return svg;
}

export async function render() {
  if (D.instance) D.instance.cleanUp?.();
  // Drop any leftover rendered-markdown DOM before either path re-renders into #diff
  // (@pierre/diffs manages only its own root, so it won't clear our injected .md-file).
  const host = $("diff");
  // Clear our own injected DOM (markdown preview or the guide Overview) before either
  // path re-renders — @pierre/diffs only manages its own root, so it won't remove these.
  if (host.querySelector(".md-file") || host.querySelector(".guide-overview")) host.innerHTML = "";
  // Guided review: the Overview page takes over the center until a file is selected.
  if (S.overviewOpen && hasGuide()) { D.instance = null; renderOverview(); return; }
  const f = currentFile();
  // Markdown file in rendered mode: formatted preview with block-anchored comments,
  // instead of the @pierre/diffs view.
  if (S.state.mode === "file" && isMarkdownPath(f.path) && S.fileView === "rendered") {
    D.instance = null;
    applyLayoutClasses();
    renderMarkdownFile();
    return;
  }
  const viewOnly = S.state.mode === "file" && (f.oldFile.contents === "" || f.oldFile.contents === f.newFile.contents);
  let fd = viewOnly ? D.parseDiffFromFile({ name: f.newFile.name, contents: "" }, f.newFile) : D.parseDiffFromFile(f.oldFile, f.newFile);
  if (!viewOnly) { ensureChangesFromFileDiff(fd); fd = replayDecisions(fd); }
  D.fileDiff = fd;
  applyLayoutClasses();
  // The per-file actions in the diff header (Keep All / Reset Decisions / Viewed) — shared by
  // the default header (renderHeaderMetadata) and the guided custom header below.
  const headerActions = () => {
    const wrap = document.createElement("span");
    const filePath = currentFile().path;
    const pending = currentChanges().filter((c) => c.status === "pending");
    const viewed = S.state.reviewedFiles?.includes(filePath);
    if (pending.length) { const button = document.createElement("button"); button.className = "diff-header-action"; button.textContent = "Keep All"; button.onclick = () => keepAllCurrentFile(); wrap.appendChild(button); }
    if (!pending.length && S.state.decisionFiles?.includes(filePath)) { const reset = document.createElement("button"); reset.className = "diff-header-action undo"; reset.textContent = "Reset Decisions"; reset.onclick = () => resetReview(filePath); wrap.appendChild(reset); }
    if (S.state.mode !== "file") { const actions = document.createElement("span"); actions.className = "file-header-actions"; actions.innerHTML = `<label><input type="checkbox" ${viewed ? "checked" : ""}>Viewed</label>`; (actions.querySelector("input") as any).onchange = () => toggleReviewed(filePath); wrap.appendChild(actions); }
    return wrap;
  };
  // Guided mode: a two-row custom header. Row 1 preserves @pierre's look — change-type icon
  // + filename + counts — with our actions. Row 2 (left-aligned) carries the category +
  // AI guidance, so the top bar can drop them.
  const guidedHeader = (file: FileDiffMetadata) => {
    const entry = currentGuideEntry();
    const wrap = document.createElement("div");
    wrap.className = "ghdr";
    wrap.style.setProperty("--ct-color", ctColor(file?.type));

    const row1 = document.createElement("div"); row1.className = "ghdr-row1";
    row1.appendChild(changeIcon(file?.type));
    const name = document.createElement("span"); name.className = "ghdr-file"; name.textContent = currentFile().path; row1.appendChild(name);
    const grow = document.createElement("span"); grow.className = "ghdr-grow"; row1.appendChild(grow);
    let add = 0, del = 0; for (const h of file?.hunks ?? []) { add += h.additionLines ?? 0; del += h.deletionLines ?? 0; }
    const counts = document.createElement("span"); counts.className = "ghdr-counts"; counts.innerHTML = `<span class="a">+${add}</span><span class="d">−${del}</span>`; row1.appendChild(counts);
    const acts = headerActions(); acts.className = "ghdr-actions"; row1.appendChild(acts);
    wrap.appendChild(row1);

    if (entry) {
      // Group the AI guidance into a subtle card, set apart from the filename row + the code.
      const guide = document.createElement("div"); guide.className = "ghdr-guide";
      const row2 = document.createElement("div"); row2.className = "ghdr-row2";
      const chip = document.createElement("span"); chip.className = "ghdr-cat" + (entry.critical ? " crit" : ""); chip.textContent = entry.category; row2.appendChild(chip);
      const expl = document.createElement("span"); expl.className = "ghdr-expl"; expl.textContent = entry.summary; row2.appendChild(expl);
      guide.appendChild(row2);
      // Critical "why" gets its own readable callout within the card.
      if (entry.critical && entry.why) { const why = document.createElement("div"); why.className = "ghdr-why"; why.textContent = "⚑ " + entry.why; guide.appendChild(why); }
      wrap.appendChild(guide);
    }
    return wrap;
  };
  const inst = new D.FileDiff({
    theme: { dark: S.settings.theme, light: "pierre-light" }, themeType: "dark", diffStyle: S.diffStyle, diffIndicators: S.settings.diffIndicators, overflow: S.settings.overflow, hunkSeparators: S.settings.hunkSeparators, lineDiffType: S.settings.lineDiffType, enableLineSelection: true,
    renderAnnotation, onLineNumberClick: handleLineNumberClick, onLineSelectionStart: handleDiffSelection, onLineSelectionChange: handleDiffSelection, onLineSelected: handleDiffSelection, onLineSelectionEnd: handleDiffSelection,
    renderHeaderMetadata: headerActions,
    // With a guide, replace the whole header with our consolidated one.
    ...(hasGuide() ? { renderCustomHeader: guidedHeader } : {}),
  });
  D.instance = inst;
  // annotations() is our own AnnotationInput[]; the lib's DiffLineAnnotation<T> is a
  // discriminated union whose assignability check rejects our union-typed metadata,
  // though the runtime shape (side/lineNumber/metadata) is exactly what it reads.
  await inst.render({ fileDiff: fd, containerWrapper: $("diff"), lineAnnotations: annotations() as DiffLineAnnotation<AnnotationMeta>[] });
  setTimeout(() => attachDiffSelectionHandlers(), 0);
}
