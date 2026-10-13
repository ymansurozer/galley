import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Rect } from "../types";
import { findQuote, locate, regionElements, textTarget, togglePick } from "./targets";

// A fixture page whose elements have the boxes their `data-box="x y width height"` gives (happy-dom
// lays nothing out), and a hit test over those boxes: the last element in document order whose box
// holds the point, as a later sibling paints over an earlier one.
function page(html: string) {
  const { document } = new Window();
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
  const at = (px: number, py: number) => {
    const boxed = [...doc.body.querySelectorAll("[data-box]")].reverse();
    const hit = boxed.find((el) => {
      const r = el.getBoundingClientRect();
      return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
    });
    return hit ?? doc.body;
  };
  const $ = (sel: string) => {
    const el = doc.querySelector(sel);
    if (!el) throw new Error(`fixture has no ${sel}`);
    return el;
  };
  return { doc, at, $ };
}

const ids = (els: Element[]) => els.map((el) => el.id || el.localName);

test("a ⇧-click adds an element, a second one on it takes it out, and the 17th is refused", () => {
  const { doc } = page("");
  const els = Array.from({ length: 17 }, () => doc.createElement("div"));
  const picks: Element[] = [];
  for (const el of els.slice(0, 16)) assert.equal(togglePick(picks, el), true);
  assert.equal(togglePick(picks, els[16]!), false, "the 17th is refused");
  assert.equal(picks.length, 16);
  assert.ok(!picks.includes(els[16]!));
  assert.equal(togglePick(picks, els[3]!), true, "a picked element is taken out again");
  assert.equal(picks.length, 15);
  assert.equal(togglePick(picks, els[16]!), true, "and there's room again");
});

test("a region holds the meaningful elements wholly inside it, outermost first", () => {
  const { doc, at } = page(`
    <div id="card" data-box="0 0 400 300">
      <h3 id="title" data-box="10 10 200 20">Files</h3>
      <button id="upload" data-box="10 40 80 24"><svg data-box="14 44 16 16"></svg> Upload</button>
      <p id="intro" data-box="10 70 300 40">Some <b data-box="50 70 30 20">bold</b> text</p>
      <div id="wrapper" data-box="10 120 300 40"><span id="label" data-box="12 122 60 16">Label</span></div>
      <canvas id="chart" data-box="10 170 200 100"></canvas>
      <button id="outside" data-box="350 10 80 24">Outside</button>
      <a id="crossing" href="/x" data-box="300 200 200 20">Crossing</a>
    </div>`);
  const region: Rect = { x: 5, y: 5, width: 320, height: 280 };
  assert.deepEqual(ids(regionElements(doc, region, at)), [
    "title",
    "upload",
    "intro",
    "label",
    "chart",
  ]);
});

test("a region leaves out elements hidden under a layer over them", () => {
  const { doc, at } = page(`
    <button id="behind" data-box="10 10 80 24">Behind</button>
    <button id="beside" data-box="10 60 80 24">Beside</button>
    <div id="dialog" role="dialog" data-box="0 0 200 40"></div>`);
  // The dialog covers the first button; it's a landmark, but it isn't wholly inside the box.
  const region: Rect = { x: 5, y: 5, width: 100, height: 90 };
  assert.deepEqual(ids(regionElements(doc, region, at)), ["beside"]);
});

test("a region keeps at most 16 elements", () => {
  const buttons = Array.from(
    { length: 20 },
    (_, i) => `<button id="b${i}" data-box="${i * 20} 0 18 18">${i}</button>`,
  ).join("");
  const { doc, at } = page(buttons);
  const els = regionElements(doc, { x: 0, y: 0, width: 400, height: 20 }, at);
  assert.equal(els.length, 16);
  assert.deepEqual(ids(els).slice(0, 2), ["b0", "b1"]);
});

test("a region with nothing wholly inside is the element it sits in, and empty over bare page", () => {
  const { doc, at } = page(`
    <canvas id="chart" data-box="0 0 600 400"></canvas>
    <p id="long" data-box="0 500 600 200">A long paragraph <a id="link" href="/a" data-box="200 600 60 20">here</a></p>`);
  assert.deepEqual(ids(regionElements(doc, { x: 100, y: 100, width: 50, height: 50 }, at)), [
    "chart",
  ]);
  // Inside a link's box, the link: what a click there would pick.
  assert.deepEqual(ids(regionElements(doc, { x: 205, y: 602, width: 20, height: 10 }, at)), [
    "link",
  ]);
  assert.deepEqual(regionElements(doc, { x: 700, y: 0, width: 50, height: 50 }, at), []);
});

test("a text selection gives its quote, whitespace collapsed, and the element holding it", () => {
  const { doc, $ } = page(`
    <table><tr><th id="received">Date
        recieved</th><th>Visibility</th></tr></table>
    <p id="intro">Upload the <b>signed</b> copy, then <a id="link" href="/files">open the
      file list</a>.</p>`);
  const range = doc.createRange();
  range.selectNodeContents($("#received"));
  const header = textTarget(range);
  assert.equal(header?.kind, "text");
  assert.equal(header?.quote, "Date recieved");
  assert.equal(header?.element.selector, "#received");

  const across = doc.createRange();
  across.setStart($("#intro").firstChild!, 7); // "the …"
  across.setEnd($("#link").firstChild!, 8); // "… open the"
  const target = textTarget(across);
  assert.equal(target?.quote, "the signed copy, then open the");
  assert.equal(target?.element.selector, "#intro");

  // Text inside a link is the link's, as a click on it would pick the link.
  const inLink = doc.createRange();
  inLink.setStart($("#link").firstChild!, 0);
  inLink.setEnd($("#link").firstChild!, 4);
  assert.equal(textTarget(inLink)?.element.selector, "#link");
});

test("a text selection's quote is capped at 500 characters, and whitespace alone is no quote", () => {
  const { doc, $ } = page(`<p id="long">${"word ".repeat(200)}</p><p id="blank">   </p>`);
  const range = doc.createRange();
  range.selectNodeContents($("#long"));
  const quote = textTarget(range)?.quote ?? "";
  assert.equal(quote.length, 500);
  assert.ok(quote.endsWith("…"), "a cut quote says so");
  const blank = doc.createRange();
  blank.selectNodeContents($("#blank"));
  assert.equal(textTarget(blank), null);
});

test("a quote is found again in its element whatever its whitespace, and a cut one by its start", () => {
  const { $ } = page(`<p id="intro">Upload the <b>signed</b>
      copy, then open it.</p>`);
  assert.equal(findQuote($("#intro"), "the signed copy")?.toString(), "the signed\n      copy");
  assert.equal(
    findQuote($("#intro"), "signed copy, then op…")?.toString(),
    "signed\n      copy, then op",
  );
  assert.equal(findQuote($("#intro"), "unsigned"), null);
});

test("a mark is found where its target is now", () => {
  const { doc } = page(`
    <button id="save" data-box="100 50 80 24">Save</button>
    <button id="cancel" data-box="200 50 80 24">Cancel</button>
    <p id="note" data-box="0 100 300 20">Due soon</p>`);
  assert.deepEqual(locate(doc, { kind: "element", selectors: ["#gone", "#save", "#cancel"] }), {
    kind: "element",
    boxes: [
      { x: 100, y: 50, width: 80, height: 24 },
      { x: 200, y: 50, width: 80, height: 24 },
    ],
    anchor: doc.querySelector("#save"),
  });
  assert.equal(locate(doc, { kind: "element", selectors: ["#gone", "nav >"] }), null);

  // A region follows its anchor element: captured at y 20, the button is at y 50 now.
  const rect = { x: 90, y: 10, width: 120, height: 60 };
  const anchor = { selector: "#save", rect: { x: 100, y: 20, width: 80, height: 24 } };
  assert.deepEqual(locate(doc, { kind: "region", rect, anchor })?.boxes, [
    { x: 90, y: 40, width: 120, height: 60 },
  ]);
  assert.deepEqual(
    locate(doc, { kind: "region", rect, anchor: { ...anchor, selector: "#gone" } })?.boxes,
    [rect],
    "an anchor that's gone leaves the box where it was drawn",
  );
  assert.deepEqual(locate(doc, { kind: "region", rect })?.boxes, [rect]);

  assert.equal(locate(doc, { kind: "text", selector: "#note", quote: "Overdue" }), null);
  assert.equal(locate(doc, { kind: "text", selector: "#gone", quote: "Due" }), null);
});
