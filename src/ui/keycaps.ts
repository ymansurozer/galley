import { esc } from "./html";

// Every shortcut the desk shows — on a button, in a tooltip, in the sidebar, in the Shortcuts tab —
// is drawn here as keycaps: one cap per key, the way a Mac menu draws them. Modifiers peel off
// the front one at a time (a space after one is only spacing); whatever remains is the key — a
// letter, a glyph, or a word (Esc, Click, Drag text). A single letter is upper-cased, as on a
// keyboard's legend: `W` is plain w, and Shift always shows as its own ⇧ cap.
const MODIFIERS = "⌘⇧⌥⌃";
// Symbol keys whose glyph sits small in a text face; their caps draw them a size up.
const GLYPHS = MODIFIERS + "↵↑↓←→";

export type Cap = { key: string; glyph: boolean };

export function keyCaps(combo: string): Cap[] {
  const caps: Cap[] = [];
  let rest = combo.trim();
  while (rest && MODIFIERS.includes(rest[0]!)) {
    caps.push({ key: rest[0]!, glyph: true });
    rest = rest.slice(1).trimStart();
  }
  if (rest) {
    const key = rest.length === 1 ? rest.toUpperCase() : rest;
    caps.push({ key, glyph: GLYPHS.includes(key) });
  }
  return caps;
}

const capClass = (c: Cap) => (c.glyph ? "cap glyph" : "cap");

// For markup built as a string (a button's innerHTML).
export function keycapsHtml(combo: string): string {
  const caps = keyCaps(combo).map((c) => `<kbd class="${capClass(c)}">${esc(c.key)}</kbd>`);
  return `<kbd class="keycaps">${caps.join("")}</kbd>`;
}

// Draw a combo into an element that becomes the keycaps group (the x-keys directive's target).
export function renderKeycaps(el: HTMLElement, combo: string) {
  el.classList.add("keycaps");
  el.replaceChildren(
    ...keyCaps(combo).map((c) => {
      const cap = el.ownerDocument.createElement("kbd");
      cap.className = capClass(c);
      cap.textContent = c.key;
      return cap;
    }),
  );
}

// For markup built as nodes.
export function keycapsNode(doc: Document, combo: string): HTMLElement {
  const el = doc.createElement("kbd");
  renderKeycaps(el, combo);
  return el;
}
