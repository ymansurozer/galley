import { S, D, $, toast, persist } from "./store";
import type { ChangeState, Side } from "./types";
import { currentChanges, fromDisplayLine } from "./changes";
import { acceptChange } from "./decisions";
import { changeSpan, pendingChangeAt, spanHolds } from "./decisions-derive";
import { openCommentComposer } from "./selection";
import { render } from "./render";
import { diffShadowRoot } from "./diff-dom";
import { type Row, mergeRows, rowMatches as matches } from "./cursor-rows";
import { openThreadAt, placeThreadMarks } from "./rests";

// ── The diff line cursor ─────────────────────────────────────────────────────
// Keyboard review needs a "current line" the diff doesn't otherwise have. We keep it as a
// logical {side, line} (stable across re-renders, since line numbers are) and resolve it to a
// rendered row on demand. The highlight is @pierre's own line selection (setSelectedLines with
// notify:false — paints without firing the selection callbacks, so no composer popup), so
// pointer and keyboard share ONE highlight: a click seeds the cursor (cursorSyncTo) and the
// arrows move the same selection from there.

let cur: { side: Side; line: number } | null = null;

// rows() runs a full-file getBoundingClientRect sweep to build its Row[]; it's called per keypress
// (cursorMoveLine/Hunk, landAt, ensureCursor) and after every render (cursorResync), so on a large
// expanded file each arrow press forced a synchronous whole-file layout. The list is derived purely
// from DOM structure and content-relative tops (the stored `top` is relative to the scrolled
// content, not the viewport), so it's stable across scroll — only a re-render, or a resize
// reflowing line heights, actually changes it. So we cache it and rebuild only on those events:
// invalidateCursorRows() is wired to @pierre's onPostRender (render.ts — mount / update / unmount,
// which covers our render() AND @pierre's own expandHunk rerenders) and to #diff's own resizes
// (main.ts: a window resize, or a sidebar drag that rewraps lines without one).
// Scroll deliberately does NOT invalidate: scrolling never changes the list, and arrow navigation
// (which scrolls via scrollIntoView) stays on cache hits instead of re-sweeping the file per press.
let cached: Row[] | null = null;

export function invalidateCursorRows() {
  cached = null;
  // The rows just moved (a render, an expansion, a resize, a card opening): the rail and the
  // thread marks follow once they've laid out.
  if (!followQueued) {
    followQueued = true;
    requestAnimationFrame(() => {
      followQueued = false;
      if (rail?.isConnected) markCursorChange();
      placeThreadMarks();
    });
  }
}

// The row showing a display line (either column of a context row), for the thread marks.
export const rowAt = (side: Side, line: number): Row | undefined =>
  rows().find((r) => matches(r, side, line));

// The cursor's row element, which an opening card keeps in place on screen (rests.ts).
export const cursorRowEl = (): HTMLElement | null =>
  // `cur` is checked just before the find, which runs synchronously.
  (cur && rows().find((r) => matches(r, cur!.side, cur!.line))?.el) ?? null;

// Every navigable code line in visual (top-to-bottom) order. @pierre tags each line's gutter with
// a [data-line-number-content] span inside a [data-line-type] cell, within a [data-additions] /
// [data-deletions] column (split) — that gives us side + number + row element. Context lines show
// in both split columns at the same y; mergeRows() folds those twins into one row.
function rows(): Row[] {
  if (cached) return cached;
  const sh = diffShadowRoot();
  if (!sh) return []; // shadow not mounted yet — don't cache, retry on the next call
  const diff = $("diff");
  const diffTop = diff.getBoundingClientRect().top;
  const scrollTop = diff.scrollTop;
  const out: Row[] = [];
  sh.querySelectorAll<HTMLElement>("[data-line-number-content]").forEach((span) => {
    const cell = span.closest<HTMLElement>("[data-line-type]");
    if (!cell) return;
    const type = cell.getAttribute("data-line-type") || "";
    const col = span.closest<HTMLElement>("[data-additions],[data-deletions]");
    const side: Side = type.includes("deletion")
      ? "deletions"
      : type.includes("addition")
        ? "additions"
        : col?.hasAttribute("data-deletions")
          ? "deletions"
          : "additions";
    const line = parseInt(span.textContent || "", 10);
    if (!Number.isFinite(line)) return;
    const r = cell.getBoundingClientRect();
    if (!r.height) return;
    out.push({
      el: cell,
      side,
      line,
      top: r.top - diffTop + scrollTop,
      height: r.height,
      change: type.startsWith("change-"),
    });
  });
  cached = mergeRows(out);
  return cached;
}

function indexOfCur(list: Row[]): number {
  return cur ? list.findIndex((r) => matches(r, cur!.side, cur!.line)) : -1;
}

// Paint the cursor as @pierre's native line selection. notify:false keeps the selection
// callbacks (which open the comment composer) from firing on keyboard movement.
function paint(r: Row) {
  D.instance?.setSelectedLines({ start: r.line, end: r.line, side: r.side }, { notify: false });
}
function hide() {
  D.instance?.setSelectedLines(null, { notify: false });
}

function landOn(r: Row | undefined, scroll = true) {
  if (!r) return;
  cur = { side: r.side, line: r.line };
  paint(r);
  if (scroll) r.el.scrollIntoView({ block: "nearest" });
  markCursorChange();
  // A thread on the line opens: on either column of a context row.
  if (!openThreadAt(r.side, r.line) && r.alt) openThreadAt(r.alt.side, r.alt.line);
}

// Adopt a pointer-made selection as the cursor position, so the arrows continue from the
// clicked line instead of restarting at the first change. @pierre already painted the
// selection itself — no repaint, no scroll.
export function cursorSyncTo(side: Side, line: number) {
  cur = { side, line };
  markCursorChange();
  openThreadAt(side, line);
}

// Re-resolve the cursor after a render: keep the same logical line, just repaint. The cursor
// is hidden until the reviewer navigates or clicks (no auto-highlighted first line), so when
// there's no active cursor we clear the selection instead.
export function cursorResync() {
  markCursorChange();
  if (!cur) {
    hide();
    return;
  }
  const r = rows().find((x) => matches(x, cur!.side, cur!.line));
  if (r) paint(r);
  else hide();
}

// Drop the cursor (file switch, overview, markdown view) — clears the highlight entirely.
export function cursorReset() {
  cur = null;
  hide();
  markCursorChange();
}

export function cursorSelection() {
  return cur ? { side: cur.side, lineNumber: cur.line } : null;
}

// Reveal the cursor on first use: land on the first change (else the first line). Returns the row.
function ensureCursor(): Row | undefined {
  if (cur) return rows().find((x) => matches(x, cur!.side, cur!.line));
  const list = rows();
  if (!list.length) return undefined;
  const r = list.find((x) => x.change) ?? list[0];
  landOn(r, false);
  return r;
}

// Flash a jumped-to line so the eye finds it: its gutter and code cells, which share a
// data-line-index within the column (`<code>`) the row was found in. The [data-flash] animation
// lives in render.ts's in-shadow CSS. The marker comes off when the animation ends, so a later
// re-render that reuses the cells doesn't replay it.
function flashRow(r: Row) {
  const li = r.el.getAttribute("data-line-index");
  const col = r.el.closest("code");
  if (!li || !col) return;
  for (const el of col.querySelectorAll<HTMLElement>(`[data-line-index="${li}"]`)) {
    el.removeAttribute("data-flash");
    void el.offsetWidth; // restart the animation
    el.setAttribute("data-flash", "");
    el.addEventListener("animationend", () => el.removeAttribute("data-flash"), { once: true });
  }
}

// Land the cursor on a specific rendered line (display space) and center it. Context rows merge
// to a single entry (additions primary, deletions twin in `alt`), so fall back to a line-only
// match before giving up.
function landAt(side: Side, line: number): boolean {
  const list = rows();
  const r = list.find((x) => matches(x, side, line)) ?? list.find((x) => x.line === line);
  if (!r) return false;
  cur = { side: r.side, line: r.line };
  paint(r);
  r.el.scrollIntoView({ block: "center" });
  markCursorChange();
  if (!openThreadAt(side, line)) openThreadAt(r.side, r.line);
  return true;
}

// Flash the cursor's line a frame after a jump lands. A jump that just opened the file lands while
// @pierre may still be re-rendering its rows (unfolding a thread's region swaps the cells), so the
// flash goes on whichever cells hold the line once that settles — re-measured if the cached ones
// left the page.
function flashCursorLine() {
  requestAnimationFrame(() => {
    const at = cur;
    if (!at) return;
    let r = rows().find((x) => matches(x, at.side, at.line));
    if (r && !r.el.isConnected) {
      invalidateCursorRows();
      r = rows().find((x) => matches(x, at.side, at.line));
    }
    if (r) flashRow(r);
  });
}

// Jump used by the blockers list and the change-request walk: land and flash. Retries once across
// two frames so a just-triggered collapsed-region expansion (which rerenders) has laid out its rows.
export function cursorJumpTo(side: Side, line: number) {
  if (landAt(side, line)) flashCursorLine();
  else
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (landAt(side, line)) flashCursorLine();
      }),
    );
}

// Whether this DISPLAY line has a rendered row: exactly, not landAt's line-only fallback, whose
// same-numbered row on the other side can be another line while this one sits folded away.
export function isRendered(side: Side, line: number): boolean {
  return rows().some((r) => matches(r, side, line));
}

// Whether the cursor sits on this DISPLAY line's row, in either column of a context row.
export function cursorOn(side: Side, line: number): boolean {
  const at = cur;
  const r = at && rows().find((x) => matches(x, at.side, at.line));
  return !!r && matches(r, side, line);
}

// ── Go to line ───────────────────────────────────────────────────────────────
// Typing digits in the diff accumulates a line number (shown as the goline pill); ↵ or a short
// idle pause commits the jump, Esc cancels. Commit only moves the cursor — the existing ↵ /
// ⇧Y / r bindings take over from the landed line, so the jump composes with every verb.

let golineTimer: ReturnType<typeof setTimeout> | undefined;

export function golineActive(): boolean {
  return !!S.golineBuffer;
}

export function golineDigit(d: string) {
  if (!S.golineBuffer && d === "0") return; // a leading 0 can't start a real line number
  S.golineBuffer += d;
  clearTimeout(golineTimer);
  golineTimer = setTimeout(golineCommit, 800);
}

export function golineCancel() {
  S.golineBuffer = "";
  clearTimeout(golineTimer);
}

export function golineCommit() {
  const n = parseInt(S.golineBuffer, 10);
  golineCancel();
  if (!Number.isFinite(n)) return;
  // Prefer the additions/new side — the number a reviewer reads off the gutter. No retry:
  // goline never triggers an expansion, so a miss means the line isn't rendered.
  if (!landAt("additions", n)) toast(`Line ${n} isn't visible in this diff`);
}

export function cursorMoveLine(dir: 1 | -1) {
  const list = rows();
  if (!list.length) return;
  if (!cur) {
    ensureCursor();
    return;
  } // first press just reveals the cursor
  const i = indexOfCur(list);
  if (i < 0) {
    landOn(dir === 1 ? list[0] : list[list.length - 1]);
    return;
  }
  landOn(list[Math.max(0, Math.min(list.length - 1, i + dir))]);
}

// Jump to the first line of the next/previous change run (a contiguous block of change rows).
export function cursorMoveHunk(dir: 1 | -1) {
  const list = rows();
  if (!list.length) return;
  if (!cur) {
    ensureCursor();
    return;
  } // first press just reveals the cursor (on the first change)
  const isStart = (j: number) => list[j].change && (j === 0 || !list[j - 1].change);
  const i = indexOfCur(list);
  for (let j = i + dir; j >= 0 && j < list.length; j += dir) {
    if (isStart(j)) {
      landOn(list[j]);
      return;
    }
  }
  toast(dir === 1 ? "No more changes" : "No previous changes");
}

// ── The change at the cursor ─────────────────────────────────────────────────
// The pending change whose rows hold the cursor line, on either side: ⇧Y / ⇧N act on it. The cursor
// reads rendered gutter numbers (display space), so the rows come from the rendered diff.
function cursorChange() {
  if (!cur || !D.fileDiff) return null;
  return pendingChangeAt(currentChanges(), D.fileDiff, cur.side, cur.line);
}

// The change the cursor marks, for a control drawn mid-render (annotations.ts) before the
// post-render resync marks it. None with per-change verdicts off: ⇧Y / ⇧N are off then too.
export function cursorChangeId(): string | null {
  return S.settings.perChangeVerdicts ? (cursorChange()?.id ?? null) : null;
}

// Mark the change at the cursor: only its Undo | Keep control shows its keycaps, and a rail runs
// down its rows and its control (decisions.css). Only the affected controls' class and the rail's
// box change, never the diff, so it's cheap enough for every cursor move.
let rail: HTMLElement | null = null;
// A frame's re-placing of the rail and the thread marks is queued (invalidateCursorRows).
let followQueued = false;

function markCursorChange() {
  const diff = $("diff");
  const id = cursorChangeId();
  for (const el of diff.querySelectorAll<HTMLElement>(".verdict.at-cursor"))
    if (el.dataset.change !== id) el.classList.remove("at-cursor");
  const control = id
    ? diff.querySelector<HTMLElement>(`.verdict[data-change="${CSS.escape(id)}"]`)
    : null;
  control?.classList.add("at-cursor");
  const change = id ? currentChanges().find((c) => c.id === id) : undefined;
  placeRail(diff, change, control);
}

// The rail is an overlay in #diff's scrolled content, so it moves with the rows and never shifts
// the code, in either layout. It runs from the change's first row to the bottom of its last row
// or its control's row, whichever is lower, down the left edge of the pane the change lives in:
// in split, its deletions' pane (the left one) when it has any, else its additions'. Unified has
// one pane, flush with #diff. The cursor's row list says which rows are the
// change's (a split row holds both sides); their edges are measured now, since the list's cached
// tops can lag a reflow it wasn't invalidated for. A change whose rows are hidden — a skimmed
// block collapsed under a cursor that sat in it — has no rows on the list, so no rail.
function placeRail(diff: HTMLElement, change?: ChangeState, control?: HTMLElement | null) {
  if (!change || !D.fileDiff) {
    rail?.remove();
    return;
  }
  const span = changeSpan(change, D.fileDiff);
  const holds = (r: Row) =>
    spanHolds(span, r.side, r.line) || (!!r.alt && spanHolds(span, r.alt.side, r.alt.line));
  const shown = (r: Row) => r.el.isConnected && r.el.getBoundingClientRect().height > 0;
  let held = rows().filter(holds);
  if (held.length && !(shown(held[0]) && shown(held[held.length - 1]))) {
    invalidateCursorRows();
    held = rows().filter(holds);
  }
  if (!held.length) {
    rail?.remove();
    return;
  }
  const box = diff.getBoundingClientRect();
  const origin = box.top - diff.scrollTop;
  const pane = diffShadowRoot()?.querySelector<HTMLElement>(
    `code[data-${span.deletions ? "deletions" : "additions"}] [data-gutter]`,
  );
  const left = pane ? pane.getBoundingClientRect().left - box.left + diff.scrollLeft : 0;
  const row = control?.closest(".annotation");
  const top = held[0].el.getBoundingClientRect().top - origin;
  const bottom =
    Math.max(
      held[held.length - 1].el.getBoundingClientRect().bottom,
      row?.getBoundingClientRect().bottom ?? 0,
    ) - origin;
  rail ??= Object.assign(document.createElement("div"), { className: "change-rail" });
  rail.style.left = `${left}px`;
  rail.style.top = `${top}px`;
  rail.style.height = `${bottom - top}px`;
  if (rail.parentElement !== diff) diff.append(rail);
}

// Open the comment composer anchored to the cursor line (keyboard equivalent of clicking a
// line). The composer renders inline at S.selected, so there's nothing to position.
export function cursorComment() {
  if (!cur) ensureCursor();
  if (!cur) return;
  S.selected = { side: cur.side, lineNumber: cur.line };
  openCommentComposer();
}

// Accept (Keep) / reject (Undo) the change under the cursor.
export function cursorVerdict(status: "accepted" | "rejected") {
  if (!cur) ensureCursor();
  const ch = cursorChange();
  if (!ch) {
    toast("No change under the cursor");
    return;
  }
  acceptChange(ch.id, status);
}

function threadComments() {
  if (!cur) return [];
  const raw = fromDisplayLine(cur.side, cur.line); // comments persist raw lines
  return S.state.comments.filter(
    (c) =>
      c.path === (S.preview?.path ?? S.state.files[S.fileIndex]?.path) &&
      c.side === cur!.side &&
      c.lineNumber === raw,
  );
}

// Toggle resolve/reopen on the cursor line's thread.
export function cursorResolve() {
  const thread = threadComments();
  if (!thread.length) {
    toast("No comment on this line");
    return;
  }
  const open = thread.some((c) => c.status === "open");
  thread.forEach((c) => (c.status = open ? "resolved" : "open"));
  render();
  persist();
  toast(open ? "Resolved" : "Reopened");
}
