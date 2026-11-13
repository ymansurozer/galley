import { render } from "pele";

// Only Pele's escaped output enters this path, never the raw Mermaid source.
// Links and images are disabled: labels belong in SVG text nodes.
export function renderDiagram(source: string, doc: Document = document): HTMLElement {
  const el = doc.createElement("div");
  const { svg } = render(source, { links: false, images: false, responsive: false });
  el.innerHTML = svg;
  return el;
}
