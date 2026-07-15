import { S, $, esc } from "./store";
import { currentChanges, currentFile } from "./changes";
import { render } from "./render";
import { isFullySkimmed, isMovedPure } from "./skim-derive";
import type { ChangeState, GuideFile } from "./types";

// ── Skimmable review (issue 06) ──────────────────────────────────────────────
// The agent's guide can mark a whole file (GuideFile.skim) or specific change blocks
// (resolveSkim stamps ChangeState.skim on the server) as skimmable for a focused review.
// The desk collapses them by default but never removes them — display only, decisions
// untouched. Expanded/collapsed state is per-session (S.skimExpanded), never persisted.
//
// The block-collapse row hiding is imperative (applySkimCollapse) because @pierre exposes
// no primitive to fold a change block: its `collapsed` option is whole-file, expandHunk is
// for unchanged context, and annotations only ADD rows. A CSS-only hide was probed and
// rejected — split view pairs the two `<code>` columns through unlabeled, variable-count
// filler rows reachable only by grid position (a top-of-file block has no cell to anchor a
// sibling selector, and a partial skim can't hide "all fillers"). So we hide the block's rows
// by walking the shadow DOM (see applySkimCollapse) — the one place that reaches into it, so a
// future block-fold API replaces just this file. The strip itself is a normal annotation (a
// render input, so it survives re-renders in both views).

// The guide entry for a path (or null) — file-level skim reads off it.
function guideEntry(path: string): GuideFile | null {
  return S.state?.guide?.files.find((g) => g.path === path) ?? null;
}

export function isFileSkim(path: string): boolean {
  return !!guideEntry(path)?.skim;
}

export function fileSkimReason(path: string): string {
  return guideEntry(path)?.skimReason ?? "";
}

// ── Fully-skimmed files (issue 07) ───────────────────────────────────────────
// A file whose whole diff is skimmed (file-level flag, or every change block skim-stamped)
// leaves the reviewer's default flow: it gathers under the collapsed "Skimmed" tree/walkthrough/
// overview group and drops out of progress, review-complete, and the wrap/approve-advance seeks
// (navOrder). NOT auto-approved — approvedFiles is unchanged; the agent authored the skim and
// knows which files rode along. Opening one still works exactly like any file (its file/block
// skim strips render as issue 06 built), and explicitly approving it records sign-off as today.
//
// Derived per-render off current state, so it self-heals: a reload that re-resolves skims and
// drops a block's stamp (rewritten code) returns the file to the main flow automatically.
export function fileFullySkimmed(path: string): boolean {
  const blockSkims = (S.state?.changes ?? []).filter((c) => c.path === path).map((c) => !!c.skim);
  return isFullySkimmed(isFileSkim(path), blockSkims);
}

// ── Pure renames (issue 01) ──────────────────────────────────────────────────
// A file moved with identical content (distinct old/new paths, byte-equal old/new). It renders as
// a muted "renamed old → new · no changes" row and, like a fully-skimmed file, leaves the main
// review flow (folded into the Skimmed group, no progress/completion weight). Classified by CONTENT
// equality (see isMovedPure) rather than "zero change blocks", so a guide-merged rename-CHANGED
// file (issue 03, whose blocks are lazily client-derived) isn't misclassified as pure before it's
// opened. `movedFrom` returns the old path (or "").
// LEAN-STATE READER: reads the embedded oldFile/newFile.contents for byte-equality (issue 02
// moved the render path onto the per-file fetch, but this is a cross-file classification the
// tree/walkthrough/nav call over every file). It needs a rename-pure/OID stamp from the lean
// builder — issue 04 converts it and removes the embedded contents.
export function fileMovedPure(path: string): boolean {
  const f = S.state?.files?.find((x) => x.path === path);
  if (!f) return false;
  return isMovedPure(f.oldPath, f.newPath, f.oldFile.contents, f.newFile.contents);
}
export function movedFrom(path: string): string {
  const f = S.state?.files?.find((x) => x.path === path);
  return f && f.oldPath && f.newPath && f.oldPath !== f.newPath ? f.oldPath : "";
}

// A file that has left the reviewer's default flow: fully skimmed OR a pure rename. This is the
// single predicate the flow-control sites (tree/walkthrough grouping, nav order, progress, the
// approve-completion gate) check — so both kinds fold into the Skimmed group and drop out of the
// progress/completion math together. Skim-specific behavior (badges, collapse defaults, skim
// strips) keeps reading fileFullySkimmed directly.
export function fileOutOfFlow(path: string): boolean {
  return fileFullySkimmed(path) || fileMovedPure(path);
}

// The changed files that have left the main flow (fully skimmed or pure renames), in state.files
// order — the members of the collapsed group. Reads current state so it tracks reloads.
export function fullySkimmedPaths(): string[] {
  return (S.state?.files ?? []).map((f) => f.path).filter((p) => fileOutOfFlow(p));
}

// Per-session expand state for the collapsed "Skimmed" group, kept in S.skimExpanded (a sibling
// of the file:/block keys) under one sentinel so all three surfaces — tree, walkthrough, overview
// — share it. Not persisted: collapse is display-only and resets each session.
const SKIM_GROUP_KEY = "group:skimmed";
export function isSkimGroupExpanded(): boolean {
  return S.skimExpanded.has(SKIM_GROUP_KEY);
}
export function toggleSkimGroup() {
  if (S.skimExpanded.has(SKIM_GROUP_KEY)) S.skimExpanded.delete(SKIM_GROUP_KEY);
  else S.skimExpanded.add(SKIM_GROUP_KEY);
  // The tree/walkthrough re-derive reactively off S.skimExpanded; render() rebuilds the Overview
  // page when it's the one showing the group.
  render();
}

// Collapse defaults invert for fully-skimmed files: they're already folded away behind the
// Skimmed tree group, so opening one is a deliberate "show me" — its diff renders expanded
// (collapsing it again would just make the reviewer click twice). Partially-skimmed files sit
// in the main flow, so their skimmed blocks still collapse by default (that's the feature).
// S.skimExpanded therefore stores TOGGLES from the per-file default, not absolute "expanded":
// the toggle handlers stay add/delete, and state = default XOR toggled.
function skimToggled(key: string): boolean {
  return S.skimExpanded.has(key);
}

// A file whose diff is collapsed right now. A file-level skim flag implies fully-skimmed, so
// these files default to expanded — collapsed only when the reviewer re-folded via the header.
export function isFileSkimCollapsed(path: string): boolean {
  return isFileSkim(path) && skimToggled(`file:${path}`);
}

// Skimmable change blocks on the current file (server-stamped). Only pending ones collapse —
// a decided block is already folded/replayed out of the diff, so skim no longer applies.
export function skimChanges(): ChangeState[] {
  return currentChanges().filter((c) => c.skim && c.status === "pending");
}

export function isBlockSkimCollapsed(c: ChangeState): boolean {
  if (!c.skim || c.status !== "pending") return false;
  const defaultCollapsed = !fileFullySkimmed(c.path);
  return defaultCollapsed !== skimToggled(c.id);
}

// "N skimmed lines · reason" — N is the block's changed-line count (from its stableKey
// `side:line:dels:adds`), reason the agent's note (falls back to a bare "skimmed change").
export function skimStripLabel(c: ChangeState): string {
  const m = c.stableKey?.match(/:(\d+):(\d+)$/);
  const count = m ? Number(m[1]) + Number(m[2]) : 0;
  const lines = count ? `${count} skimmed line${count === 1 ? "" : "s"}` : "skimmed change";
  const reason = c.skim?.reason?.trim();
  return reason ? `${lines} · ${reason}` : lines;
}

export function toggleSkimBlock(id: string) {
  if (S.skimExpanded.has(id)) S.skimExpanded.delete(id);
  else S.skimExpanded.add(id);
  render();
}

export function toggleFileSkim(path: string) {
  const key = `file:${path}`;
  if (S.skimExpanded.has(key)) S.skimExpanded.delete(key);
  else S.skimExpanded.add(key);
  render();
}

// Render the collapsed placeholder for a skim-flagged file: the whole diff folds behind one
// expandable strip (count of changes + reason). render() calls this instead of the @pierre
// diff while the file is collapsed; expanding falls through to the normal render.
export function renderFileSkim() {
  const file = currentFile();
  const n = currentChanges().filter((c) => c.path === file.path).length;
  const reason = fileSkimReason(file.path);
  // Untracked/new files carry no change blocks (they render as full-file additions), so fall
  // back to a plain "skimmed" rather than a bare "0 changes".
  const count = n ? `${n} change${n === 1 ? "" : "s"} · ` : "";
  $("diff").innerHTML = `<div class="file-skim">
    <button class="file-skim-strip">
      <span class="skim-caret">▸</span>
      <span class="file-skim-name">${esc(file.path)}</span>
      <span class="file-skim-meta">${count}${reason ? `${esc(reason)} — ` : ""}skimmed</span>
      <span class="file-skim-expand">Expand</span>
    </button>
  </div>`;
  const strip = $("diff").querySelector(".file-skim-strip") as HTMLButtonElement | null;
  if (strip) strip.onclick = () => toggleFileSkim(file.path);
}

// The muted one-line row for a pure rename (issue 01): "renamed old → new · no changes". Unlike a
// skimmed file there's nothing to expand — the content is identical — so it's a static note, not a
// toggle. render() calls this instead of the @pierre diff when a moved-pure file is opened.
export function renderMovedPure() {
  const file = currentFile();
  const from = movedFrom(file.path);
  $("diff").innerHTML = `<div class="file-skim"><div class="file-skim-strip moved">
    <svg class="ic"><use href="#gly-arrow-right"></use></svg>
    <span>renamed <span class="file-skim-name">${esc(from)}</span> → <span class="file-skim-name">${esc(file.path)}</span></span>
    <span class="file-skim-meta">no changes</span>
  </div></div>`;
}

function diffShadow(): ShadowRoot | null {
  let shadow: ShadowRoot | null = null;
  document
    .getElementById("diff")
    ?.querySelectorAll("*")
    .forEach((el) => {
      if ((el as HTMLElement).shadowRoot) shadow = (el as HTMLElement).shadowRoot;
    });
  return shadow;
}

// Collapse every skimmed (not-expanded) block on the current file by hiding its rendered rows.
// Called synchronously in render()'s afterRender — before the browser paints — so there's no
// expand-then-collapse flash, and re-run every render so it survives @pierre's internal
// re-renders into a cached instance. Idempotent: prior hides (data-skim-hidden) are cleared
// first, since a cached instance reuses its row elements across renders.
//
// Purely structural (no geometry): each @pierre column is a <code> holding a [data-gutter] and a
// [data-content] grid track, 1:1 by index, and split renders two columns whose rows the grid
// aligns. The context lines bounding a block carry the same data-line-index in BOTH columns, so
// they pin the block's band on each side without measuring — we hide every cell strictly between
// them (the change rows on one side, the paired unlabeled filler rows on the other, plus the
// gutters). Measurement was tried and abandoned: rects aren't laid out yet in afterRender.
export function applySkimCollapse() {
  const blocks = currentChanges().filter((c) => isBlockSkimCollapsed(c));
  const shadow = diffShadow();
  if (!shadow) {
    // Blocks want collapsing but the diff shadow isn't up yet — a cold mount where render()
    // resolved before @pierre committed the rows. onPostRender re-invokes us when it is; if
    // this fires and NOTHING re-invokes, the blocks would stay visible (the first-render bug).
    if (blocks.length) console.debug("[skim] collapse skipped: diff shadow not ready");
    return;
  }
  for (const el of shadow.querySelectorAll<HTMLElement>("[data-skim-hidden]")) {
    el.style.display = "";
    el.removeAttribute("data-skim-hidden");
  }
  if (!blocks.length) return;
  const columns = Array.from(shadow.querySelectorAll("pre[data-diff] code[data-code]")).map(
    (code) => ({
      content: code.querySelector<HTMLElement>("[data-content]"),
      gutter: code.querySelector<HTMLElement>("[data-gutter]"),
    }),
  );
  const isContext = (el?: Element | null) =>
    !!el && (el.getAttribute("data-line-type") ?? "").startsWith("context");
  let hidden = 0;
  const hide = (el?: HTMLElement) => {
    if (!el) return;
    el.style.display = "none";
    el.setAttribute("data-skim-hidden", "1");
    hidden++;
  };
  for (const block of blocks) {
    const type = block.side === "additions" ? "change-addition" : "change-deletion";
    const lo = block.displayLineNumber ?? block.lineNumber;
    const hi = block.displayEndLine ?? block.endLine ?? lo;
    // Anchor: a change code cell of this block (data-line is its display line on its side).
    let anchor: HTMLElement | undefined;
    for (const col of columns) {
      anchor = Array.from(
        col.content?.querySelectorAll<HTMLElement>(`[data-line-type="${type}"][data-line]`) ?? [],
      ).find((el) => {
        const n = Number(el.getAttribute("data-line"));
        return n >= lo && n <= hi;
      });
      if (anchor) break;
    }
    if (!anchor?.parentElement) continue;
    // The context cells bracketing the block in the anchor's column (null at a hunk edge).
    const sibs = Array.from(anchor.parentElement.children) as HTMLElement[];
    const at = sibs.indexOf(anchor);
    let lower = at;
    while (lower > 0 && !isContext(sibs[lower - 1])) lower--;
    let upper = at;
    while (upper < sibs.length - 1 && !isContext(sibs[upper + 1])) upper++;
    const beforeLi = lower > 0 ? sibs[lower - 1]!.getAttribute("data-line-index") : null;
    const afterLi =
      upper < sibs.length - 1 ? sibs[upper + 1]!.getAttribute("data-line-index") : null;
    // In every column's gutter AND content track, hide the rows strictly between the two
    // bounding context lines (matched by their shared data-line-index): the block's change
    // rows on one side and, in split, the paired filler rows on the other. Each track is
    // located independently so no gutter/content index alignment is assumed. The annotation
    // rows ([data-line-annotation]) are kept — that's where the skim strip lives.
    for (const col of columns) {
      for (const track of [col.gutter, col.content]) {
        if (!track) continue;
        const kids = Array.from(track.children) as HTMLElement[];
        const idxOf = (li: string) =>
          kids.findIndex((k) => k.getAttribute("data-line-index") === li);
        const start = beforeLi ? idxOf(beforeLi) : -1;
        const end = afterLi ? idxOf(afterLi) : kids.length;
        // A bound the diff placed only on the other side isn't in this track — skip rather
        // than risk hiding from the wrong edge.
        if ((beforeLi && start === -1) || (afterLi && end === -1)) continue;
        for (let j = start + 1; j < end; j++) {
          if (!kids[j]!.hasAttribute("data-line-annotation")) hide(kids[j]);
        }
      }
    }
  }
  // Rows to collapse but none hidden = the anchor/context lookup missed (shape drift in
  // @pierre's DOM). Surface it instead of silently leaving the block expanded.
  if (!hidden) console.debug(`[skim] collapse hid nothing for ${blocks.length} block(s)`);
}
