import type { UiAnnotationRecord, UiTarget } from "./types";
import {
  firstLine,
  pageName,
  rowTitle,
  targetElements,
  targetLabel,
  type PageGroup,
  type SourcePlace,
} from "./uilane-derive";

// The UI lane's nodes that carry page-sourced text: a page group's head (route, title), a row,
// the floating composer's head (the picked target's selectors and label) and its quote, and source
// links (the file and component the page named). Built with textContent and properties, never
// innerHTML, so nothing the app page sent can become markup or a handler in the desk. Store-free,
// so a DOM-only test can build them.

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
    `ann-row k-${a.intent}${a.status === "resolved" ? " resolved" : ""}${selected ? " sel" : ""}`,
  );
  line.dataset.annotation = a.id;
  line.title = rowTitle(a);
  line.append(
    node(doc, "span", "ann-num", String(a.number)),
    node(doc, "span", "ann-body", firstLine(a.comments[0]?.body ?? "")),
  );
  return line;
}

// The floating composer's head: the number the annotation will get, and what was picked, its
// tooltip the elements' selectors (the page's route for a page).
export function composerHead(
  doc: Document,
  picked: UiTarget,
  route: string,
  number: number,
  cancel: () => void,
): HTMLDivElement {
  const head = node(doc, "div", "uc-head");
  const num = node(doc, "span", "uc-num", String(number));
  num.title = "The number it will get";
  const target = node(doc, "span", "uc-target", targetLabel(picked));
  target.title =
    picked.kind === "page"
      ? route
      : targetElements(picked)
          .map((el) => el.selector)
          .join("\n");
  const close = node(doc, "button", "uc-close");
  close.title = "Cancel (Esc)";
  close.append(node(doc, "kbd", "", "Esc"));
  close.onclick = cancel;
  head.append(num, target, close);
  return head;
}

// The text a text annotation quotes, under the composer's head.
export const quoteLine = (doc: Document, quote: string) =>
  node(doc, "div", "uc-quote", `“${quote}”`);

// Where an annotation's screenshots stand: being captured and uploaded, stored, or not stored
// (its capture failed, in this tab or in one since closed or reloaded).
export type ShotStatus = "capturing" | "stored" | "failed";

// The screenshot part of an expanded row's context line: a quiet "capturing…", then a link that
// enlarges the stored pair, or a quiet failure note whose tooltip says why when the tab knows. The
// reason can come from the app page (the bridge's error), so it's only ever text.
export function shotLink(
  doc: Document,
  status: ShotStatus,
  reason: string | undefined,
  open: () => void,
): HTMLElement {
  if (status === "stored") {
    const link = node(doc, "button", "ann-shot", "Screenshot");
    link.title = "Enlarge the screenshot";
    link.onclick = open;
    return link;
  }
  if (status === "capturing") return node(doc, "span", "ann-shot", "capturing…");
  const note = node(doc, "span", "ann-shot", "capture failed");
  note.title = reason
    ? `No screenshot: ${reason}`
    : "No screenshot was saved; the annotation is sent without one";
  return note;
}

// A source's `file:line`, opening the editor there; plain text when the file isn't in the repo.
// The tooltip names the component and the full place.
export function sourceLink(
  doc: Document,
  place: SourcePlace,
  className: string,
  open: (path: string, line: number) => void,
): HTMLElement {
  const { path, line } = place;
  const el = node(doc, path ? "button" : "span", className, place.label);
  el.title = place.title;
  if (path) el.onclick = () => open(path, line);
  return el;
}
