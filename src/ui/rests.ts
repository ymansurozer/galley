import { S, $, esc, toast } from "./store";
import { awaitingParts, KINDS, threadCard } from "./annotations";
import { cursorPlace, cursorRowEl, invalidateCursorRows, rowAt } from "./cursor";
import { diffShadowRoot } from "./diff-dom";
import { lineLabel, questionWaiting, threadKind } from "./thread-derive";
import { firstLine } from "./uilane-derive";
import type { GroupMeta, Side, ThreadMeta } from "./types";

// ── Thread rests ─────────────────────────────────────────────────────────────
// Every thread rests as a one-line row under its line, and the one in S.openThread opens as its
// card in place. Each thread renders into a slot (in a diff group, the unanchored block, or the
// rendered markdown view); opening and closing refill the slots involved in place instead of
// re-rendering the diff. They're our own light-DOM nodes, and Pierre's resize observer keeps
// split view's two sides level as their height changes. A full render rebuilds every slot from
// the store, so the two paths agree.

export const threadKey = (t: { path: string; side: Side; lineNumber: number }) =>
  `${t.path}\n${t.side}:${t.lineNumber}`;

const slotThread = new WeakMap<HTMLElement, { t: ThreadMeta; lost: boolean }>();

// A slot for a thread: its rest, or its card when open. `lost`: the thread is in the unanchored
// block, its line struck through.
export function threadSlot(t: ThreadMeta, lost = false) {
  const slot = document.createElement("div");
  slot.className = "thread-slot";
  slot.dataset.thread = `${t.side}:${t.lineNumber}`;
  slot.dataset.key = threadKey(t);
  slotThread.set(slot, { t, lost });
  fill(slot, slot.dataset.key === S.openThread);
  return slot;
}

function fill(slot: HTMLElement, open: boolean) {
  const { t, lost } = slotThread.get(slot)!; // every slot is registered as it's made
  slot.replaceChildren(open ? threadCard(t, lost) : rest(t, lost, slot.dataset.key!));
}

// One line: the state glyph, who spoke last, the first line of what they said, the count. A
// resolved thread shows what it was about instead: its opening message, muted.
function rest(t: ThreadMeta, lost: boolean, key: string): HTMLElement {
  const kind = threadKind(t.status, t.comments);
  const waiting = kind !== "resolved" && questionWaiting(t.comments);
  // A thread holds at least the comment that started it.
  const m = (kind === "resolved" ? t.comments[0] : t.comments.at(-1))!;
  const agent = m.role === "agent";
  const glyph = waiting
    ? `<span class="rest-glyph awaiting-answer${awaitingParts().queued ? " queued" : ""}"><span class="tc-spin"></span></span>`
    : `<span class="rest-glyph">${KINDS[kind].glyph}</span>`;
  const loc = lineLabel(t.lineNumber, t.comments[0]?.endLine);
  const b = document.createElement("button");
  b.type = "button";
  b.className = `rest k-${kind}`;
  b.title = `${loc} · ${KINDS[kind].label} — open`;
  b.innerHTML = `${glyph}${lost ? `<span class="rest-loc"><s>${loc}</s></span>` : ""}<span class="rest-who${agent ? " agent" : ""}">${agent ? "Agent" : "You"}</span><span class="rest-text">${esc(firstLine(m.body))}</span><span class="rest-n">${t.comments.length}</span>`;
  b.onclick = () => {
    // The cursor follows a click onto the thread's line, so r, ↵ and c act on the open card.
    const slot = b.closest<HTMLElement>(".thread-slot");
    const side = slot?.closest<HTMLElement>(".thread-group")?.dataset.side as Side | undefined;
    openThread(key);
    if (side && slot?.dataset.line && S.openThread === key) cursorPlace(side, +slot.dataset.line);
  };
  return b;
}

// The annotation for a group of threads gathered under its last line.
export function threadGroupElement(g: GroupMeta): HTMLElement {
  const el = document.createElement("div");
  el.className = "annotation thread-group";
  el.dataset.side = g.side;
  for (const t of g.threads) {
    const slot = threadSlot(t);
    slot.dataset.line = String(t.display);
    el.append(slot);
  }
  return el;
}

// Open a thread as its card (null: none), closing the one open before. Only those two slots
// change. A card holding a reply or an edit with text in it stays open, since closing it would
// hide the draft; an empty one closes with its card.
export function openThread(key: string | null) {
  const was = S.openThread;
  if (was === key) return;
  const slots = [...document.querySelectorAll<HTMLElement>(".thread-slot")];
  const drafting = slots.find(
    (s) => s.dataset.key === was && s.querySelector(".js-composer-focus"),
  );
  if (drafting && S.composerBody.trim()) {
    // Say why nothing opened: the draft's card flashes.
    drafting.classList.remove("flash");
    void drafting.offsetWidth; // restart the animation
    drafting.classList.add("flash");
    toast("Finish or clear your draft first");
    return;
  }
  if (drafting) {
    S.composerOpen = false;
    S.editingCommentId = null;
  }
  S.openThread = key;
  const view = $("diff").getBoundingClientRect();
  const row = cursorRowEl();
  const r = row?.getBoundingClientRect();
  holdPlace(
    r && r.bottom > view.top && r.top < view.bottom
      ? row
      : slots.find((s) => s.dataset.key === key && s.closest("#diff")),
  );
  for (const slot of slots)
    if (slot.dataset.key === was || slot.dataset.key === key) fill(slot, slot.dataset.key === key);
  keepHeldPlace();
  invalidateCursorRows();
}

// The line the reviewer is looking at keeps its place on screen while rows open and close around
// it: the cursor's when it's in view, else the slot opening. Split view's other column levels a
// frame later (Pierre's resize observer), so the re-placing that follows holds it again, for a
// moment only: a later render or resize mustn't pull the view back. A jump's own scroll wins: it
// holds the row it landed on (cursor.ts landAt), or clears the hold before scrolling smoothly
// (blockers.ts), which a hold would cut short.
let held: { el: HTMLElement; top: number; until: number } | null = null;

export function holdPlace(el: HTMLElement | null | undefined) {
  held = el ? { el, top: el.getBoundingClientRect().top, until: performance.now() + 300 } : null;
}

function keepHeldPlace() {
  if (!held || !held.el.isConnected || performance.now() > held.until) {
    held = null;
    return;
  }
  $("diff").scrollTop += held.el.getBoundingClientRect().top - held.top;
}

// What follows the rows moving (cursor.ts invalidateCursorRows): the held place, then the marks.
export function followRows() {
  keepHeldPlace();
  placeThreadMarks();
}

// The cursor landed on a display line: the thread anchored there opens. False when none is.
export function openThreadAt(side: Side, line: number): boolean {
  const slot = $("diff").querySelector<HTMLElement>(
    `.thread-group[data-side="${side}"] .thread-slot[data-line="${line}"]`,
  );
  if (!slot) return false;
  openThread(slot.dataset.key!); // every slot carries its key
  return true;
}

// Esc's layer for the open card (keys.ts): close it. False when no card is showing, the App view
// hiding the code included.
export function closeThreadCard(): boolean {
  const key = S.openThread;
  if (
    S.view !== "code" ||
    !key ||
    ![...document.querySelectorAll<HTMLElement>(".thread-slot")].some((s) => s.dataset.key === key)
  )
    return false;
  openThread(null);
  return true;
}

// The marks that tie a group's rows to their lines: each row repeats its line number in the
// number column, and a gutter line runs from the first anchor to the last row, with a dot on
// each anchor. One overlay in #diff's scrolled content, like the change rail, placed from the
// cursor's row geometry whenever the rows move (invalidateCursorRows), never on scroll.
let marks: HTMLElement | null = null;

function placeThreadMarks() {
  const diff = $("diff");
  const groups = diff.querySelectorAll<HTMLElement>(".thread-group");
  if (!groups.length) {
    marks?.remove();
    return;
  }
  const box = diff.getBoundingClientRect();
  const y0 = box.top - diff.scrollTop;
  const x0 = box.left - diff.scrollLeft;
  let html = "";
  for (const g of groups) {
    const side = g.dataset.side as Side; // set with the group
    const slots = [...g.querySelectorAll<HTMLElement>(":scope > .thread-slot")];
    const anchors = slots.map((s) => rowAt(side, Number(s.dataset.line))?.el).filter((x) => !!x);
    const num = anchors[0]?.getBoundingClientRect();
    if (!num) continue; // its lines are folded or skimmed away
    // In the number column's right margin, clear of the digits and of the change bar beside it.
    const x = num.right - x0 - 4;
    const mids: number[] = [];
    for (const el of anchors) {
      const r = el.getBoundingClientRect();
      mids.push(r.top + r.height / 2 - y0);
      html += `<i class="tm-dot" style="left:${x}px;top:${r.top + r.height / 2 - y0}px"></i>`;
    }
    for (const s of slots) {
      const r = s.getBoundingClientRect();
      const mid = r.top + Math.min(r.height, 24) / 2 - y0;
      mids.push(mid);
      html += `<b class="tm-num" style="left:${num.left - x0}px;width:${num.width}px;top:${mid}px">${s.dataset.line}</b>`;
    }
    const top = Math.min(...mids);
    html += `<i class="tm-line" style="left:${x}px;top:${top}px;height:${Math.max(...mids) - top}px"></i>`;
  }
  marks ??= Object.assign(document.createElement("div"), { className: "thread-marks" });
  marks.innerHTML = html;
  // In the code theme's number colour, which needn't follow the appearance.
  const host = diffShadowRoot()?.host;
  if (host) marks.style.color = getComputedStyle(host).getPropertyValue("--diffs-fg-number");
  if (marks.parentElement !== diff) diff.append(marks);
}
