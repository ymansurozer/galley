import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { keyCaps, keycapsHtml, keycapsNode, renderKeycaps } from "./keycaps.js";

const keys = (combo: string) => keyCaps(combo).map((c) => c.key);

test("each modifier is its own cap, ahead of the key", () => {
  assert.deepEqual(keys("⇧A"), ["⇧", "A"]);
  assert.deepEqual(keys("⌘⇧↵"), ["⌘", "⇧", "↵"]);
  assert.deepEqual(keys("⌥P"), ["⌥", "P"]);
  assert.deepEqual(keys("⇧,"), ["⇧", ","]);
});

test("a single letter is upper-cased on its cap, the way a keyboard's legend reads", () => {
  assert.deepEqual(keys("w"), ["W"]);
  assert.deepEqual(keys("o"), ["O"]);
  assert.deepEqual(keys("]"), ["]"]);
});

test("a named key or gesture stays one cap, as written", () => {
  assert.deepEqual(keys("Esc"), ["Esc"]);
  assert.deepEqual(keys("1–9"), ["1–9"]);
  assert.deepEqual(keys("Drag text"), ["Drag text"]);
  assert.deepEqual(keys("⇧ Click"), ["⇧", "Click"]);
});

test("modifier and arrow glyphs are marked so they can be drawn a size up", () => {
  assert.deepEqual(
    keyCaps("⇧↓").map((c) => c.glyph),
    [true, true],
  );
  assert.deepEqual(
    keyCaps("⇧A").map((c) => c.glyph),
    [true, false],
  );
  assert.deepEqual(
    keyCaps("Esc").map((c) => c.glyph),
    [false],
  );
});

test("the markup is one kbd per key inside one keycaps kbd, with the key text escaped", () => {
  assert.equal(
    keycapsHtml("⇧A"),
    '<kbd class="keycaps"><kbd class="cap glyph">⇧</kbd><kbd class="cap">A</kbd></kbd>',
  );
  assert.equal(keycapsHtml("<"), '<kbd class="keycaps"><kbd class="cap">&lt;</kbd></kbd>');
});

test("the node form draws the same caps, with the key as text rather than markup", () => {
  const doc = new Window().document as unknown as Document;
  assert.equal(
    keycapsNode(doc, "⌘⇧↵").outerHTML,
    '<kbd class="keycaps"><kbd class="cap glyph">⌘</kbd><kbd class="cap glyph">⇧</kbd><kbd class="cap glyph">↵</kbd></kbd>',
  );
  assert.equal(keycapsNode(doc, "<b>").querySelector(".cap")!.textContent, "<b>");
});

test("redrawing an element replaces its caps, so a bound combo can change", () => {
  const doc = new Window().document as unknown as Document;
  const el = doc.createElement("kbd");
  el.textContent = "w";
  renderKeycaps(el, el.textContent);
  renderKeycaps(el, "⇧B");
  assert.equal(
    el.outerHTML,
    '<kbd class="keycaps"><kbd class="cap glyph">⇧</kbd><kbd class="cap">B</kbd></kbd>',
  );
});
