import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import { sourceLine } from "./markdown-source";
import { renderTopicBody } from "./topics-body-dom";
import { estimateMeasure } from "./map-check";
import { layoutMap, type MapStage } from "./map-derive";
import { mapHtml, mapListHtml } from "./map-dom";
import {
  chipThread,
  markMap,
  markParts,
  partElement,
  placeDroppedThreads,
  topicBlockersChip,
  underPart,
} from "./topicthreads-dom";
import type { GuideLink, TopicThread } from "../types";
import { topicParts } from "./topicthreads-derive";
// The desk's list of a body's parts (what its quotes and threads are keyed by), read here to show
// the page finds the same blocks.
import { bodyBlocks } from "../topicthreads";

const BODY = [
  "Intro para.", // 1
  "",
  "- one", // 3
  "- two", // 4
  "  - nested", // 5
  "- three", // 6
  "",
  "| a | b |", // 8
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```ts", // 12
  "const x = 1;",
  "```",
  "",
  "```mermaid", // 16
  "graph TD; A-->B",
  "```",
  "",
  "---",
  "",
  "1. first", // 22
].join("\n");

async function page(body: string, flag?: string) {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const renderer = new MarkdownIt({ html: false }).use(footnote).use(sourceLine);
  const host = doc.createElement("article");
  host.innerHTML = `<h1 class="topic-title">T</h1><p class="topic-recorded">R</p><div class="topic-body md"></div>${flag ? `<div class="topic-flag">${flag}</div>` : ""}`;
  const drawn = doc.createElement("div");
  drawn.textContent = "Drawn";
  await renderTopicBody(
    host.querySelector<HTMLElement>(".topic-body")!,
    body,
    // The renderer as the tab runs it, minus the sanitiser, which keeps these tags as they are.
    (s) => renderer.render(s),
    async () => ({ renderDiagram: () => drawn as never }),
  );
  return host;
}

test("the page's parts are the desk's body blocks: list items not lists, one each for a table, code and a diagram", async () => {
  const host = await page(BODY, "Careful");
  const lines = bodyBlocks(BODY).map((b) => b.line);
  const parts = topicParts(
    { id: "t", title: "T", recorded: "R", body: BODY, covers: [], flag: "x" },
    {
      blocks: [],
      lines: 0,
      coverHash: "h",
      bodyParts: lines,
    },
  );
  const marked = markParts(host, parts, null, new Set());
  assert.deepEqual([...marked.keys()], parts, "every part the desk lists is on the page");
  const shape = (part: string) => {
    const el = marked.get(part)!;
    if (el.tagName === "LI") return "li";
    const inner = el.lastElementChild as HTMLElement;
    return (
      inner.tagName.toLowerCase() + (inner.className ? `.${inner.className.split(" ")[0]}` : "")
    );
  };
  assert.deepEqual(parts.map(shape), [
    "h1.topic-title",
    "p.topic-recorded",
    "p",
    "li",
    "li",
    "li",
    "table",
    "pre",
    "div.topic-diagram",
    "li",
    "div.topic-flag",
  ]);
  // And nothing on the page that carries a source line and could be commented is left out: each
  // top-level block but a list and the rule, and each item of a top-level list.
  const body = host.querySelector(".topic-body")!;
  const stamped = [...body.querySelectorAll<HTMLElement>("[data-line]")].filter((el) => {
    if (["UL", "OL", "HR"].includes(el.tagName)) return false;
    const up = el.parentElement?.closest("[data-line]");
    return !up || (el.tagName === "LI" && up.parentElement === body);
  });
  assert.deepEqual(
    stamped.map((el) => Number(el.dataset.line)),
    lines,
  );
});

test("a part gets one gutter button, and what goes under it lands after it, or inside a list item", async () => {
  const host = await page("Para.\n\n- item");
  const marked = markParts(host, ["title", "body:1", "body:3"], "body:1", new Set(["body:3"]));
  for (const el of marked.values())
    assert.equal(el.querySelectorAll(":scope > .topic-gut").length, 1);
  assert.ok(marked.get("body:1")!.classList.contains("topic-cur"));
  assert.ok(marked.get("body:3")!.classList.contains("topic-has"));
  const under = underPart(marked.get("body:1")!);
  assert.equal(under, marked.get("body:1")!.nextElementSibling);
  assert.equal(underPart(marked.get("body:1")!), under, "one holder per part");
  const item = underPart(marked.get("body:3")!);
  assert.equal(item.parentElement, marked.get("body:3"));
  assert.equal(partElement(host, "body:99"), null);
});

test("the blockers chip lists a topic's requests as text", () => {
  const doc = new Window().document as unknown as Document;
  assert.equal(topicBlockersChip(doc, []), null);
  const chip = topicBlockersChip(doc, [
    { id: "a1", where: "Recorded", text: `<img onerror="x">` },
  ])!;
  assert.equal(chip.querySelector(".blockers-chip")!.textContent, "1 blocker");
  assert.equal(chip.querySelector("img"), null);
  assert.equal((chip.querySelector("[data-thread]") as HTMLElement).dataset.thread, "a1");
});

test("the Overview shows threads on dropped topics under their kept title, and no section without them", () => {
  const doc = new Window().document as unknown as Document;
  const overview = () => {
    const el = doc.createElement("div");
    el.innerHTML = `<div class="go-card">Summary</div><div class="go-card topics-end">Start</div>`;
    return el;
  };
  const thread = (id: string, title: string): TopicThread => ({
    id,
    target: { topic: `gone-${title}`, part: "title" },
    title,
    intent: "change",
    status: "open",
    comments: [],
  });
  const card = (t: TopicThread) => {
    const el = doc.createElement("div");
    el.className = "topic-thread";
    el.dataset.thread = t.id;
    return el;
  };
  const without = overview();
  placeDroppedThreads(without, [], card);
  assert.equal(without.querySelector(".topics-dropped"), null);
  const withThreads = overview();
  placeDroppedThreads(
    withThreads,
    [thread("a", "Old <b>one</b>"), thread("b", "Old <b>one</b>"), thread("c", "Two")],
    card,
  );
  const section = withThreads.querySelector(".topics-dropped")!;
  assert.equal(
    section.querySelector("h2")!.textContent,
    "Requests on topics no longer in the guide",
  );
  assert.deepEqual(
    [...section.querySelectorAll(".topics-dropped-topic")].map((g) => [
      g.querySelector("h3")!.textContent,
      [...g.querySelectorAll("[data-thread]")].map((c) => (c as HTMLElement).dataset.thread),
    ]),
    [
      ["Old <b>one</b>", ["a", "b"]],
      ["Two", ["c"]],
    ],
  );
  assert.equal(
    section.nextElementSibling?.classList.contains("topics-end"),
    true,
    "the way in stays last",
  );
});

// ── The Overview's map ───────────────────────────────────────────────────────────────────────────

// Four groups in three stages: api feeds store and (skipping past store's stage) ui, store feeds ui,
// and ui links back to api (a note).
const MAP_STAGES: MapStage[] = [
  { id: "in", label: "In", groups: [{ id: "api", title: "API" }] },
  {
    id: "mid",
    label: "Mid",
    groups: [
      { id: "store", title: "Store" },
      { id: "cache", title: "Cache" },
    ],
  },
  { id: "out", label: "Out", groups: [{ id: "ui", title: "UI" }] },
];
const MAP_LINKS: GuideLink[] = [
  { from: "api", to: "store", label: "writes" },
  { from: "store", to: "ui", label: "serves" },
  { from: "ui", to: "api", label: "retries" },
];

function overviewMap() {
  const doc = new Window().document as unknown as Document;
  const host = doc.createElement("section");
  const layout = layoutMap(MAP_STAGES, MAP_LINKS, estimateMeasure())!;
  host.innerHTML = mapHtml(layout) + mapListHtml(MAP_STAGES, MAP_LINKS);
  return host;
}
const kinds = (el: Element | null) =>
  ["map-ask", "map-change"].filter((c) => el?.classList.contains(c));

test("a box or a link with an open thread is tinted: a question blue, a change request orange", () => {
  const host = overviewMap();
  markMap(
    host,
    new Map([
      ["group:api", "question"],
      ["group:store", "change"],
      ["link:store>ui", "change"],
      ["link:ui>api", "question"],
    ]),
  );
  const box = (id: string) => host.querySelector(`.map-box[data-group="${id}"]`);
  assert.deepEqual(kinds(box("api")), ["map-ask"]);
  assert.deepEqual(kinds(box("store")), ["map-change"]);
  assert.deepEqual(kinds(box("ui")), []);
  const link = host.querySelector('.map-link[data-from="store"][data-to="ui"]');
  assert.deepEqual(kinds(link), ["map-change"]);
  assert.deepEqual(kinds(host.querySelector('.map-label[data-from="store"]')), ["map-change"]);
  assert.deepEqual(kinds(host.querySelector('.map-link[data-from="api"]')), []);
  assert.deepEqual(kinds(host.querySelector(".map-note")), ["map-ask"], "a link back is its note");
  // The narrow list shows the same tints, on its rows and its feeds.
  assert.deepEqual(kinds(host.querySelector('.map-list-row[data-group="store"]')), ["map-change"]);
  assert.deepEqual(kinds(host.querySelector('.map-list-feed[data-from="store"]')), ["map-change"]);
  assert.deepEqual(kinds(host.querySelector('.map-list-feed[data-from="api"]')), []);
});

test("each box and list row takes a comment button, and each link a hit area, its label, note and feed", () => {
  const host = overviewMap();
  markMap(host, new Map());
  const guts = (sel: string) =>
    [...host.querySelectorAll<HTMLElement>(sel)].map((el) => el.dataset.gut);
  assert.deepEqual(guts(".map-box > .map-cm"), ["group:api", "group:store", "group:cache", "group:ui"]);
  assert.deepEqual(guts(".map-list-row > .map-cm").length, 4);
  // A drawn link's wide invisible line, inside its group so pointing at it is pointing at the link.
  assert.deepEqual(guts(".map-link > .map-hit"), ["link:api>store", "link:store>ui"]);
  assert.deepEqual(guts(".map-label"), ["link:api>store", "link:store>ui"]);
  assert.deepEqual(guts(".map-note"), ["link:ui>api"]);
  assert.deepEqual(guts(".map-list-feed"), ["link:api>store", "link:store>ui", "link:ui>api"]);
});

test("a thread under the map carries a chip naming what it is about, and says where it was", () => {
  const doc = new Window().document as unknown as Document;
  const card = doc.createElement("div");
  card.innerHTML = `<div class="comment-box"><div class="tc-head"><span class="tc-kind">Question</span><span class="tc-state">· was on API</span></div></div>`;
  chipThread(card, "group:a<b>", "Odd <title>");
  const chip = card.querySelector(".tc-head > .topic-anchor")!;
  assert.equal(chip.textContent, "Odd <title>");
  assert.equal(chip.previousElementSibling?.className, "tc-kind", "the chip follows the kind");
  assert.equal(card.dataset.mapPart, "group:a<b>", "pointing at the thread names its part");
});
