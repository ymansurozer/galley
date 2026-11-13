import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { renderTopicBody } from "./topics-body-dom";

const host = () => new Window().document.createElement("div") as unknown as HTMLElement;
test("Mermaid gets a placeholder without entering the markdown sanitiser", async () => {
  const el = host();
  const seen: string[] = [];
  let finish!: (value: { renderDiagram: (source: string) => HTMLElement }) => void;
  const loading = new Promise<{ renderDiagram: (source: string) => HTMLElement }>((resolve) => {
    finish = resolve;
  });
  const source = 'flowchart LR\nA["<img src=x onerror=alert(1)>"] --> B\n';
  const done = renderTopicBody(
    el,
    "Before\n```mermaid\n" + source + "```\nAfter",
    (s) => {
      seen.push(s);
      return s;
    },
    () => loading,
  );
  assert.deepEqual(seen, ["Before\n", "After"]);
  assert.match(el.querySelector(".topic-diagram")!.textContent!, /Loading diagram/);
  assert.equal(el.querySelector("img"), null);
  finish({
    renderDiagram: () => {
      const diagram = host();
      diagram.textContent = "Drawn";
      return diagram;
    },
  });
  await done;
  assert.match(el.textContent!, /Drawn/);
});

test("a load failure preserves source as code and leaves following prose usable", async () => {
  const el = host();
  await renderTopicBody(
    el,
    "```mermaid\n<bad>\n```\nAfter",
    (s) => s,
    async () => {
      throw new Error("network");
    },
  );
  assert.equal(el.querySelector("pre code")!.textContent, "<bad>\n");
  assert.match(el.textContent!, /Diagram could not be drawn/);
  assert.match(el.textContent!, /After/);
  assert.equal(el.querySelector("bad"), null);
});
