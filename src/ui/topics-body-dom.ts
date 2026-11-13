import { parseTopicBody } from "./topics-body-derive";

type Diagrams = { renderDiagram: (source: string, doc: Document) => HTMLElement };
let bundle: Promise<Diagrams> | undefined;
function loadDiagrams(): Promise<Diagrams> {
  // A runtime URL keeps Pele out of the main bundle. Cache failures too: once per tab.
  const url = "/diagrams.js";
  return (bundle ??= import(url));
}

export async function renderTopicBody(
  host: HTMLElement,
  body: string,
  md: (source: string) => string,
  load: () => Promise<Diagrams> = loadDiagrams,
): Promise<void> {
  const doc = host.ownerDocument;
  const pending: Array<{ el: HTMLElement; source: string }> = [];
  host.replaceChildren();
  for (const block of parseTopicBody(body)) {
    if (block.kind === "markdown") {
      const template = doc.createElement("template");
      template.innerHTML = md(block.text);
      for (const el of template.content.querySelectorAll<HTMLElement>("[data-line]")) {
        el.dataset.line = String(Number(el.dataset.line) + block.line - 1);
      }
      host.append(template.content);
    } else {
      const el = doc.createElement("div");
      el.className = "topic-diagram";
      el.dataset.line = String(block.line);
      el.setAttribute("aria-busy", "true");
      el.textContent = "Loading diagram…";
      host.append(el);
      pending.push({ el, source: block.text });
    }
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
