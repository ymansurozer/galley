import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import { getIconForType, SVGSpriteSheet } from "@pierre/diffs";
import { S, D, $ } from "./store";
import {
  currentFile,
  currentSplittable,
  ensureChangesFromFileDiff,
  replayDecisions,
  syncDisplayAnchors,
  fileFinished,
  fileObjections,
} from "./changes";
import type { AnnotationMeta } from "./types";
import { applyLayoutClasses } from "./tree";
import { annotations, renderAnnotation, buildCommentThread } from "./annotations";
import { restoreComposerFocus } from "./composer";
import { unanchoredThreads } from "./unanchored";
import { revealThreadLines } from "./expand";
import {
  handleLineNumberClick,
  handleDiffSelection,
  attachDiffSelectionHandlers,
} from "./selection";
import { approveCurrentFile, resetReview } from "./decisions";
import { blockersChip } from "./blockers";
import { isMarkdownPath, renderMarkdownFile } from "./mdfile";
import { renderMarkdown } from "./markdown";
import { cursorResync, cursorReset } from "./cursor";
import { hasGuide, renderOverview, currentGuideEntry } from "./guide";
import { updateProgress } from "./progress";
import {
  applySkimCollapse,
  isFileSkim,
  isFileSkimCollapsed,
  renderFileSkim,
  toggleFileSkim,
} from "./skim";

const SVG_NS = "http://www.w3.org/2000/svg";
// Cheap stable hash (FNV-1a, base36) for a string — used as @pierre cacheKeys for the old
// side (the new side reuses the server's contentHash). Same content → same key → cache hit.
function ckey(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// How many rendered file instances to keep warm (each holds DOM + @pierre's highlight cache).
const DIFF_CACHE_CAP = 6;
// A diff that would block longer than ~this many lines of tokenization shows the indicator.
const RENDER_INDICATOR_MIN_LINES = 400;

// Run render() but first paint a "Rendering…" indicator when the current file is big enough to
// block on tokenization — used by file switches and Reset (both can re-tokenize). The double
// rAF is required: the indicator must paint *before* the synchronous Shiki work begins.
// `forceIfBig` shows it for any big file (Reset re-tokenizes even when the diff key is cached);
// otherwise a fast cached re-open skips the badge to avoid an appear-then-vanish flash.
export function deferRender(forceIfBig = false) {
  const f = currentFile();
  const lc = (s?: string) => (s?.match(/\n/g)?.length ?? 0) + 1;
  const big =
    !!f && Math.max(lc(f.oldFile.contents), lc(f.newFile.contents)) > RENDER_INDICATOR_MIN_LINES;
  S.rendering = big && (forceIfBig || !D.diffCache.has(diffKey(!!S.preview)));
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void render().finally(() => {
        S.rendering = false;
      });
    }),
  );
}
// Identity of a rendered diff for the LRU cache: the current file + every option that changes
// what @pierre renders. selectFile uses this to tell if re-opening a file will be a fast cache
// hit (→ skip the "Rendering…" indicator). Reads currentFile(), so call after fileIndex is set.
export function diffKey(previewing: boolean): string {
  const f = currentFile();
  return JSON.stringify([
    f.path,
    previewing,
    currentSplittable() ? S.diffStyle : "unified",
    S.settings.unchangedLines === "expand",
    previewing ? "none" : S.settings.diffIndicators,
    S.settings.overflow,
    S.settings.hunkSeparators,
    S.settings.lineDiffType,
    S.settings.theme,
    !!currentGuideEntry(),
  ]);
}
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
    case "new":
      return "var(--green)";
    case "change":
      return "var(--cyan)";
    case "deleted":
      return "var(--red)";
    case "rename-pure":
    case "rename-changed":
      return "var(--amber)";
    default:
      return "var(--muted)";
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

// Subtle Split/Stacked segmented control that lives in the diff header (right of the filename).
// Kept low-contrast so it doesn't compete with the filename; clicking re-renders the diff,
// which rebuilds this control with the new active state.
function layoutToggle(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "ghdr-layout";
  wrap.setAttribute("data-tip", "Split / Stacked (v)");
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

// Icon-only "jump to this file in the local editor" button — file-scoped, so it lives in
// the file header rather than the app chrome (the top bar is for review-final actions).
function openEditorButton(): HTMLElement {
  const b = document.createElement("button");
  b.className = "ghdr-open";
  b.setAttribute("data-tip", "Open in editor (⇧E)");
  b.innerHTML = `<svg class="ic"><use href="#gly-open-editor"></use></svg>`;
  b.onclick = () => S.openInEditor?.();
  return b;
}

// @pierre renders the diff into a shadow root mounted on some descendant of #diff. Find it
// so we can measure rendered change rows for the overview ruler.
function findDiffShadow(): ShadowRoot | null {
  let shadow: ShadowRoot | null = null;
  $("diff")
    .querySelectorAll("*")
    .forEach((el) => {
      if ((el as HTMLElement).shadowRoot) shadow = (el as HTMLElement).shadowRoot;
    });
  return shadow;
}

export function clearOverviewRuler() {
  const o = $("ovr");
  o.classList.remove("show");
  o.replaceChildren();
}

// VSCode-style change overview: map every change row's position in the scrolled content to a
// tick in a fixed right-edge ruler, so changes are visible in one skim of the whole file.
// Only meaningful in "expand unchanged" mode (otherwise the diff is already compact).
function renderOverviewRuler() {
  const ruler = $("ovr");
  ruler.replaceChildren();
  const diff = $("diff");
  const shadow = findDiffShadow();
  const contentH = diff.scrollHeight;
  const rows = shadow
    ? Array.from(shadow.querySelectorAll<HTMLElement>("[data-line-type^='change-']"))
    : [];
  // Only a map for a scrollable file — if it fits without scrolling, the changes are already
  // all on screen and the ruler is redundant noise. (+1px tolerance for sub-pixel rounding.)
  if (!rows.length || !contentH || diff.scrollHeight <= diff.clientHeight + 1) {
    ruler.classList.remove("show");
    return;
  }
  const diffTop = diff.getBoundingClientRect().top;
  const scrollTop = diff.scrollTop;
  // @pierre tags both the gutter cell and the code cell of a line with data-line-type, so each
  // line matches twice — dedupe by side + rounded position, then sort top-to-bottom.
  const byPos = new Map<string, { side: "add" | "del"; top: number; bottom: number }>();
  for (const row of rows) {
    const side: "add" | "del" = (row.getAttribute("data-line-type") || "").includes("addition")
      ? "add"
      : "del";
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
    if (last && last.side === s.side && s.top - last.bottom <= s.bottom - s.top)
      last.bottom = s.bottom;
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

// Every progress-moving mutation (decision, approval, reset, reload) funnels through render,
// so it is the progress strip's single repaint point. It must run AFTER the render work has
// PAINTED, not merely after renderCenter returns: the transition clock starts at style-commit,
// and a file switch's first frame is spent tokenizing + laying out the new diff DOM — a bar
// started before (or during) that frame lands already-finished, i.e. no visible motion. The
// double rAF puts the width change on the first idle frame after that paint.
export async function render() {
  try {
    await renderCenter();
  } finally {
    // The diff DOM (and any inline composer inside it) was just rebuilt from scratch —
    // re-focus the open composer and restore its caret from the store, so typing survives
    // a render triggered mid-compose (e.g. accepting a change while replying).
    restoreComposerFocus();
    requestAnimationFrame(() => requestAnimationFrame(updateProgress));
  }
}

async function renderCenter() {
  clearOverviewRuler();
  const host = $("diff");
  // Leaving the diff view (overview / markdown): just detach the active instance — its cached
  // wrapper survives in D.diffCache (renderOverview/renderMarkdownFile overwrite #diff's
  // content, detaching the wrapper, which we re-mount on return). No cleanUp → cache preserved.
  const dropInstance = () => {
    D.instance = null;
  };
  // Guided review: the Overview page takes over the center until a file is selected.
  if (S.overviewOpen && hasGuide()) {
    cursorReset();
    dropInstance();
    D.lineMap = null;
    renderOverview();
    return;
  }
  const f = currentFile();
  const previewing = !!S.preview;
  // Markdown file in rendered mode: formatted preview with block-anchored comments,
  // instead of the @pierre/diffs view.
  if (
    !previewing &&
    S.state.mode === "file" &&
    isMarkdownPath(f.path) &&
    S.fileView === "rendered"
  ) {
    cursorReset();
    dropInstance();
    D.lineMap = null; // markdown anchors are block lines, not diff gutter numbers
    applyLayoutClasses();
    renderMarkdownFile();
    return;
  }
  // A skim-flagged file collapses its whole diff behind one expandable strip (guide-driven,
  // display only). Expanding drops back to the normal render below.
  if (!previewing && isFileSkimCollapsed(f.path)) {
    cursorReset();
    dropInstance();
    D.lineMap = null;
    applyLayoutClasses();
    renderFileSkim();
    return;
  }
  // @pierre renders nothing for a zero-change diff, so a whole-file view (a new file, or a
  // `preview` — an unchanged file the reviewer opened) is shown as the file's content on one
  // side. For preview we strip the add-tint + indicators below so it reads as plain text, not
  // an "added" file; it stays line-selectable for comments.
  const viewOnly =
    previewing ||
    (S.state.mode === "file" &&
      (f.oldFile.contents === "" || f.oldFile.contents === f.newFile.contents));
  // cacheKey lets @pierre reuse its highlighted token AST for the same content across renders
  // (and instances), so re-rendering after a decision — or re-opening a file — doesn't
  // re-tokenize. Keyed by content hash so it invalidates when the agent rewrites the file.
  const newF = { ...f.newFile, cacheKey: f.contentHash || ckey(f.newFile.contents) };
  let fd: FileDiffMetadata;
  if (viewOnly) {
    fd = D.parseDiffFromFile({ name: f.newFile.name, contents: "", cacheKey: "∅" }, newF);
    D.lineMap = null;
  } else {
    const oldF = { ...f.oldFile, cacheKey: ckey(f.oldFile.contents) };
    // Changes (identity, raw anchors) derive from the raw diff; the rendered diff is the
    // decision-replayed one, so display anchors must be re-read from it (resolutions
    // renumber lines — see linemap.ts).
    const rawFd = D.parseDiffFromFile(oldF, newF);
    ensureChangesFromFileDiff(rawFd);
    fd = replayDecisions(rawFd);
    syncDisplayAnchors(fd);
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
  // The per-file sign-off action in the diff header. Unfinished → one context button:
  // "Approve" (clean) or "Mark reviewed" (has a rejected hunk / open requested-change), which
  // accepts pending hunks, signs off, and advances. Finished → a state pill + Reset to undo.
  const headerActions = () => {
    const wrap = document.createElement("span");
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
      // The file-tree badge carries the approved / changes-requested state; the header just
      // offers a quiet Reset to undo the sign-off (plus the blockers chip when relevant).
      if (chip) wrap.appendChild(chip);
      wrap.appendChild(reset());
    } else {
      const objections = fileObjections(filePath);
      // Reset (clear in-progress hunk decisions) sits on the left; Approve is always far right.
      if (S.state.decisionFiles?.includes(filePath)) wrap.appendChild(reset());
      if (chip) wrap.appendChild(chip);
      const button = document.createElement("button");
      button.className = "diff-header-action" + (objections ? " warn" : "");
      button.innerHTML = `${objections ? "Mark Reviewed" : "Approve"} <kbd>⇧A</kbd>`;
      button.onclick = () => approveCurrentFile();
      wrap.appendChild(button);
    }
    return wrap;
  };
  // Our custom diff header (all changed-file modes): row 1 preserves @pierre's look —
  // change-type icon + filename + a subtle Split/Stacked toggle + counts + actions. With a
  // guide, row 2 (left-aligned) adds the category + AI guidance.
  const fileHeader = (file: FileDiffMetadata) => {
    const entry = currentGuideEntry();
    const wrap = document.createElement("div");
    wrap.className = "ghdr";
    wrap.style.setProperty("--ct-color", ctColor(file?.type));

    const row1 = document.createElement("div");
    row1.className = "ghdr-row1";
    row1.appendChild(changeIcon(file?.type));
    const name = document.createElement("span");
    name.className = "ghdr-file";
    name.textContent = currentFile().path;
    row1.appendChild(name);
    // Layout toggle right of the filename — only when Split actually applies (a two-sided diff).
    if (currentSplittable()) row1.appendChild(layoutToggle());
    row1.appendChild(openEditorButton());
    const grow = document.createElement("span");
    grow.className = "ghdr-grow";
    row1.appendChild(grow);
    let add = 0,
      del = 0;
    for (const h of file?.hunks ?? []) {
      add += h.additionLines ?? 0;
      del += h.deletionLines ?? 0;
    }
    const counts = document.createElement("span");
    counts.className = "ghdr-counts";
    counts.innerHTML = `<span class="a">+${add}</span><span class="d">−${del}</span>`;
    row1.appendChild(counts);
    const acts = headerActions();
    acts.className = "ghdr-actions";
    row1.appendChild(acts);
    wrap.appendChild(row1);

    if (entry) {
      // Group the AI guidance into a subtle card, set apart from the filename row + the code.
      // The prose fields render as markdown (renderMarkdown sanitizes) — the guidance is the
      // main reading content of a guided review, so identifiers/lists the agent writes survive.
      const guide = document.createElement("div");
      guide.className = "ghdr-guide";
      const chip = document.createElement("span");
      chip.className = "ghdr-cat" + (entry.flag ? " crit" : "");
      chip.textContent = entry.category;
      guide.appendChild(chip);
      const expl = document.createElement("div");
      expl.className = "ghdr-expl md";
      expl.innerHTML = renderMarkdown(entry.orientation);
      guide.appendChild(expl);
      // A flagged file gets its own readable callout within the card.
      if (entry.flag) {
        const flag = document.createElement("div");
        flag.className = "ghdr-flag";
        flag.innerHTML = `<svg class="ic"><use href="#gly-flag"></use></svg><div class="md">${renderMarkdown(entry.flag)}</div>`;
        guide.appendChild(flag);
      }
      wrap.appendChild(guide);
    }
    // Open threads whose anchor line no longer renders — shown as the diff's first row,
    // below the action bar, so they stay actionable (they block approval until resolved).
    const orphans = unanchoredThreads();
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
        box.appendChild(buildCommentThread(t));
        strip.appendChild(box);
      }
      wrap.appendChild(strip);
    }
    return wrap;
  };
  // Preview gets its own minimal header: a neutral file icon + path + a read-only tag — no
  // +/- counts, change-type icon, or guidance (all of which would mislabel an unchanged file
  // rendered as one-sided content). The Approve / Reset actions don't apply to a preview.
  const previewHeader = () => {
    const wrap = document.createElement("div");
    wrap.className = "ghdr";
    const row1 = document.createElement("div");
    row1.className = "ghdr-row1";
    row1.appendChild(changeIcon("file"));
    const name = document.createElement("span");
    name.className = "ghdr-file";
    name.textContent = currentFile().path;
    row1.appendChild(name);
    row1.appendChild(openEditorButton());
    const grow = document.createElement("span");
    grow.className = "ghdr-grow";
    row1.appendChild(grow);
    const tag = document.createElement("span");
    tag.className = "ghdr-readonly";
    tag.textContent = "Unchanged";
    row1.appendChild(tag);
    wrap.appendChild(row1);
    return wrap;
  };
  const diffStyle = currentSplittable() ? S.diffStyle : "unified";
  const expandUnchanged = S.settings.unchangedLines === "expand";
  const diffIndicators = previewing ? "none" : S.settings.diffIndicators;
  const opts = {
    theme: { dark: S.settings.theme, light: "pierre-light" },
    themeType: "dark" as const,
    diffStyle,
    diffIndicators,
    expandUnchanged,
    overflow: S.settings.overflow,
    hunkSeparators: S.settings.hunkSeparators,
    lineDiffType: S.settings.lineDiffType,
    enableLineSelection: true,
    renderAnnotation,
    onLineNumberClick: handleLineNumberClick,
    onLineSelectionStart: handleDiffSelection,
    onLineSelectionChange: handleDiffSelection,
    onLineSelected: handleDiffSelection,
    onLineSelectionEnd: handleDiffSelection,
    renderHeaderMetadata: headerActions,
    // @pierre's own post-render signal — fires once the diff rows are committed to the shadow
    // DOM (mount and every update). This is where skim collapse must run: on a COLD mount the
    // render() promise resolves before the rows are queryable, so the afterRender pass below
    // finds nothing; onPostRender fires when they exist. (afterRender still runs it too, for
    // the warm/cached path where rows are already present — both are idempotent.)
    onPostRender: (_node: HTMLElement, _inst: unknown, phase: string) => {
      if (phase !== "unmount") applySkimCollapse();
    },
    // @pierre reserves a right-side gutter via `scrollbar-gutter: stable` on the code grid
    // (for a vertical scrollbar it hides) — drop it so rows fill the full width. previewCSS
    // (empty unless previewing) neutralizes addition styling to context, in-shadow.
    unsafeCSS: "[data-code]{scrollbar-gutter:auto}" + previewCSS,
    // Preview → minimal read-only header; otherwise our custom file header (icon + filename +
    // layout toggle + counts + actions, plus guidance when a guide is attached).
    renderCustomHeader: previewing ? previewHeader : fileHeader,
  };
  // annotations() is our own AnnotationInput[]; the lib's DiffLineAnnotation<T> is a
  // discriminated union whose assignability check rejects our union-typed metadata,
  // though the runtime shape (side/lineNumber/metadata) is exactly what it reads.
  const anns = () => annotations() as DiffLineAnnotation<AnnotationMeta>[];
  const afterRender = () => {
    // Collapse skimmed blocks by hiding their rows — synchronous (before paint) so there's no
    // expand-then-collapse flash, and re-run every render so it survives @pierre re-renders.
    if (!previewing) applySkimCollapse();
    setTimeout(() => attachDiffSelectionHandlers(), 0);
    // Unfold collapsed regions hiding an open comment thread (once per rendered diff).
    if (!previewing) revealThreadLines(key);
    // The overview ruler only makes sense when the whole file is shown (expand mode) and
    // there are real changes (not a preview). Measure after a frame so rows have laid out.
    if (!previewing && expandUnchanged) requestAnimationFrame(() => renderOverviewRuler());
    // Repaint the keyboard line cursor once rows have laid out (init to first change on a fresh
    // file, else keep the same logical line).
    requestAnimationFrame(() => cursorResync());
  };
  // ── D: an LRU cache of rendered instances, each in its OWN wrapper element. Only the active
  // wrapper is mounted in #diff (others stay detached but referenced by the Map, so their DOM +
  // @pierre highlight cache survive). A cache hit — re-rendering the current file after a
  // decision, OR re-opening a file visited earlier — re-mounts its wrapper and re-renders into
  // it, which reuses the cached tokens (via the file cacheKeys above): no re-tokenization. Only
  // a genuinely new file/view tokenizes; the "Rendering…" indicator covers that one time.
  const key = diffKey(previewing);
  let entry = D.diffCache.get(key);
  if (entry)
    D.diffCache.delete(key); // re-insert below → most-recently-used
  else {
    const wrapper = document.createElement("div");
    wrapper.className = "diff-wrap";
    entry = { wrapper, inst: new D.FileDiff(opts) };
  }
  D.diffCache.set(key, entry);
  D.instance = entry.inst;
  // Mount only this file's wrapper (replaceChildren detaches the previously-active wrapper —
  // it lives on in the Map — and removes any overview/markdown content). Skip when it's already
  // the sole child (a same-file re-render) so we don't detach/reattach and reset scroll.
  const mountedNew = host.firstElementChild !== entry.wrapper || host.childElementCount !== 1;
  if (mountedNew) host.replaceChildren(entry.wrapper);
  entry.inst.setLineAnnotations?.(anns());
  await entry.inst.render({
    fileDiff: fd,
    containerWrapper: entry.wrapper,
    lineAnnotations: anns(),
  });
  // A genuine file/view switch starts at the top. #diff is the persistent scroll container, so
  // replaceChildren preserves its previous scrollTop — a tall next file would otherwise open
  // mid-scroll. A same-file re-render (a decision applied) skips this and keeps its scroll.
  if (mountedNew) host.scrollTop = 0;
  afterRender();
  // Evict least-recently-used instances beyond the cap.
  while (D.diffCache.size > DIFF_CACHE_CAP) {
    const oldestKey = D.diffCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const evicted = D.diffCache.get(oldestKey)!;
    D.diffCache.delete(oldestKey);
    if (evicted !== entry) {
      evicted.inst.cleanUp?.();
      evicted.wrapper.remove();
    }
  }
}
