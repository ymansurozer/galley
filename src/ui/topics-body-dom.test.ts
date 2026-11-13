import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import createDOMPurify from "dompurify";
import { sourceLine } from "./markdown-source";
import { diagramFit, diagramLoader, renderTopicBody } from "./topics-body-dom";

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

test("a lines fence becomes the block's place, with its source line and no code of its own", async () => {
  const { host, md } = fixture();
  await renderTopicBody(host, "Why.\n\n```lines\nsrc/a.ts:1-4\n```\n", md, () => {
    throw new Error("no diagram to load");
  });
  const place = host.querySelector<HTMLElement>(".topic-lines")!;
  assert.equal(place.dataset.line, "3");
  assert.equal(place.textContent, "");
  assert.equal(host.querySelector("pre"), null);
});

test("a drawing up to a third wider than its column is scaled to it; a wider one scrolls as drawn", async () => {
  // The topic's column is 656 px; a third over it is 874.67 px.
  const fitOf = async (drawn: number) => {
    const { host, md } = fixture();
    await renderTopicBody(host, "```mermaid\nflowchart LR\nA --> B\n```", md, async () => ({
      renderDiagram: (_source, doc) => {
        const wrap = doc.createElement("div");
        Object.defineProperty(wrap, "clientWidth", { value: 656 });
        wrap.innerHTML = `<svg class="pele" viewBox="0 0 ${drawn} 64" width="${drawn}" height="64"></svg>`;
        return wrap;
      },
    }));
    return (host.querySelector(".topic-diagram") as HTMLElement).dataset.fit;
  };
  assert.equal(await fitOf(600), "drawn");
  assert.equal(await fitOf(656), "drawn");
  assert.equal(await fitOf(697), "scaled");
  assert.equal(await fitOf(874), "scaled");
  assert.equal(await fitOf(875), "scrolled");
  assert.equal(await fitOf(1400), "scrolled");
});

test("a diagram whose column is not laid out yet, or that could not be drawn, stays as drawn", () => {
  assert.equal(diagramFit(697, 0), "drawn");
  assert.equal(diagramFit(0, 656), "drawn");
});
