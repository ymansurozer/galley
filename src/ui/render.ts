import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import { S, D, $, esc } from "./store";
import { cur, loadCurrentContents, peekContents } from "./contents";
import {
  currentFile,
  currentSplittable,
  ensureChangesFromFileDiff,
  replayDecisions,
  syncDisplayAnchors,
} from "./changes";
import type { AnnotationMeta } from "./types";
import { applyActiveRow, applyLayoutClasses } from "./tree";
import { annotations, renderAnnotation } from "./annotations";
import { restoreComposerFocus } from "./composer";
import { renderUiLane } from "./uilane";
import { revealThreadLines } from "./expand";
import {
  handleLineNumberClick,
  handleDiffSelection,
  attachDiffSelectionHandlers,
} from "./selection";
import { isMarkdownPath, renderMarkdownFile } from "./mdfile";
import { cursorResync, cursorReset, invalidateCursorRows } from "./cursor";
import { hasGuide, renderOverview } from "./guide";
import { updateProgress } from "./progress";
import {
  applySkimCollapse,
  fileMovedPure,
  isFileSkimCollapsed,
  renderFileSkim,
  renderMovedPure,
} from "./skim";
import { isOversizedPlaceholder, renderOversizedCard } from "./oversized";
import { applyHunkFolds } from "./fold";
import { diffShadowRoot } from "./diff-dom";
import { fileLead, renderFileBar } from "./filebar";
import { guideCard, trackGuideCard } from "./guidecard";
import { codeScheme } from "./shiki-curated";

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
// Cheap now that the state itself is lean (issue 04 removed embedded contents), so we keep ~30
// files warm — returning to any recently viewed file re-mounts its cached wrapper without
// re-tokenizing, matching the per-file contents LRU's cap (contents.ts).
const DIFF_CACHE_CAP = 30;
// A diff that would block longer than ~this many lines of tokenization shows the indicator.
const RENDER_INDICATOR_MIN_LINES = 400;

// Run render() but first paint a "Rendering…" indicator when the current file is big enough to
// block on tokenization — used by file switches and Reset (both can re-tokenize). The double
// rAF is required: the indicator must paint *before* the synchronous Shiki work begins.
// `forceIfBig` shows it for any big file (Reset re-tokenizes even when the diff key is cached);
// otherwise a fast cached re-open skips the badge to avoid an appear-then-vanish flash.
// Resolves once that render has finished.
export function deferRender(forceIfBig = false): Promise<void> {
  const f = currentFile();
  // Count newlines with a loop rather than s.match(/\n/g): match allocates a full array of every
  // newline over what can be a multi-MB file, on every file switch — the count is all we need.
  const lc = (s?: string) => {
    if (!s) return 1;
    let n = 1;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  };
  // Contents now arrive via a per-file fetch (see contents.ts). When they aren't warm yet the
  // upcoming render() gates on that fetch, so show the indicator; when they are, decide on size
  // as before. peekContents never fetches, so this stays synchronous.
  const warm = f ? peekContents(f) : null;
  const big =
    !!warm && Math.max(lc(warm.oldContents), lc(warm.newContents)) > RENDER_INDICATOR_MIN_LINES;
  S.rendering = !!f && (!warm || (big && (forceIfBig || !D.diffCache.has(diffKey(!!S.preview)))));
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void render().finally(() => {
          S.rendering = false;
          resolve();
        });
      }),
    ),
  );
}
// Identity of a rendered diff for the LRU cache: the current step (file + part) + every option
// that changes what @pierre renders. selectFile uses this to tell if re-opening a file will be a
// fast cache hit (→ skip the "Rendering…" indicator). Reads currentFile(), so call after fileIndex
// is set. Each part of a split file is its own entry: a part view renders only its own blocks.
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
    previewing ? null : (S.stepPart ?? null),
  ]);
}
export function clearOverviewRuler() {
  const o = $("ovr");
  o.classList.remove("show");
  o.replaceChildren();
}

// Shown when a file's contents can't be fetched (git object gone after a rebase, transport
// failure). Names the file and points at a desk reload; the rest of the desk stays live, so the
// reviewer can navigate to other files while this one is unresolvable.
function renderContentsError(path: string) {
  $("diff").innerHTML = `<div class="contents-error">
    <svg class="ic"><use href="#gly-warn"></use></svg>
    <span>couldn't load <span class="contents-error-path">${esc(path)}</span></span>
    <span class="contents-error-meta">reload the desk to retry</span>
  </div>`;
}

// VSCode-style change overview: map every change row's position in the scrolled content to a
// tick in a fixed right-edge ruler, so changes are visible in one skim of the whole file.
// Only meaningful in "expand unchanged" mode (otherwise the diff is already compact).
function renderOverviewRuler() {
  const ruler = $("ovr");
  ruler.replaceChildren();
  const diff = $("diff");
  const shadow = diffShadowRoot();
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
    // The UI lane draws from the same state (a reload or reset swaps it wholesale).
    renderUiLane();
    // Re-apply the sidebar highlight an rAF later — after Alpine's microtask flush, so rows
    // that were just re-keyed by a reactive change carry it again (see applyActiveRow).
    requestAnimationFrame(applyActiveRow);
    requestAnimationFrame(() => requestAnimationFrame(updateProgress));
  }
}

async function renderCenter() {
  clearOverviewRuler();
  const host = $("diff");
  // The diff area (#diff, the ruler and the Rendering cover) is the code canvas: it takes the code
  // theme's scheme, not the appearance (tokens.css). The Overview and rendered markdown are pages
  // with no code theme, so they leave it to the appearance.
  // #diff's parent is always .diff-area (index.html).
  const area = host.parentElement!;
  area.dataset.scheme = codeScheme(S.settings.theme);
  const page = () => delete area.dataset.scheme;
  // Leaving the diff view (overview / markdown): just detach the active instance — its cached
  // wrapper survives in D.diffCache (renderOverview/renderMarkdownFile overwrite #diff's
  // content, detaching the wrapper, which we re-mount on return). No cleanUp → cache preserved.
  const dropInstance = () => {
    D.instance = null;
  };
  // Every file view opens under the file's bar and, when the guide has an entry for the file, its
  // guide card; a view that wrote #diff wholesale gets both back on top. (The Overview and the
  // empty centre aren't a file, so they have neither.) The oversized card and the contents error
  // have no rows a blocker could jump to — reaching one would mean silently loading the diff the
  // card holds back, or the contents that just failed — so their bars carry no blockers chip.
  const withBar = (jumpable = true) => {
    const card = guideCard();
    host.prepend(renderFileBar(undefined, jumpable), ...(card ? [card] : []));
    trackGuideCard(card);
  };
  // Guided review: the Overview page takes over the center until a file is selected.
  if (S.overviewOpen && hasGuide()) {
    cursorReset();
    dropInstance();
    D.lineMap = null;
    page();
    renderOverview();
    trackGuideCard(null);
    return;
  }
  const f = currentFile();
  const previewing = !!S.preview;
  // No file at all: the diff emptied (a reload after the agent's edits left a clean tree), or a
  // UI-only desk, whose centre is the app. Nothing to draw.
  if (!f) {
    cursorReset();
    dropInstance();
    D.lineMap = null;
    applyLayoutClasses();
    host.replaceChildren();
    trackGuideCard(null);
    return;
  }
  // An oversized file (server-stamped) paints a verdict-capable summary card instead of its diff —
  // BEFORE the contents fetch below, so opening it never blocks on a multi-MB tokenization pass.
  // "Load diff anyway" clears this (S.loadedOversized) and falls through to the normal render.
  if (!previewing && isOversizedPlaceholder(f)) {
    cursorReset();
    dropInstance();
    D.lineMap = null;
    applyLayoutClasses();
    renderOversizedCard();
    withBar(false);
    return;
  }
  // Pull this file's contents from the per-file endpoint before rendering anything that reads
  // them (the markdown/moved/skim/diff branches all follow). A "stale" result means the reviewer
  // switched files mid-fetch — abort silently, a newer render() is already handling the current
  // file. An "error" means the contents can't be fetched (git object gone after a rebase); show
  // an error card naming the file so navigation to other files keeps working.
  const contentsStatus = await loadCurrentContents();
  if (contentsStatus === "stale") return;
  if (contentsStatus === "error") {
    cursorReset();
    dropInstance();
    D.lineMap = null;
    applyLayoutClasses();
    renderContentsError(f.path);
    withBar(false);
    return;
  }
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
    page();
    renderMarkdownFile();
    withBar();
    return;
  }
  // A pure rename (identical content, distinct paths) has no diff to show — render the muted
  // "renamed old → new · no changes" row instead of an empty @pierre diff.
  if (!previewing && fileMovedPure(f.path)) {
    cursorReset();
    dropInstance();
    D.lineMap = null;
    applyLayoutClasses();
    renderMovedPure();
    withBar();
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
    withBar();
    return;
  }
  // @pierre renders nothing for a zero-change diff, so a whole-file view (a new file, or a
  // `preview` — an unchanged file the reviewer opened) is shown as the file's content on one
  // side. For preview we strip the add-tint + indicators below so it reads as plain text, not
  // an "added" file; it stays line-selectable for comments.
  const viewOnly =
    previewing ||
    (S.state.mode === "file" && (cur.oldContents === "" || cur.oldContents === cur.newContents));
  // Old/new display names carry rename info to @pierre (distinct paths → rename coloring); they're
  // metadata (oldPath/newPath), not contents, so they stay independent of the fetched bytes.
  const oldName = f.oldPath ?? f.path;
  const newName = f.newPath ?? f.path;
  // cacheKey lets @pierre reuse its highlighted token AST for the same content across renders
  // (and instances), so re-rendering after a decision — or re-opening a file — doesn't
  // re-tokenize. Keyed by content hash so it invalidates when the agent rewrites the file.
  const newF = {
    name: newName,
    contents: cur.newContents,
    cacheKey: f.contentHash || ckey(cur.newContents),
  };
  let fd: FileDiffMetadata;
  let rawFd: FileDiffMetadata | null = null;
  if (viewOnly) {
    fd = D.parseDiffFromFile({ name: newName, contents: "", cacheKey: "∅" }, newF);
    D.lineMap = null;
  } else {
    const oldF = { name: oldName, contents: cur.oldContents, cacheKey: ckey(cur.oldContents) };
    // Changes (identity, raw anchors) derive from the raw diff; the rendered diff is the
    // decision-replayed one, so display anchors must be re-read from it (resolutions
    // renumber lines — see linemap.ts).
    rawFd = D.parseDiffFromFile(oldF, newF);
    ensureChangesFromFileDiff(rawFd);
    fd = replayDecisions(rawFd);
    syncDisplayAnchors(fd);
  }
  // Preview reads as a plain file: remap @pierre's addition styling to its CONTEXT (unchanged)
  // styling — row tint, gutter cell bg, and gutter number color all to the neutral context
  // values — so a one-sided render of an unchanged file isn't all-green. These must be set
  // INSIDE @pierre's shadow (via unsafeCSS below): the context vars they reference only exist
  // there, so a host-level override referencing them is invalid and silently reverts.
  // @pierre's light mixes leave a dark theme's hunk separators (and their expand buttons) at the
  // background's own lightness, so they'd vanish: lift them 15% toward white, as its dark mixes do.
  const separatorCSS =
    codeScheme(S.settings.theme) === "dark"
      ? ":host{--diffs-bg-separator:color-mix(in lab,var(--diffs-bg) 85%,#fff)}"
      : "";
  const previewCSS = previewing
    ? "[data-code]{--diffs-bg-addition-override:var(--diffs-bg-context);--diffs-bg-addition-emphasis-override:var(--diffs-bg-context);--diffs-bg-addition-number-override:var(--diffs-bg-context-gutter);--diffs-fg-number-addition-override:var(--diffs-fg-number)}"
    : "";
  D.fileDiff = fd;
  D.rawFileDiff = rawFd;
  applyLayoutClasses();
  const diffStyle = currentSplittable() ? S.diffStyle : "unified";
  const expandUnchanged = S.settings.unchangedLines === "expand";
  const diffIndicators = previewing ? "none" : S.settings.diffIndicators;
  const opts = {
    // The code theme is the user's pick regardless of appearance (the settings dropdown groups
    // dark and light themes; mixing is allowed). Both slots get it, so themeType only picks
    // which of @pierre's own mixes tint the rows: always its light ones. Its dark ones tint a
    // dark theme's changed lines 20% (against 12%) and their words at 20% (against 15%), which
    // reads pale on a dark canvas; the light ones are a light theme's own. separatorCSS keeps a
    // dark theme's hunk separators where the dark mixes put them.
    theme: { dark: S.settings.theme, light: S.settings.theme },
    themeType: "light" as const,
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
    // The file's header is ours (filebar.ts), mounted above this wrapper as #diff's sticky bar.
    disableFileHeader: true,
    // @pierre's own post-render signal — fires once the diff rows are committed to the shadow
    // DOM (mount and every update). This is where skim collapse must run: on a COLD mount the
    // render() promise resolves before the rows are queryable, so the afterRender pass below
    // finds nothing; onPostRender fires when they exist. (afterRender still runs it too, for
    // the warm/cached path where rows are already present — both are idempotent.)
    onPostRender: (_node: HTMLElement, _inst: unknown, phase: string) => {
      // The rendered rows just changed (mount, update, or @pierre's own expandHunk rerender —
      // which never routes through our render()), so the cursor's cached row list is stale.
      invalidateCursorRows();
      if (phase !== "unmount") {
        applySkimCollapse();
        applyHunkFolds();
      }
    },
    // @pierre reserves a right-side gutter via `scrollbar-gutter: stable` on the code grid
    // (for a vertical scrollbar it hides) — drop it so rows fill the full width. The rows' scroll
    // margin keeps a scrolled-to line clear of the sticky file bar (diff.css does the same for the
    // light DOM and defines --jump-top, which inherits into the shadow). [data-flash] is a
    // jumped-to line (cursor.ts flashRow): an orange wash over its own tint that fades, like a
    // thread's flash off the rows (decisions.css). An annotation row keeps its own ground when
    // its line is selected or hovered: the selection tints the code line alone, so a card reads
    // the same against the row behind it either way. previewCSS (empty unless previewing)
    // neutralizes addition styling to context, in-shadow.
    unsafeCSS:
      "[data-code]{scrollbar-gutter:auto}" +
      "[data-line-annotation],[data-gutter-buffer=annotation]{--diffs-line-bg:var(--diffs-annotation-bg)}" +
      "[data-line-type]{scroll-margin-top:var(--jump-top,0px)}" +
      "[data-flash]{animation:galley-flash 1.2s ease-out}" +
      "@keyframes galley-flash{0%{box-shadow:inset 0 0 0 100vmax color-mix(in srgb,var(--orange) 25%,transparent)}}" +
      separatorCSS +
      previewCSS,
  };
  // annotations() is our own AnnotationInput[]; the lib's DiffLineAnnotation<T> is a
  // discriminated union whose assignability check rejects our union-typed metadata,
  // though the runtime shape (side/lineNumber/metadata) is exactly what it reads.
  const anns = () => annotations() as DiffLineAnnotation<AnnotationMeta>[];
  const afterRender = () => {
    // Collapse skimmed blocks and fold other parts' hunks by hiding their rows — synchronous
    // (before paint) so there's no expand-then-collapse flash, and re-run every render so it
    // survives @pierre re-renders.
    if (!previewing) {
      applySkimCollapse();
      applyHunkFolds();
    }
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
  // Mount this file's wrapper under its bar + guide card + lead (replaceChildren detaches the
  // previously-active wrapper — it lives on in the Map — and removes any overview/markdown
  // content). A same-file re-render leaves the wrapper attached and swaps only what sits above it,
  // so the diff isn't detached/reattached and the scroll stays put. A preview has no guide card or
  // lead: it isn't in the review.
  const bar = renderFileBar(fd);
  const above = [guideCard(), previewing ? null : fileLead()].filter((x) => x !== null);
  const mountedNew = entry.wrapper.parentNode !== host;
  if (mountedNew) host.replaceChildren(bar, ...above, entry.wrapper);
  else {
    for (const el of Array.from(host.children)) if (el !== bar && el !== entry.wrapper) el.remove();
    entry.wrapper.before(...above);
  }
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
  trackGuideCard(host.querySelector<HTMLElement>(":scope > .guide-card"));
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
