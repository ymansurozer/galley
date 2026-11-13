import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { renderDiagram } from "./diagrams";

test("agent node labels remain text, never markup or event handlers", () => {
  const window = new Window();
  const el = renderDiagram(
    'flowchart LR\n A["<img src=x onerror=alert(1)>"] --> B[Done]',
    window.document as unknown as Document,
  );
  assert.ok(el.querySelector("svg"));
  assert.equal(el.querySelector("img, image, foreignObject"), null);
  for (const node of el.querySelectorAll("*")) {
    assert.ok([...node.attributes].every((a) => !/^on/i.test(a.name)));
  }
  assert.match(el.textContent!, /Done/);
});

test("invalid Mermaid throws to the body's code fallback", () => {
  const window = new Window();
  assert.throws(() =>
    renderDiagram("this is not a diagram", window.document as unknown as Document),
  );
});

test("labels take the size the page gives, and the drawing is laid out for it", () => {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const source = "flowchart LR\n A[Queue message] --> B[Workflow run]";
  const small = renderDiagram(source, doc, 12);
  assert.match(small.innerHTML, /font:12px/);
  const width = (el: HTMLElement) => Number(el.querySelector("svg")!.getAttribute("width"));
  assert.ok(width(small) < width(renderDiagram(source, doc)), "smaller text, narrower boxes");
});
