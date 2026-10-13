import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { esc } from "./html";
import type { UiAnnotationRecord, UiElement } from "./types";
import { sourcePlace } from "./uilane-derive";
import { composerHead, pageHead, quoteLine, rowLine, shotLink, sourceLink } from "./uilane-dom";

// What a hostile app page might send as a selector, a route or a title: a quote that would end an
// attribute in string-built HTML, then a handler that fires in the desk's origin.
const HOSTILE = `x" onmouseover="fetch('/api/reset',{method:'POST'})" data-x="`;

const doc = () => new Window().document as unknown as Document;

// Every attribute on the subtree, by name: an injected handler would show up here.
const attributeNames = (root: Element) =>
  [root, ...root.querySelectorAll("*")].flatMap((el) => el.getAttributeNames());

test("esc escapes both quotes, so string-built attributes can't be broken out of", () => {
  assert.equal(
    esc(`<a href="x">it's</a> & co`),
    "&lt;a href=&quot;x&quot;&gt;it&#39;s&lt;/a&gt; &amp; co",
  );
  const d = doc();
  const div = d.createElement("div");
  div.innerHTML = `<span title="${esc(HOSTILE)}">${esc(HOSTILE)}</span>`;
  const span = div.querySelector("span")!;
  assert.deepEqual(span.getAttributeNames(), ["title"]);
  assert.equal(span.getAttribute("title"), HOSTILE);
  assert.equal(span.textContent, HOSTILE);
});

test("a page head with a hostile route and title renders them as text", () => {
  const d = doc();
  const head = pageHead(d, { route: `/x?${HOSTILE}`, title: HOSTILE, open: [], resolved: [] });
  assert.deepEqual(attributeNames(head).sort(), ["class", "class", "class", "data-route", "title"]);
  assert.equal(head.dataset.route, `/x?${HOSTILE}`);
  assert.equal(head.title, `${HOSTILE}\n/x?${HOSTILE}`);
  assert.ok(head.textContent!.includes(`x" onmouseover=`), "the name shows the text as typed");
});

test("the composer head shows a hostile selector and name as text", () => {
  const d = doc();
  const el: UiElement = {
    selector: HOSTILE,
    tag: "button",
    role: "button",
    name: HOSTILE,
    rect: { x: 0, y: 0, width: 1, height: 1 },
  };
  let cancelled = false;
  const head = composerHead(
    d,
    { kind: "element", elements: [el] },
    "/x",
    3,
    () => (cancelled = true),
  );
  assert.ok(!attributeNames(head).some((n) => n.startsWith("on") || n === "data-x"));
  assert.equal(head.querySelector(".uc-target")!.getAttribute("title"), HOSTILE);
  assert.equal(head.querySelector(".uc-target")!.textContent, `button · "${HOSTILE}"`);
  head.querySelector<HTMLButtonElement>(".uc-close")!.click();
  assert.ok(cancelled);
});

test("the composer head names a region, a page and several elements, with their selectors or route", () => {
  const d = doc();
  const el = (selector: string): UiElement => ({
    selector,
    tag: "button",
    rect: { x: 0, y: 0, width: 1, height: 1 },
  });
  const target = (head: HTMLElement) => head.querySelector(".uc-target")!;
  const several = composerHead(
    d,
    { kind: "element", elements: [el("#a"), el(HOSTILE)] },
    "/x",
    1,
    () => {},
  );
  assert.equal(target(several).textContent, "button");
  assert.equal(several.querySelector(".uc-more")?.textContent, "+1 more");
  assert.equal(target(several).getAttribute("title"), `#a\n${HOSTILE}`);
  const rect = { x: 0, y: 0, width: 200, height: 80 };
  const region = composerHead(d, { kind: "region", rect, elements: [el("#a")] }, "/x", 2, () => {});
  assert.equal(target(region).textContent, "Region 200 × 80 · 1 element");
  assert.equal(region.querySelector(".uc-more"), null);
  const page = composerHead(d, { kind: "page" }, `/x?${HOSTILE}`, 3, () => {});
  assert.equal(target(page).textContent, "Whole page");
  assert.equal(target(page).getAttribute("title"), `/x?${HOSTILE}`);
  assert.ok(!attributeNames(page).some((n) => n.startsWith("on") || n === "data-x"));
});

test("the composer quotes a hostile text selection as text", () => {
  const quote = quoteLine(doc(), `<img src=x onerror="alert(1)"> ${HOSTILE}`);
  assert.equal(quote.textContent, `“<img src=x onerror="alert(1)"> ${HOSTILE}”`);
  assert.equal(quote.querySelector("img"), null);
  assert.deepEqual(attributeNames(quote), ["class"]);
});

test("a source link shows a hostile path and component as text, and opens the editor", () => {
  const d = doc();
  // A file name can't hold a slash, so this one breaks out with a quote and a handler alone.
  const evil = `x" onclick="alert(1)" data-x="`;
  const place = sourcePlace(
    { file: `/r/app/${evil}.vue`, line: 3, component: HOSTILE, via: "vue-tracer" },
    "/r",
  );
  const opened: Array<[string, number]> = [];
  const link = sourceLink(d, place, "ann-src", (path, line) => opened.push([path, line]));
  assert.equal(link.localName, "button");
  assert.deepEqual(attributeNames(link).sort(), ["class", "title"]);
  assert.equal(link.textContent, `app/${evil}.vue:3`);
  assert.equal(link.title, `${HOSTILE}\napp/${evil}.vue:3`);
  link.click();
  assert.deepEqual(opened, [[`app/${evil}.vue`, 3]]);
  // A file outside the repo can't be opened: plain text.
  const outside = sourceLink(
    d,
    sourcePlace({ file: "/opt/x.vue", via: "vue-file" }, "/r"),
    "s",
    () => assert.fail("not openable"),
  );
  assert.equal(outside.localName, "span");
});

test("a row shows the body's first line as text", () => {
  const d = doc();
  const a: UiAnnotationRecord = {
    id: "a1",
    number: 4,
    intent: "change",
    status: "open",
    placement: "placed",
    page: { url: "http://localhost:3000/", route: "/", viewport: { width: 1, height: 1, dpr: 1 } },
    target: { kind: "element", elements: [] },
    comments: [
      {
        id: "m1",
        role: "user",
        body: `<img src=x onerror=alert(1)>`,
        createdAt: "t",
        updatedAt: "t",
      },
    ],
  };
  const row = rowLine(d, a, true);
  assert.equal(row.querySelector("img"), null);
  assert.equal(row.querySelector(".ann-body")!.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(row.className, "ann-row k-change sel");
  assert.equal(
    rowLine(d, { ...a, intent: "question" }, false).className,
    "ann-row k-question",
    "a question's numeral is tinted as one",
  );
});

test("a row's screenshot reads capturing…, then opens the stored pair, or says the capture failed", () => {
  const d = doc();
  const none = () => assert.fail("only a stored pair opens");
  const capturing = shotLink(d, "capturing", undefined, none);
  assert.equal(capturing.localName, "span");
  assert.equal(capturing.textContent, "capturing…");

  let opened = 0;
  const stored = shotLink(d, "stored", undefined, () => opened++);
  assert.equal(stored.localName, "button");
  assert.equal(stored.textContent, "Screenshot");
  stored.click();
  assert.equal(opened, 1);

  // The reason can be the bridge's error, which the app page wrote.
  const failed = shotLink(d, "failed", HOSTILE, none);
  assert.equal(failed.localName, "span");
  assert.equal(failed.textContent, "capture failed");
  assert.deepEqual(attributeNames(failed).sort(), ["class", "title"]);
  assert.equal(failed.title, `No screenshot: ${HOSTILE}`);
});
