import { S } from "./store";
import { fromDisplayLine } from "./changes";
import { render } from "./render";
import type { Side } from "./types";

// ── Inline composers ─────────────────────────────────────────────────────────
// The composer is imperative DOM built into the diff (like the thread), NOT the old
// floating Alpine popover: a new comment is a `composer` annotation at the selected line,
// a reply is a card at the bottom of its thread, an edit swaps a message body in place.
// Exactly one is open at a time. Its text lives in S.composerBody (synced on input) so it
// survives render()'s rebuild of the diff DOM; caret + focus are restored after each render
// (restoreComposerFocus). The active textarea always carries `.js-composer-focus`.

// Caret offset in the open composer, kept alongside S.composerBody so a rebuild can restore
// the insertion point, not just the text. Reset whenever a composer opens.
let composerCaret = 0;

// Sync the store from the live textarea on every keystroke — the store is the source of
// truth a re-render re-mounts from.
function trackInput(ta: HTMLTextAreaElement) {
  ta.addEventListener("input", () => {
    S.composerBody = ta.value;
    composerCaret = ta.selectionStart ?? ta.value.length;
  });
  // A click/arrow inside the textarea moves the caret without an input event.
  const syncCaret = () => (composerCaret = ta.selectionStart ?? composerCaret);
  ta.addEventListener("keyup", syncCaret);
  ta.addEventListener("click", syncCaret);
}

// The new-comment / reply composer card: textarea + the two intent buttons (Ask / Request
// change), in the same card family as a message. Used both as its own annotation (new
// comment) and appended to a thread (reply).
export function buildComposer(): HTMLElement {
  const card = document.createElement("div");
  card.className = "composer-card";
  const ta = document.createElement("textarea");
  ta.className = "composer-input js-composer-focus";
  ta.placeholder = "Comment — markdown supported";
  ta.value = S.composerBody;
  trackInput(ta);
  card.appendChild(ta);
  const row = document.createElement("div");
  row.className = "crow";
  row.innerHTML = `<span class="spacer"></span><button class="cbtn ask">Ask <kbd>⌘⇧↵</kbd></button><button class="cbtn req">Request change <kbd>⌘↵</kbd></button>`;
  (row.querySelector(".ask") as HTMLButtonElement).onclick = () => S.ask?.();
  (row.querySelector(".req") as HTMLButtonElement).onclick = () => S.requestChange?.();
  card.appendChild(row);
  return card;
}

// The in-place edit state for a message: the body swaps for a textarea (amber accent) with
// Save / Cancel, keeping the existing S.editingCommentId + submitComment edit path.
export function buildEditor(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "msg-edit";
  const ta = document.createElement("textarea");
  ta.className = "composer-edit js-composer-focus";
  ta.value = S.composerBody;
  trackInput(ta);
  wrap.appendChild(ta);
  const row = document.createElement("div");
  row.className = "crow editrow";
  row.innerHTML = `<span class="spacer"></span><button class="cbtn cancel">Cancel</button><button class="cbtn req save">Save <kbd>⌘↵</kbd></button>`;
  (row.querySelector(".cancel") as HTMLButtonElement).onclick = () => closeComposer();
  (row.querySelector(".save") as HTMLButtonElement).onclick = () => S.saveComment?.();
  wrap.appendChild(row);
  return wrap;
}

// Is the open new/reply composer targeting this (raw) line? S.selected is display space on
// the diff (and identity in the markdown view, where D.lineMap is null), so convert before
// comparing against a thread's raw anchor.
export function composerTargets(side: Side, rawLine: number): boolean {
  return (
    S.composerOpen &&
    !S.editingCommentId &&
    S.selected.side === side &&
    fromDisplayLine(S.selected.side, S.selected.lineNumber) === rawLine
  );
}

// Open a fresh new/reply composer at the current S.selected line (a reply first points
// S.selected at the thread's anchor). The composer appears on the next render.
export function openComposer() {
  composerCaret = 0;
  S.composerBody = "";
  S.editingCommentId = null;
  S.composerOpen = true;
  render();
}

// Close whatever composer is open and rebuild the diff so its DOM goes away (the inline
// composer is imperative — nothing hides it reactively like the old Alpine popover did).
// `deferRender` postpones the rebuild until the in-flight click has fully settled: the
// outside-click close fires on pointerdown (capture), but the browser only dispatches
// `click` after pointerup — ~50–150ms later for a human press — and any render in between
// destroys the press's mousedown target (a Keep/Undo/Reply button), silently dropping the
// click. A macrotask timer is NOT enough (it fires while the button is still held), so wait
// for the click itself to bubble to the document, with a timeout fallback for pointerdowns
// that never become clicks (drags). If that same click opened a fresh composer (clicking
// another line), the render simply draws it — state is untouched here.
export function closeComposer(deferRender = false) {
  S.composerOpen = false;
  S.editingCommentId = null;
  if (!deferRender) {
    render();
    return;
  }
  let timer = 0;
  const settle = () => {
    clearTimeout(timer);
    document.removeEventListener("click", settle);
    render();
  };
  timer = window.setTimeout(settle, 200);
  document.addEventListener("click", settle); // bubble: runs after the target's own handlers
}

// After every render the diff DOM (and any composer inside it) is rebuilt from scratch, so
// re-focus the open composer and restore its caret from the store. No-op when none is open.
export function restoreComposerFocus() {
  if (!S.composerOpen) return;
  const ta = document.querySelector<HTMLTextAreaElement>(".js-composer-focus");
  if (!ta) return;
  if (ta.value !== S.composerBody) ta.value = S.composerBody;
  ta.focus();
  const pos = Math.min(composerCaret, ta.value.length);
  ta.setSelectionRange(pos, pos);
}
