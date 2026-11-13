import { parseTopicBody } from "./topics-body-derive";

type Diagrams = { renderDiagram: (source: string, doc: Document) => HTMLElement };
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
    if (block.kind !== "mermaid") continue;
    const fence = host.querySelector(`pre[data-line="${block.line}"]`);
    // The markdown highlighter may not be ready yet; its ready callback redraws the page.
    if (!fence) continue;
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
        el.replaceChildren(diagrams.renderDiagram(source, doc));
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
