import type { UiAnnotationRecord, UiElement } from "./types";
import { firstLine, pageName, rowTitle, type PageGroup } from "./uilane-derive";

// The UI lane's nodes that carry page-sourced text: a page group's head (route, title), a row,
// and the floating composer's head (the picked element's selector and label). Built with
// textContent and properties, never innerHTML, so nothing the app page sent can become markup or
// a handler in the desk. Store-free, so a DOM-only test can build them.

function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

// One line per page: its name, the open count; title and route in the tooltip.
export function pageHead(doc: Document, g: PageGroup): HTMLButtonElement {
  const head = node(doc, "button", "ann-head");
  head.dataset.route = g.route;
  head.title = g.title ? `${g.title}\n${g.route}` : g.route;
  head.append(
    node(doc, "span", "ann-page-name", pageName(g.title, g.route)),
    node(doc, "span", "ann-count", g.open.length ? String(g.open.length) : ""),
  );
  return head;
}

// A row: the number (tinted by kind) and the body's first line; the tooltip carries the state.
export function rowLine(doc: Document, a: UiAnnotationRecord, selected: boolean): HTMLDivElement {
  const line = node(
    doc,
    "div",
    `ann-row k-change${a.status === "resolved" ? " resolved" : ""}${selected ? " sel" : ""}`,
  );
  line.dataset.annotation = a.id;
  line.title = rowTitle(a);
  line.append(
    node(doc, "span", "ann-num", String(a.number)),
    node(doc, "span", "ann-body", firstLine(a.comments[0]?.body ?? "")),
  );
  return line;
}

// The floating composer's head: the number the annotation will get, and what was picked.
export function composerHead(
  doc: Document,
  el: UiElement,
  number: number,
  cancel: () => void,
): HTMLDivElement {
  const head = node(doc, "div", "uc-head");
  const num = node(doc, "span", "uc-num", String(number));
  num.title = "The number it will get";
  const what = el.role ?? el.tag;
  const target = node(doc, "span", "uc-target", el.name ? `${what} · "${el.name}"` : what);
  target.title = el.selector;
  const close = node(doc, "button", "uc-close");
  close.title = "Cancel (Esc)";
  close.append(node(doc, "kbd", "", "Esc"));
  close.onclick = cancel;
  head.append(num, target, close);
  return head;
}
