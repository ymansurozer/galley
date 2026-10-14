import { S, $, esc, toast } from "./store";
import { KINDS, threadCard } from "./annotations";
import { cursorPlace, cursorRowEl, invalidateCursorRows } from "./cursor";
import { lineLabel } from "./thread-derive";
import { firstLine } from "./uilane-derive";
import type { CommentSurface } from "./markdown";
import type { Side, ThreadMeta } from "./types";

// ── Thread cards, and resolved rests ─────────────────────────────────────────
// An open thread always shows as its card, under its own line. A resolved one rests as a muted
// one-line row, and the one in S.openThread expands to its card in place: a click on its row, or
// the cursor landing on its line; Esc or a click on the card's header folds it back. Each thread
// renders into a slot (under a diff line, in the unanchored block, or in the rendered markdown
// view); expanding and folding refill only the slots involved instead of re-rendering the diff.
// They're our own light-DOM nodes, and Pierre's resize observer keeps split view's two sides
// level as their height changes. A full render rebuilds every slot from the store, so the two
// paths agree.

export const threadKey = (t: { path: string; side: Side; lineNumber: number }) =>
  `${t.path}\n${t.side}:${t.lineNumber}`;

const slotThread = new WeakMap<
  HTMLElement,
  { t: ThreadMeta; lost: boolean; surface: CommentSurface }
>();

// A slot for a thread: its card, or its rest while it's resolved and folded. `lost`: the thread is
// in the unanchored block, its line struck through. `surface`: where it renders, the diff by
// default (markdown.ts).
export function threadSlot(t: ThreadMeta, lost = false, surface: CommentSurface = "code") {
  const slot = document.createElement("div");
  slot.className = "thread-slot" + (t.status === "resolved" ? " resolved" : "");
  slot.dataset.thread = `${t.side}:${t.lineNumber}`;
  slot.dataset.key = threadKey(t);
  slotThread.set(slot, { t, lost, surface });
  fill(slot);
  return slot;
}

function fill(slot: HTMLElement) {
  const { t, lost, surface } = slotThread.get(slot)!; // every slot is registered as it's made
  const key = slot.dataset.key!; // set with the slot
  if (t.status === "resolved" && key !== S.openThread) {
    slot.replaceChildren(rest(t, key));
    return;
  }
  const card = threadCard(t, lost, surface);
  // An expanded resolved card folds back on a click on its header.
  if (t.status === "resolved")
    card.querySelector(".tc-head")!.addEventListener("click", () => openThread(null));
  slot.replaceChildren(card);
}

// A resolved thread at rest: a ✓, who opened it, the first line of what they said, the count.
function rest(t: ThreadMeta, key: string): HTMLElement {
  const m = t.comments[0]!; // a thread holds at least the comment that started it
  const b = document.createElement("button");
  b.type = "button";
  b.className = "rest";
  b.title = `${lineLabel(t.lineNumber, m.endLine)} · Resolved — open`;
  b.innerHTML = `<span class="rest-glyph">${KINDS.resolved.glyph}</span><span class="rest-who">${m.role === "agent" ? "Agent" : "You"}</span><span class="rest-text">${esc(firstLine(m.body))}</span><span class="rest-n">${t.comments.length}</span>`;
  b.onclick = () => {
    // The cursor follows a click onto the thread's line, so r, ↵ and c act on the card.
    const slot = b.closest<HTMLElement>(".thread-slot");
    openThread(key);
    if (slot?.dataset.side && slot.dataset.line && S.openThread === key)
      cursorPlace(slot.dataset.side as Side, +slot.dataset.line);
  };
  return b;
}

// The annotation for a thread under its line in the diff (`display`: where that line renders).
export function threadAnnotation(t: ThreadMeta, display: number): HTMLElement {
  const el = document.createElement("div");
  // Classic indicators draw +/− signs ahead of the code, so the code column sits further in.
  el.className =
    "annotation line-thread" + (S.settings.diffIndicators === "classic" ? " signs" : "");
  const slot = threadSlot(t);
  slot.dataset.side = t.side;
  slot.dataset.line = String(display);
  el.append(slot);
  return el;
}

// Expand a resolved thread as its card (null: none), folding the one expanded before. Only those
// two slots change. A card holding an edit with text in it stays, since folding it would hide the
// draft; an empty one closes with it.
export function openThread(key: string | null) {
  const was = S.openThread;
  if (was === key) return;
  const slots = [...document.querySelectorAll<HTMLElement>(".thread-slot.resolved")];
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
  for (const slot of slots) if (slot.dataset.key === was || slot.dataset.key === key) fill(slot);
  keepHeldPlace();
  invalidateCursorRows();
}

// The line the reviewer is looking at keeps its place on screen while a card expands or folds
// around it: the cursor's when it's in view, else the slot expanding. Split view's other column
// levels a frame later (Pierre's resize observer), so the re-placing that follows holds it again,
// for a moment only: a later render or resize mustn't pull the view back. A jump's own scroll
// wins: it holds the row it landed on (cursor.ts landAt), or clears the hold before scrolling
// smoothly (blockers.ts), which a hold would cut short.
let held: { el: HTMLElement; top: number; until: number } | null = null;

export function holdPlace(el: HTMLElement | null | undefined) {
  held = el ? { el, top: el.getBoundingClientRect().top, until: performance.now() + 300 } : null;
}

// Re-applied whenever the rows move (cursor.ts invalidateCursorRows).
export function keepHeldPlace() {
  if (!held || !held.el.isConnected || performance.now() > held.until) {
    held = null;
    return;
  }
  $("diff").scrollTop += held.el.getBoundingClientRect().top - held.top;
}

// The cursor landed on a display line: a resolved thread anchored there expands. False when none
// rests there.
export function openThreadAt(side: Side, line: number): boolean {
  const slot = $("diff").querySelector<HTMLElement>(
    `.line-thread .thread-slot.resolved[data-side="${side}"][data-line="${line}"]`,
  );
  if (!slot) return false;
  openThread(slot.dataset.key!); // every slot carries its key
  return true;
}

// A reply or an edit closing in a diff card hands the cursor to the card's line (keys.ts Esc), so
// r, ↵ and c still act on that thread. False when the open composer isn't in a diff card.
export function cursorToComposingThread(): boolean {
  const slot = $("diff")
    .querySelector(".line-thread .js-composer-focus")
    ?.closest<HTMLElement>(".thread-slot");
  if (!slot?.dataset.side) return false;
  cursorPlace(slot.dataset.side as Side, Number(slot.dataset.line));
  return true;
}

// Esc's layer for an expanded resolved card (keys.ts): fold it. False when none is showing, the
// App view hiding the code included.
export function closeThreadCard(): boolean {
  const key = S.openThread;
  if (
    S.view !== "code" ||
    !key ||
    ![...document.querySelectorAll<HTMLElement>(".thread-slot.resolved")].some(
      (s) => s.dataset.key === key,
    )
  )
    return false;
  openThread(null);
  return true;
}
