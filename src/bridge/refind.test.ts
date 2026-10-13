import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Rect, UiMarkElement, UiSource } from "../types";
import { findElement, located, refind, stands, type Found } from "./refind";

// A fixture page after the agent's change. Elements get the boxes their `data-box="x y width
// height"` gives (happy-dom lays nothing out). An element with `data-at="line:column"` was rendered
// at that place in the page component's template, as a Nuxt dev page tells it: Vue's expandos on
// the element and the tracer's map from its vnode props to `[file, line, 0-based column]`, the file
// relative to the dev server's cwd.
const FILE = "/repo/app/pages/files.vue";

function page(html: string) {
  const window = new Window();
  const { document } = window;
  document.body.innerHTML = html;
  const doc = document as unknown as Document;
  for (const el of doc.querySelectorAll("[data-box]")) {
    const [x, y, width, height] = el.getAttribute("data-box")!.split(" ").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const r = { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
    el.getBoundingClientRect = () => ({ ...r, toJSON: () => r }) as DOMRect;
  }
  const positions = new WeakMap<object, [string, number, number]>();
  Object.defineProperty(window, "__vue_tracer__", {
    value: { hasData: true, vnodeToPos: positions },
    configurable: true,
  });
  const component = { type: { __file: FILE, __name: "files" }, parent: null, vnode: { props: {} } };
  for (const el of doc.querySelectorAll("[data-at]")) {
    const [line, column] = el.getAttribute("data-at")!.split(":").map(Number) as [number, number];
    const props = {};
    positions.set(props, ["app/pages/files.vue", line, column - 1]);
    Object.assign(el, { __vnode: { props }, __vueParentComponent: component });
  }
  // `data-in`: rendered by the component, at no place the tracer knows (its file only).
  for (const el of doc.querySelectorAll("[data-in]"))
    Object.assign(el, { __vueParentComponent: component });
  const $ = (sel: string) => {
    const el = doc.querySelector(sel);
    if (!el) throw new Error(`fixture has no ${sel}`);
    return el;
  };
  return { doc, $ };
}

// Elements named by their id (else their tag and class), so a failure reads as names.
const name = (el: Element | null | undefined) =>
  el ? el.id || `${el.localName}.${el.className}` : null;
const shape = (found: Found | null) => {
  if (!found) return null;
  if (found.kind === "element")
    return { kind: found.kind, els: found.matches.map((m) => name(m.el)) };
  if (found.kind === "text") return { kind: found.kind, holder: name(found.holder) };
  return { kind: found.kind, anchor: found.anchor && name(found.anchor.el) };
};

const at = (line: number, column: number): UiSource => ({
  file: FILE,
  line,
  column,
  component: "files",
  via: "vue-tracer",
});
const NOWHERE: Rect = { x: 0, y: 0, width: 0, height: 0 };
// An element as the annotation recorded it.
const rec = (over: Partial<UiMarkElement>): UiMarkElement => ({
  selector: "#gone",
  tag: "button",
  rect: NOWHERE,
  ...over,
});
const box = (x: number, y = 0): Rect => ({ x, y, width: 80, height: 24 });

test("an element is found where its source says it was rendered before its selector is tried", () => {
  // The agent added a second Save above it: its positional selector now names the new one, which
  // shows the same text, but the template still renders it at line 20.
  const { doc } = page(`
    <div><button id="added" data-at="12:7">Save</button></div>
    <div><button id="saved" data-at="20:7">Save</button></div>`);
  const save = rec({ selector: "div:nth-of-type(1) > button", text: "Save" });
  assert.equal(name(findElement(doc, { ...save, source: at(20, 7) })), "saved");
  assert.equal(name(findElement(doc, save)), "added", "without a source, the selector decides");
});

test("a template place that renders several elements (a v-for) leaves the choice to the selector", () => {
  const { doc } = page(`
    <ul><li><button id="r1" data-at="30:9">Edit</button></li>
    <li><button id="r2" data-at="30:9">Edit</button></li></ul>`);
  const edit = rec({ selector: "li:nth-of-type(2) > button", text: "Edit", source: at(30, 9) });
  assert.equal(name(findElement(doc, edit)), "r2");
});

test("an element moved within its template is found by its tag and text", () => {
  // Line 20 renders nothing any more, and its old id is gone: Save is at line 24 now.
  const { doc, $ } = page(`<div><button id="moved" data-at="24:7">Save</button></div>`);
  const save = rec({ selector: "#save", text: "Save", source: at(20, 7) });
  assert.equal(name(findElement(doc, save)), "moved");
  $("#moved").remove();
  assert.equal(name(findElement(doc, save)), null, "deleted: unplaced");
});

test("a selector that now matches an element with other text is no match", () => {
  const { doc, $ } = page(`<button id="save">Delete</button><button id="moved">Save</button>`);
  const save = rec({ selector: "#save", text: "Save" });
  assert.equal(name(findElement(doc, save)), "moved", "found by its tag and text instead");
  $("#moved").remove();
  assert.equal(name(findElement(doc, save)), null, "never pinned to Delete");
});

test("an element relabelled where it was rendered is unplaced, not pinned to the old text elsewhere", () => {
  const { doc } = page(`
    <button id="save" data-at="20:7">Submit</button>
    <button id="other" data-at="40:7">Save</button>`);
  const save = rec({ selector: "#gone", text: "Save", source: at(20, 7) });
  assert.equal(name(findElement(doc, save)), null);
  assert.equal(
    name(findElement(doc, { ...save, selector: "#other" })),
    null,
    "not by a selector that names the other one either",
  );
});

test("a component's file without a line finds an element only by checking what it shows", () => {
  // The component's icon button was deleted; its one remaining button is another one.
  const component = { file: FILE, component: "files", via: "vue-file" as const };
  const { doc } = page(`<button data-in id="other" aria-haspopup="menu"><svg></svg></button>`);
  const icon = rec({ selector: "body > button:nth-of-type(2)", source: component });
  assert.equal(name(findElement(doc, icon)), null);

  // With text to check, the component's file tells two Saves apart.
  const two = page(`<button data-in id="mine">Save</button><button id="theirs">Save</button>`);
  const save = rec({ text: "Save", source: component });
  assert.equal(name(findElement(two.doc, save)), "mine");
  assert.equal(name(findElement(two.doc, { ...save, source: undefined })), null);
});

test("the selector it was captured with comes before its tag and text", () => {
  const { doc } = page(`
    <button id="keep" class="btn">Save</button>
    <button class="btn">Save</button>`);
  assert.equal(name(findElement(doc, rec({ selector: "#keep", text: "Save" }))), "keep");
  assert.equal(
    name(findElement(doc, rec({ text: "Save", classes: ["btn"] }))),
    null,
    "two buttons show Save and nothing tells them apart: no guess",
  );
  assert.equal(
    name(findElement(doc, rec({ selector: "button", text: "Save" }))),
    null,
    "a selector that now matches two elements finds neither",
  );
});

test("several elements showing its tag and text are narrowed by class, then position", () => {
  const { doc } = page(`
    <button id="p" class="primary" data-box="0 0 80 24">Save</button>
    <button id="g1" class="ghost" data-box="100 0 80 24">Save</button>
    <button id="g2" class="ghost" data-box="200 0 80 24">Save</button>`);
  const save = (over: Partial<UiMarkElement>) =>
    name(findElement(doc, rec({ text: "Save", ...over })));
  assert.equal(save({ classes: ["primary", "w-full"] }), "p");
  assert.equal(save({ classes: ["ghost"], rect: box(204, 2) }), "g2");
  assert.equal(save({ classes: ["ghost"], rect: box(500) }), null, "neither sits where it was");
  assert.equal(save({ classes: ["restyled"], rect: box(96) }), "g1", "no class in common");
  assert.equal(save({ rect: box(50) }), null, "overlapping two of them about equally");
});

test("without text an element must still have its accessible name", () => {
  const { doc } = page(`
    <button id="close" aria-label="Close"><svg></svg></button>
    <button id="open" aria-label="Open"><svg></svg></button>`);
  const close = rec({ selector: "body > button:nth-of-type(2)", name: "Close" });
  assert.equal(name(findElement(doc, close)), "close", "the selector names Open now");
});

test("with nothing to check, only its source or a selector naming a handle finds it", () => {
  const { doc } = page(`
    <img id="logo" class="logo" src="a.png" data-at="3:5"><img id="banner" src="b.png">`);
  const img = (over: Partial<UiMarkElement>) =>
    name(findElement(doc, rec({ tag: "img", ...over })));
  assert.equal(img({ selector: "img.logo" }), "logo");
  assert.equal(img({ selector: "body > img:nth-of-type(2)" }), null);
  assert.equal(img({ selector: "body > img:nth-of-type(2)", source: at(3, 5) }), "logo");
  assert.equal(
    img({ selector: "img.logo", tag: "button" }),
    null,
    "a selector now matching another kind of element is no match",
  );
});

test("an element target is found by its first element, and the others where they're found", () => {
  const { doc } = page(`<button id="save">Save</button><button id="cancel">Cancel</button>`);
  const save = rec({ selector: "#save", text: "Save" });
  const cancel = rec({ selector: "#cancel", text: "Cancel" });
  const gone = rec({ selector: "#help", text: "Help" });
  assert.deepEqual(shape(refind(doc, { kind: "element", elements: [save, gone, cancel] })), {
    kind: "element",
    els: ["save", "cancel"],
  });
  assert.equal(
    refind(doc, { kind: "element", elements: [gone, save, cancel] }),
    null,
    "its first element is gone: unplaced, whatever else is left",
  );
});

test("a region moves with the first of its elements still found, else stays where it was drawn", () => {
  const { doc } = page(`<button id="save" data-box="100 50 80 24">Save</button>`);
  const rect = { x: 90, y: 10, width: 120, height: 60 };
  const save = rec({ selector: "#save", text: "Save", rect: box(100, 20) });
  const gone = rec({ selector: "#help", text: "Help" });
  const found = refind(doc, { kind: "region", rect, elements: [gone, save] });
  assert.deepEqual(shape(found), { kind: "region", anchor: "save" });
  assert.deepEqual(located(found!)?.boxes, [{ x: 90, y: 40, width: 120, height: 60 }]);
  for (const elements of [[gone], []]) {
    const left = refind(doc, { kind: "region", rect, elements });
    assert.deepEqual(shape(left), { kind: "region", anchor: null }, "still placed");
    assert.deepEqual(located(left!)?.boxes, [rect]);
  }
});

test("a text target is found by the element holding its quote, while it's still there", () => {
  const { doc, $ } = page(`
    <div class="card"><p id="note">Due: Date recieved soon</p></div>
    <p class="other">Something else</p>`);
  const holder = rec({ tag: "p", selector: "#note", text: "Due: Date recieved soon" });
  const quote = "Date recieved";
  const text = (element: UiMarkElement) => shape(refind(doc, { kind: "text", quote, element }));
  assert.deepEqual(text(holder), { kind: "text", holder: "note" });
  // The rest of its text changed, and so did its id: the quote alone finds it.
  $("#note").textContent = "Overdue: Date recieved";
  $("#note").id = "late";
  assert.deepEqual(text(holder), { kind: "text", holder: "late" });
  // Of the elements around the quote, the innermost holds it.
  const div = rec({ tag: "div", text: "Due: Date recieved soon" });
  assert.deepEqual(text(div), { kind: "text", holder: "div.card" });
  $("#late").textContent = "Date received";
  assert.equal(text(holder), null, "fixed: the quote is gone");
});

test("a found target stands while its elements are on the page and its quote in its holder", () => {
  const { doc, $ } = page(`<button id="save">Save</button><p id="note">Due soon</p>`);
  const button = refind(doc, {
    kind: "element",
    elements: [rec({ selector: "#save", text: "Save" })],
  })!;
  const text = refind(doc, {
    kind: "text",
    quote: "Due",
    element: rec({ tag: "p", selector: "#note", text: "Due soon" }),
  })!;
  assert.ok(stands(button) && stands(text));
  $("#save").replaceWith($("#save").cloneNode(true));
  assert.ok(!stands(button), "a re-rendered element is a new one: look again");
  assert.equal(located(button), null);
  $("#note").textContent = "Overdue";
  assert.ok(!stands(text));
});

test("an element patched in place to show something else no longer stands", () => {
  // A hot update moved Upload out of the toolbar: Vue reused its node for the next button.
  const { doc, $ } = page(`<div><button>Archive</button><button id="b2">Upload</button></div>`);
  const upload = rec({ selector: "div > button:nth-of-type(2)", text: "Upload" });
  const region = { x: 0, y: 0, width: 300, height: 40 };
  const button = refind(doc, { kind: "element", elements: [upload] })!;
  const box = refind(doc, { kind: "region", rect: region, elements: [upload] })!;
  assert.ok(stands(button) && stands(box));
  $("#b2").textContent = "Share";
  assert.ok(!stands(button), "connected, but showing Share");
  assert.ok(!stands(box));
  assert.equal(refind(doc, { kind: "element", elements: [upload] }), null);
});
