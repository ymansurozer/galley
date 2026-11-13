import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import createDOMPurify from "dompurify";
import { sourceLine } from "./markdown-source";
import { diagramLoader, renderTopicBody } from "./topics-body-dom";

function fixture() {
  const window = new Window();
  const host = window.document.createElement("div") as unknown as HTMLElement;
  const renderer = new MarkdownIt({ html: false }).use(footnote).use(sourceLine);
  const purify = createDOMPurify(window as never);
  return { host, md: (s: string) => purify.sanitize(`<div>${renderer.render(s)}</div>`) };
}

test("a sanitised Mermaid fence becomes a placeholder with its source line", async () => {
  const { host, md } = fixture();
  const seen: string[] = [];
  let finish!: (value: { renderDiagram: (source: string) => HTMLElement }) => void;
  const loading = new Promise<{ renderDiagram: (source: string) => HTMLElement }>((resolve) => {
    finish = resolve;
  });
  const body =
    'Before\n\n```mermaid\nflowchart LR\nA["<img src=x onerror=alert(1)>"] --> B\n```\nAfter';
  const done = renderTopicBody(
    host,
    body,
    (s) => {
      seen.push(s);
      return md(s);
    },
    () => loading,
  );
  assert.deepEqual(seen, [body]);
  assert.match(host.querySelector(".topic-diagram")!.textContent!, /Loading diagram/);
  assert.equal((host.querySelector(".topic-diagram") as HTMLElement).dataset.line, "3");
  assert.equal(host.querySelector("img"), null);
  finish({
    renderDiagram: () => {
      const diagram = host.ownerDocument.createElement("div");
      diagram.textContent = "Drawn";
      return diagram;
    },
  });
  await done;
  assert.match(host.textContent!, /Drawn/);
});

test("reference links and footnotes resolve across a diagram in one markdown document", async () => {
  const { host, md } = fixture();
  await renderTopicBody(
    host,
    "[Read more][ref] and a note[^one].\n\n```mermaid\nA --> B\n```\n\nAnother note[^two].\n\n[ref]: https://example.com/reference\n[^one]: First note\n[^two]: Second note",
    md,
    async () => {
      throw new Error("network");
    },
  );
  assert.equal(
    host.querySelector('a[href="https://example.com/reference"]')?.textContent,
    "Read more",
  );
  assert.equal(host.querySelectorAll(".footnotes li").length, 2);
  const ids = [...host.querySelectorAll("[id]")].map((el) => el.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a load failure preserves source as code and leaves following prose usable", async () => {
  const { host, md } = fixture();
  await renderTopicBody(host, "```mermaid\n<bad>\n```\nAfter", md, async () => {
    throw new Error("network");
  });
  assert.equal(host.querySelector("pre code")!.textContent, "<bad>\n");
  assert.match(host.textContent!, /Diagram could not be drawn/);
  assert.match(host.textContent!, /After/);
  assert.equal(host.querySelector("bad"), null);
});

test("a failed bundle import retries on the next load and caches success", async () => {
  let attempts = 0;
  const diagrams = { renderDiagram: () => fixture().host };
  const load = diagramLoader(async () => {
    if (++attempts === 1) throw new Error("network");
    return diagrams;
  });
  const failed = load();
  assert.equal(load(), failed);
  await assert.rejects(failed, /network/);
  assert.equal(await load(), diagrams);
  assert.equal(await load(), diagrams);
  assert.equal(attempts, 2);
});
