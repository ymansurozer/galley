import { S, $, toast, persist } from "./store";
import type { Side } from "./types";
import { currentChanges } from "./changes";
import { acceptChange } from "./decisions";
import { openCommentComposer } from "./selection";
import { render } from "./render";

// ── The diff line cursor ─────────────────────────────────────────────────────
// Keyboard review needs a "current line" the diff doesn't otherwise have. We keep it as a
// logical {side, line} (stable across re-renders, since line numbers are) and resolve it to a
// rendered row on demand. The diff lives in @pierre's shadow DOM, so — like the overview ruler —
// we read row rects and drive a host-level highlight bar instead of mutating shadow internals.

type Row = { el: HTMLElement; side: Side; line: number; top: number; height: number; change: boolean };

let cur: { side: Side; line: number } | null = null;
let curEl: HTMLElement | null = null; // the rendered row, cached for cheap scroll repositioning

function shadow(): ShadowRoot | null {
  let sh: ShadowRoot | null = null;
  $("diff").querySelectorAll("*").forEach((el) => { if ((el as HTMLElement).shadowRoot) sh = (el as HTMLElement).shadowRoot; });
  return sh;
}

// Every navigable code line in visual (top-to-bottom) order. @pierre tags each line's gutter with
// a [data-line-number-content] span inside a [data-line-type] cell, within a [data-additions] /
// [data-deletions] column (split) — that gives us side + number + row element. Context lines show
// in both split columns at the same y; dedupe by rounded top (prefer the additions side).
function rows(): Row[] {
  const sh = shadow();
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
    const side: Side = type.includes("deletion") ? "deletions"
      : type.includes("addition") ? "additions"
      : col?.hasAttribute("data-deletions") ? "deletions" : "additions";
    const line = parseInt(span.textContent || "", 10);
    if (!Number.isFinite(line)) return;
    const r = cell.getBoundingClientRect();
    if (!r.height) return;
    out.push({ el: cell, side, line, top: r.top - diffTop + scrollTop, height: r.height, change: type.startsWith("change-") });
  });
  out.sort((a, b) => a.top - b.top || (a.side === b.side ? 0 : a.side === "additions" ? -1 : 1));
  const seen = new Set<number>();
  return out.filter((r) => { const k = Math.round(r.top); if (seen.has(k)) return false; seen.add(k); return true; });
}

function indexOfCur(list: Row[]): number {
  return cur ? list.findIndex((r) => r.side === cur!.side && r.line === cur!.line) : -1;
}

// Position the host highlight bar over a row (visible position = content top − scroll).
function paint(r: Row) {
  curEl = r.el;
  const bar = $("cursorbar");
  bar.style.top = `${r.top - $("diff").scrollTop}px`;
  bar.style.height = `${r.height}px`;
  bar.classList.add("show");
}
function hide() { curEl = null; $("cursorbar").classList.remove("show"); }

// Cheap reposition for scroll: read the cached row's live rect (no full re-scan).
export function cursorOnScroll() {
  if (!curEl || !curEl.isConnected) return;
  const r = curEl.getBoundingClientRect();
  if (!r.height) return;
  const bar = $("cursorbar");
  bar.style.top = `${r.top - $("diff").getBoundingClientRect().top}px`;
  bar.style.height = `${r.height}px`;
}

function landOn(r: Row | undefined, scroll = true) {
  if (!r) return;
  cur = { side: r.side, line: r.line };
  paint(r);
  if (scroll) r.el.scrollIntoView({ block: "nearest" });
}

// Re-resolve the cursor after a render or scroll: keep the same logical line, just repaint. The
// cursor is hidden until the reviewer navigates (no auto-highlighted first line), so when there's
// no active cursor we stay hidden.
export function cursorResync() {
  if (!cur) { hide(); return; }
  const r = rows().find((x) => x.side === cur!.side && x.line === cur!.line);
  if (r) paint(r); else hide();
}

// Drop the cursor (file switch, overview, markdown view) — clears the highlight entirely.
export function cursorReset() { cur = null; hide(); }

// Reveal the cursor on first use: land on the first change (else the first line). Returns the row.
function ensureCursor(): Row | undefined {
  if (cur) return rows().find((x) => x.side === cur!.side && x.line === cur!.line);
  const list = rows();
  if (!list.length) return undefined;
  const r = list.find((x) => x.change) ?? list[0];
  landOn(r, false);
  return r;
}

export function cursorMoveLine(dir: 1 | -1) {
  const list = rows();
  if (!list.length) return;
  if (!cur) { ensureCursor(); return; } // first press just reveals the cursor
  const i = indexOfCur(list);
  if (i < 0) { landOn(dir === 1 ? list[0] : list[list.length - 1]); return; }
  landOn(list[Math.max(0, Math.min(list.length - 1, i + dir))]);
}

// Jump to the first line of the next/previous change run (a contiguous block of change rows).
export function cursorMoveHunk(dir: 1 | -1) {
  const list = rows();
  if (!list.length) return;
  if (!cur) { ensureCursor(); return; } // first press just reveals the cursor (on the first change)
  const isStart = (j: number) => list[j].change && (j === 0 || !list[j - 1].change);
  const i = indexOfCur(list);
  for (let j = i + dir; j >= 0 && j < list.length; j += dir) {
    if (isStart(j)) { landOn(list[j]); return; }
  }
  toast(dir === 1 ? "No more changes" : "No previous changes");
}

// The change (hunk) whose range covers the cursor line on its side.
function cursorChange() {
  if (!cur) return null;
  return currentChanges().find((c) => c.side === cur!.side && cur!.line >= c.lineNumber && cur!.line <= (c.endLine ?? c.lineNumber)) ?? null;
}

// Open the comment composer anchored to the cursor line (keyboard equivalent of clicking a line).
export function cursorComment() {
  if (!cur) ensureCursor();
  if (!cur) return;
  const r = rows().find((x) => x.side === cur!.side && x.line === cur!.line);
  S.selected = { side: cur.side, lineNumber: cur.line };
  if (r) {
    const box = (document.querySelector(".main") as HTMLElement).getBoundingClientRect();
    const top = r.top - $("diff").scrollTop + $("diff").getBoundingClientRect().top;
    const pop = $("composer");
    pop.style.left = `${Math.max(292, Math.min(box.width - 360, $("diff").getBoundingClientRect().left - box.left + 60))}px`;
    pop.style.top = `${Math.max(58, Math.min(box.height - 220, top - box.top + r.height + 4))}px`;
  }
  openCommentComposer();
}

// Accept (Keep) / reject (Undo) the change under the cursor.
export function cursorVerdict(status: "accepted" | "rejected") {
  if (!cur) ensureCursor();
  const ch = cursorChange();
  if (!ch) { toast("No change under the cursor"); return; }
  acceptChange(ch.id, status);
}

function threadComments() {
  if (!cur) return [];
  return S.state.comments.filter((c) => c.path === (S.preview?.path ?? S.state.files[S.fileIndex]?.path) && c.side === cur!.side && c.lineNumber === cur!.line);
}

// Toggle resolve/reopen on the cursor line's thread.
export function cursorResolve() {
  const thread = threadComments();
  if (!thread.length) { toast("No comment on this line"); return; }
  const open = thread.some((c) => c.status === "open");
  thread.forEach((c) => (c.status = open ? "resolved" : "open"));
  render(); persist(); toast(open ? "Resolved" : "Reopened");
}
