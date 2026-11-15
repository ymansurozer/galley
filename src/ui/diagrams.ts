import { render } from "pele";

// Only Pele's escaped output enters this path, never the raw Mermaid source.
// Links and images are disabled: labels belong in SVG text nodes. `fontSize`: the text size of the
// page around it, so labels read at the body's size; Pele lays the boxes out for it.
export function renderDiagram(
  source: string,
  doc: Document = document,
  fontSize?: number,
): HTMLElement {
  const el = doc.createElement("div");
  const { svg } = render(source, {
    links: false,
    images: false,
    responsive: false,
    ...(fontSize && { fontSize }),
  });
  el.innerHTML = svg;
  return el;
}
