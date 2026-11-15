import { parseTopicBody } from "./topics-body-derive";

type Diagrams = {
  renderDiagram: (source: string, doc: Document, fontSize?: number) => HTMLElement;
};
// A runtime URL keeps Pele out of the main bundle. Share in-flight and successful loads,
// but let a later body retry a transient failure.
export function diagramLoader(importBundle: () => Promise<Diagrams>) {
  let bundle: Promise<Diagrams> | undefined;
  return () =>
    (bundle ??= importBundle().catch((error) => {
      bundle = undefined;
      throw error;
    }));
}
const loadDiagrams = diagramLoader(() => {
  const url = "/diagrams.js";
  return import(url);
});

// How a diagram drawn `drawn` px wide sits in a column `column` px wide: as drawn when it fits;
// scaled down to the column, keeping its shape, when it is wider by up to a third, so a small
// diagram needs no sideways scroll; beyond that as drawn, scrolling sideways, so the text of a large
// diagram stays readable. A column not laid out yet (0) leaves it as drawn.
export function diagramFit(drawn: number, column: number): "drawn" | "scaled" | "scrolled" {
  if (!(column > 0) || !(drawn > column)) return "drawn";
  return drawn * 3 <= column * 4 ? "scaled" : "scrolled";
}

// Mark a diagram's place with how its drawing fits, from the drawing's own width (Pele's width
// attribute, which the style that scales it leaves alone) and its wrapper's, which is the column.
function fitDiagram(el: Element) {
  const svg = el.querySelector("svg");
  if (!svg) return;
  const fit = diagramFit(Number(svg.getAttribute("width")), svg.parentElement?.clientWidth ?? 0);
  el.setAttribute("data-fit", fit);
}

// The column changes width with the window, so a drawn diagram is fitted again when its place
// resizes, and let go once it has left the page (its size drops to nothing).
let resized: ResizeObserver | undefined;
function watchFit(el: Element) {
  fitDiagram(el);
  if (typeof ResizeObserver === "undefined") return;
  resized ??= new ResizeObserver((entries) => {
    for (const { target } of entries)
      if (target.isConnected) fitDiagram(target);
      else resized?.unobserve(target);
  });
  resized.observe(el);
}

export async function renderTopicBody(
  host: HTMLElement,
  body: string,
  md: (source: string) => string,
  load: () => Promise<Diagrams> = loadDiagrams,
): Promise<void> {
  const doc = host.ownerDocument;
  const pending: Array<{ el: HTMLElement; source: string }> = [];
  // References and footnotes belong to the whole document, even across special fences.
  // md returns sanitised HTML; only then replace the source-stamped fence elements.
  host.innerHTML = md(body);
  for (const block of parseTopicBody(body)) {
    // An options block is drawn by its topic's page (topicthreads.ts).
    if (block.kind !== "mermaid" && block.kind !== "lines") continue;
    const fence = host.querySelector(`pre[data-line="${block.line}"]`);
    // The markdown highlighter may not be ready yet; its ready callback redraws the page.
    if (!fence) continue;
    // A line block's place, which topics-lines.ts fills with the diff.
    if (block.kind === "lines") {
      const el = doc.createElement("div");
      el.className = "topic-lines";
      el.dataset.line = String(block.line);
      fence.replaceWith(el);
      continue;
    }
    const el = doc.createElement("div");
    el.className = "topic-diagram";
    el.dataset.line = String(block.line);
    el.setAttribute("aria-busy", "true");
    el.textContent = "Loading diagram…";
    fence.replaceWith(el);
    pending.push({ el, source: block.text });
  }
  if (!pending.length) return;
  await Promise.all(
    pending.map(async ({ el, source }) => {
      try {
        const diagrams = await load();
        // Drawn at the body's text size, read where it will sit (Pele's own default is larger).
        const size = parseFloat(doc.defaultView?.getComputedStyle(el).fontSize ?? "");
        el.replaceChildren(diagrams.renderDiagram(source, doc, size > 0 ? size : undefined));
        watchFit(el);
      } catch {
        const notice = doc.createElement("p");
        notice.className = "topic-diagram-notice";
        notice.textContent = "Diagram could not be drawn. Showing Mermaid source.";
        const pre = doc.createElement("pre");
        const code = doc.createElement("code");
        code.textContent = source;
        pre.append(code);
        el.replaceChildren(notice, pre);
      } finally {
        el.removeAttribute("aria-busy");
      }
    }),
  );
}
