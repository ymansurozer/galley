import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import { getIconForType, SVGSpriteSheet } from "@pierre/diffs";
import { S, D, $ } from "./store";
import { currentFile, currentChanges, currentSplittable, ensureChangesFromFileDiff, replayDecisions } from "./changes";
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

// @pierre renders the diff into a shadow root mounted on some descendant of #diff. Find it
// so we can measure rendered change rows for the overview ruler.
function findDiffShadow(): ShadowRoot | null {
  let shadow: ShadowRoot | null = null;
  $("diff").querySelectorAll("*").forEach((el) => { if ((el as HTMLElement).shadowRoot) shadow = (el as HTMLElement).shadowRoot; });
  return shadow;
}

export function clearOverviewRuler() { const o = $("ovr"); o.classList.remove("show"); o.replaceChildren(); }

// VSCode-style change overview: map every change row's position in the scrolled content to a
// tick in a fixed right-edge ruler, so changes are visible in one skim of the whole file.
// Only meaningful in "expand unchanged" mode (otherwise the diff is already compact).
function renderOverviewRuler() {
  const ruler = $("ovr");
  ruler.replaceChildren();
  const diff = $("diff");
  const shadow = findDiffShadow();
  const contentH = diff.scrollHeight;
  const rows = shadow ? Array.from(shadow.querySelectorAll<HTMLElement>("[data-line-type^='change-']")) : [];
  if (!rows.length || !contentH) { ruler.classList.remove("show"); return; }
  const diffTop = diff.getBoundingClientRect().top;
  const scrollTop = diff.scrollTop;
  // @pierre tags both the gutter cell and the code cell of a line with data-line-type, so each
  // line matches twice — dedupe by side + rounded position, then sort top-to-bottom.
  const byPos = new Map<string, { side: "add" | "del"; top: number; bottom: number }>();
  for (const row of rows) {
    const side: "add" | "del" = (row.getAttribute("data-line-type") || "").includes("addition") ? "add" : "del";
    const r = row.getBoundingClientRect();
    if (!r.height) continue;
    const top = r.top - diffTop + scrollTop;
    byPos.set(`${side}:${Math.round(top)}`, { side, top, bottom: top + r.height });
  }
  const sorted = [...byPos.values()].sort((a, b) => a.top - b.top);
  // Coalesce contiguous rows of the same side into one bar (a 5-line block → one tick).
  const marks: { side: "add" | "del"; top: number; bottom: number }[] = [];
  for (const s of sorted) {
    const last = marks[marks.length - 1];
    if (last && last.side === s.side && s.top - last.bottom <= s.bottom - s.top) last.bottom = s.bottom;
    else marks.push({ ...s });
  }
  for (const m of marks) {
    const i = document.createElement("i");
    i.className = m.side;
    i.style.top = `${(m.top / contentH) * 100}%`;
    i.style.height = `${Math.max(((m.bottom - m.top) / contentH) * 100, 0.3)}%`;
    ruler.appendChild(i);
  }
  ruler.classList.add("show");
}

export async function render() {
  clearOverviewRuler();
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
  const previewing = !!S.preview;
  // Markdown file in rendered mode: formatted preview with block-anchored comments,
  // instead of the @pierre/diffs view.
  if (!previewing && S.state.mode === "file" && isMarkdownPath(f.path) && S.fileView === "rendered") {
    D.instance = null;
    applyLayoutClasses();
    renderMarkdownFile();
    return;
  }
  // @pierre renders nothing for a zero-change diff, so a whole-file view (a new file, or a
  // `preview` — an unchanged file the reviewer opened) is shown as the file's content on one
  // side. For preview we strip the add-tint + indicators below so it reads as plain text, not
  // an "added" file; it stays line-selectable for comments.
  const viewOnly = previewing || (S.state.mode === "file" && (f.oldFile.contents === "" || f.oldFile.contents === f.newFile.contents));
  let fd: FileDiffMetadata;
  if (viewOnly) {
    fd = D.parseDiffFromFile({ name: f.newFile.name, contents: "" }, f.newFile);
  } else {
    fd = D.parseDiffFromFile(f.oldFile, f.newFile);
    ensureChangesFromFileDiff(fd); fd = replayDecisions(fd);
  }
  // Preview reads as a plain file: remap @pierre's addition styling to its CONTEXT (unchanged)
  // styling — row tint, gutter cell bg, and gutter number color all to the neutral context
  // values — so a one-sided render of an unchanged file isn't all-green. These must be set
  // INSIDE @pierre's shadow (via unsafeCSS below): the context vars they reference only exist
  // there, so a host-level override referencing them is invalid and silently reverts.
  const previewCSS = previewing
    ? "[data-code]{--diffs-bg-addition-override:var(--diffs-bg-context);--diffs-bg-addition-emphasis-override:var(--diffs-bg-context);--diffs-bg-addition-number-override:var(--diffs-bg-context-gutter);--diffs-fg-number-addition-override:var(--diffs-fg-number)}"
    : "";
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
  // Preview gets its own minimal header: a neutral file icon + path + a read-only tag — no
  // +/- counts, change-type icon, or guidance (all of which would mislabel an unchanged file
  // rendered as one-sided content). The Viewed/Keep-All actions don't apply to a preview.
  const previewHeader = () => {
    const wrap = document.createElement("div"); wrap.className = "ghdr";
    const row1 = document.createElement("div"); row1.className = "ghdr-row1";
    row1.appendChild(changeIcon("file"));
    const name = document.createElement("span"); name.className = "ghdr-file"; name.textContent = currentFile().path; row1.appendChild(name);
    const grow = document.createElement("span"); grow.className = "ghdr-grow"; row1.appendChild(grow);
    const tag = document.createElement("span"); tag.className = "ghdr-readonly"; tag.textContent = "Unchanged · read-only"; row1.appendChild(tag);
    wrap.appendChild(row1);
    return wrap;
  };
  const inst = new D.FileDiff({
    theme: { dark: S.settings.theme, light: "pierre-light" }, themeType: "dark", diffStyle: currentSplittable() ? S.diffStyle : "unified", diffIndicators: previewing ? "none" : S.settings.diffIndicators, expandUnchanged: S.settings.unchangedLines === "expand", overflow: S.settings.overflow, hunkSeparators: S.settings.hunkSeparators, lineDiffType: S.settings.lineDiffType, enableLineSelection: true,
    renderAnnotation, onLineNumberClick: handleLineNumberClick, onLineSelectionStart: handleDiffSelection, onLineSelectionChange: handleDiffSelection, onLineSelected: handleDiffSelection, onLineSelectionEnd: handleDiffSelection,
    renderHeaderMetadata: headerActions,
    // @pierre reserves a right-side gutter via `scrollbar-gutter: stable` on the code grid
    // (for a vertical scrollbar it hides) — drop it so rows fill the full width. previewCSS
    // (empty unless previewing) neutralizes addition styling to context, in-shadow.
    unsafeCSS: "[data-code]{scrollbar-gutter:auto}" + previewCSS,
    // Preview → minimal read-only header; else with a guide → our consolidated header.
    ...(previewing ? { renderCustomHeader: previewHeader } : hasGuide() ? { renderCustomHeader: guidedHeader } : {}),
  });
  D.instance = inst;
  // annotations() is our own AnnotationInput[]; the lib's DiffLineAnnotation<T> is a
  // discriminated union whose assignability check rejects our union-typed metadata,
  // though the runtime shape (side/lineNumber/metadata) is exactly what it reads.
  await inst.render({ fileDiff: fd, containerWrapper: $("diff"), lineAnnotations: annotations() as DiffLineAnnotation<AnnotationMeta>[] });
  setTimeout(() => attachDiffSelectionHandlers(), 0);
  // The overview ruler only makes sense when the whole file is shown (expand mode) and there
  // are real changes (not a preview). Measure after a frame so rows have laid out.
  if (!previewing && S.settings.unchangedLines === "expand") requestAnimationFrame(() => renderOverviewRuler());
}
