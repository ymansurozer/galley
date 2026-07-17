import { S, D, $, toast, persist } from "./store";
import type { Side } from "./types";
import { currentChanges, fromDisplayLine } from "./changes";
import { acceptChange } from "./decisions";
import { openCommentComposer } from "./selection";
import { render } from "./render";
import { diffShadowRoot } from "./diff-dom";

// ── The diff line cursor ─────────────────────────────────────────────────────
// Keyboard review needs a "current line" the diff doesn't otherwise have. We keep it as a
// logical {side, line} (stable across re-renders, since line numbers are) and resolve it to a
// rendered row on demand. The highlight is @pierre's own line selection (setSelectedLines with
// notify:false — paints without firing the selection callbacks, so no composer popup), so
// pointer and keyboard share ONE highlight: a click seeds the cursor (cursorSyncTo) and the
// arrows move the same selection from there.

type Row = {
  el: HTMLElement;
  side: Side;
  line: number;
  top: number;
  height: number;
  change: boolean;
  // The split-view twin of a context row (see rows()): the deletions-side coordinates of the
  // same visual line, kept so a cursor seeded from a left-column click still matches this row.
  alt?: { side: Side; line: number };
};

let cur: { side: Side; line: number } | null = null;

// Every navigable code line in visual (top-to-bottom) order. @pierre tags each line's gutter with
// a [data-line-number-content] span inside a [data-line-type] cell, within a [data-additions] /
// [data-deletions] column (split) — that gives us side + number + row element. Context lines show
// in both split columns at the same y; merge by rounded top into one row (additions side as the
// primary, the deletions twin preserved as `alt` so either coordinate matches).
function rows(): Row[] {
  const sh = diffShadowRoot();
  if (!sh) return [];
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
  out.sort((a, b) => a.top - b.top || (a.side === b.side ? 0 : a.side === "additions" ? -1 : 1));
  const seen = new Map<number, Row>();
  const list: Row[] = [];
  for (const r of out) {
    const k = Math.round(r.top);
    const kept = seen.get(k);
    if (kept) {
      kept.alt = { side: r.side, line: r.line };
      continue;
    }
    seen.set(k, r);
    list.push(r);
  }
  return list;
}

// A row matches on its primary coordinates or its split-view twin (`alt`).
function matches(r: Row, side: Side, line: number): boolean {
  return (
    (r.side === side && r.line === line) || (r.alt?.side === side && r.alt?.line === line) || false
  );
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
}

// Adopt a pointer-made selection as the cursor position, so the arrows continue from the
// clicked line instead of restarting at the first change. @pierre already painted the
// selection itself — no repaint, no scroll.
export function cursorSyncTo(side: Side, line: number) {
  cur = { side, line };
}

// Re-resolve the cursor after a render: keep the same logical line, just repaint. The cursor
// is hidden until the reviewer navigates or clicks (no auto-highlighted first line), so when
// there's no active cursor we clear the selection instead.
export function cursorResync() {
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
  return true;
}

// Jump used by the blockers list. Retries once across two frames so a just-triggered
// collapsed-region expansion (which rerenders) has laid out its rows.
export function cursorJumpTo(side: Side, line: number) {
  if (!landAt(side, line))
    requestAnimationFrame(() => requestAnimationFrame(() => landAt(side, line)));
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

// The change (hunk) whose range covers the cursor line on its side. The cursor reads
// rendered gutter numbers (display space), so compare against the display anchors.
function cursorChange() {
  if (!cur) return null;
  return (
    currentChanges().find(
      (c) =>
        c.side === cur!.side &&
        cur!.line >= (c.displayLineNumber ?? c.lineNumber) &&
        cur!.line <= (c.displayEndLine ?? c.endLine ?? c.lineNumber),
    ) ?? null
  );
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
