import Alpine from "alpinejs";
import { S, D, $ } from "./store";
import type { Decision, ReviewComment, Side } from "./types";
import { currentFile, toDisplayLine } from "./changes";
import { isUnanchored } from "./unanchored";
import { revealLine } from "./expand";
import { cursorJumpTo, cursorReset, isRendered } from "./cursor";
import { isFileSkimCollapsed, toggleFileSkim } from "./skim";

// ── "Why can't I approve this file?" ─────────────────────────────────────────
// fileObjections gates Approve on rejected hunks and open change-request comments, but
// either can sit far off-screen (or, for an orphaned thread, off the diff entirely). The
// blockers chip in the file bar counts them and opens a jump list, so the reason a
// file reads "Mark reviewed" / changes-requested is always one click away.

export type Blocker =
  | { kind: "reject"; decision: Decision }
  | { kind: "thread"; side: Side; lineNumber: number; preview: string; unanchored: boolean };

// Must mirror fileObjections (changes.ts) exactly — the chip count and the button label
// have to agree on what counts.
export function fileBlockers(path: string): Blocker[] {
  const out: Blocker[] = [];
  for (const d of S.state.decisions ?? [])
    if (d.path === path && d.status === "rejected") out.push({ kind: "reject", decision: d });
  const file = S.state.files.find((f) => f.path === path);
  const groups = new Map<string, ReviewComment[]>();
  for (const c of S.state.comments) {
    if (c.path !== path || c.status !== "open" || c.role === "agent" || c.intent === "question")
      continue;
    const key = `${c.side}:${c.lineNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  for (const comments of groups.values()) {
    comments.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    const first = comments[0];
    const preview = first.body.replace(/\s+/g, " ").trim();
    out.push({
      kind: "thread",
      side: first.side,
      lineNumber: first.lineNumber,
      preview: preview.length > 64 ? preview.slice(0, 63) + "…" : preview,
      unanchored: !!file && comments.some((c) => isUnanchored(c, file)),
    });
  }
  return out;
}

// Where a rejected hunk renders now: after replay its block is a context entry at the
// same (hunkIndex, changeIndex), so read the display position straight off the rendered
// diff; fall back to mapping the decision's raw anchor.
function decisionDisplayPos(d: Decision): { side: Side; line: number } {
  const ch = (S.state.changes ?? []).find((c) => c.id === d.key);
  const part =
    ch && ch.changeIndex !== undefined
      ? D.fileDiff?.hunks[ch.hunkIndex]?.hunkContent?.[ch.changeIndex]
      : undefined;
  if (part && ch) {
    if (part.type === "change")
      return {
        side: ch.side,
        line: (ch.side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1,
      };
    return { side: "additions", line: part.additionLineIndex + 1 };
  }
  return { side: d.side, line: toDisplayLine(d.side, d.lineNumber) };
}

// Scroll a thread that isn't on a diff row (the strip's, a rendered markdown file's) into view and
// flash it.
function flashThread(el: HTMLElement) {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
}

// A thread on a diff row: the cursor lands on (and flashes) its line, and its card flashes beside
// it. Two frames late, so an unfold's re-render has drawn the card first.
function flashLineThread(side: Side, lineNumber: number) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = $("diff").querySelector<HTMLElement>(
        `.annotation[data-thread="${side}:${lineNumber}"]`,
      );
      if (!el) return;
      el.classList.remove("flash");
      void el.offsetWidth; // restart the animation
      el.classList.add("flash");
    }),
  );
}

// Bring a blocker on the open file into view and flash it, from whichever view the file is in.
// It's the one route for both the blockers list and the change-request walk (requests.ts), so the
// two can't drift. The view first gets something to land on: a skimmed file folded behind its
// strip expands, and a rejected change in rendered markdown, which has no rows to show it,
// switches the file to Source. Then the target is found where the view draws it: a rendered
// markdown thread, the lost-thread strip, else the diff row, under the cursor. `current` lets a
// caller drop a jump the reviewer moved on from while the view re-rendered.
export async function jumpToBlocker(b: Blocker, current: () => boolean = () => true) {
  const path = currentFile().path;
  if (isFileSkimCollapsed(path)) await toggleFileSkim(path);
  if (b.kind === "reject" && $("diff").querySelector(".md-file")) await S.setFileView?.("source");
  if (currentFile()?.path !== path || !current()) return;
  if (b.kind === "reject") {
    const pos = decisionDisplayPos(b.decision);
    cursorJumpTo(pos.side, pos.line);
    return;
  }
  const diff = $("diff");
  const thread =
    diff.querySelector<HTMLElement>(`.md-thread[data-thread="${b.lineNumber}"]`) ??
    diff.querySelector<HTMLElement>(`.unanchored-strip [data-thread="${b.side}:${b.lineNumber}"]`);
  if (thread) {
    cursorReset(); // off the rows, so the cursor can't hold the place
    flashThread(thread);
    return;
  }
  if (b.unanchored) {
    diff
      .querySelector<HTMLElement>(".unanchored-strip")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  const line = toDisplayLine(b.side, b.lineNumber);
  // Unfold only when the line isn't rendered: each expansion reveals more lines, so unfolding a
  // line that already renders would widen the run on every jump to it.
  if (!isRendered(b.side, line)) revealLine(b.side, b.lineNumber);
  cursorJumpTo(b.side, line);
  if (b.kind === "thread") flashLineThread(b.side, b.lineNumber);
}

// The open popover, while one is open: a row's jump, a click outside and Esc all close it through
// `close`, which also drops the outside-click listener.
let openPop: { wrap: HTMLElement; close: () => void } | null = null;

// Esc's layer for the popover (keys.ts): close it. False when none is showing — a re-render of the
// bar may have dropped it from the page, and then Esc belongs to the next layer.
export function closeBlockers(): boolean {
  if (!openPop) return false;
  const shown = openPop.wrap.isConnected;
  openPop.close();
  return shown;
}

// A dialog or go-to-line takes the keyboard, Esc included, so the popover closes as one opens:
// left open behind a dialog, it would linger after the dialog's Esc.
export function installBlockers() {
  Alpine.effect(() => {
    if (S.confirmMsg || S.sendOpen || S.settingsOpen || S.shotView || S.golineBuffer)
      closeBlockers();
  });
}

// One row of the jump list: what kind of blocker, where it sits, and its text.
function blockerRow(b: Blocker): HTMLButtonElement {
  const [kind, glyph, label, where, text] =
    b.kind === "reject"
      ? ["undone", "arrow-left", "Undone", `L${b.decision.lineNumber}`, b.decision.title]
      : b.unanchored
        ? ["lost", "circle-alert", "Lost its place", `was L${b.lineNumber}`, b.preview]
        : ["change", "flag", "Change request", `L${b.lineNumber}`, b.preview];
  const row = document.createElement("button");
  row.className = `blockers-item ${kind}`;
  row.innerHTML = `<span class="bk-kind"><svg class="ic"><use href="#gly-${glyph}"></use></svg>${label}</span><span class="bk-where"></span><span class="bk-text"></span>`;
  row.querySelector(".bk-where")!.textContent = where;
  row.querySelector(".bk-text")!.textContent = text;
  return row;
}

// The bar's "N blockers" chip + its jump-list popover (imperative DOM, like the rest of the bar).
export function blockersChip(): HTMLElement | null {
  const path = currentFile().path;
  const items = fileBlockers(path);
  if (!items.length) return null;
  const wrap = document.createElement("span");
  wrap.className = "blockers";
  const btn = document.createElement("button");
  btn.className = "blockers-chip";
  btn.textContent = `${items.length} blocker${items.length === 1 ? "" : "s"}`;
  btn.setAttribute("data-tip", "What's keeping this file from Approved");
  btn.setAttribute("aria-expanded", "false");
  wrap.appendChild(btn);
  const pop = document.createElement("div");
  pop.className = "blockers-pop";
  pop.setAttribute("role", "menu");
  const head = document.createElement("div");
  head.className = "blockers-head";
  head.textContent = `Keeping ${path.split("/").pop()} from Approved`;
  pop.appendChild(head);
  const close = () => {
    wrap.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
    if (openPop?.wrap === wrap) openPop = null;
  };
  const outside = (ev: MouseEvent) => {
    if (!wrap.contains(ev.target as Node)) close();
  };
  for (const b of items) {
    const row = blockerRow(b);
    row.onclick = () => {
      close();
      void jumpToBlocker(b);
    };
    pop.appendChild(row);
  }
  wrap.appendChild(pop);
  btn.onclick = (e) => {
    e.stopPropagation();
    if (wrap.classList.contains("open")) return close();
    closeBlockers(); // a popover left open by an earlier render of the bar
    wrap.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", outside, true);
    openPop = { wrap, close };
  };
  return wrap;
}
