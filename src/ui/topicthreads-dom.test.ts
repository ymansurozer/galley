import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import { sourceLine } from "./markdown-source";
import { renderTopicBody } from "./topics-body-dom";
import { markParts, partElement, topicBlockersChip, underPart } from "./topicthreads-dom";
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
