import type { UiCaps, UiElement, UiSource } from "../types";
import { selectorFor } from "./selector";
import { resolveSource } from "./source";

// What the agent gets to find the code behind a picked element: a proven selector plus a
// describe-only context (tag, text, role and accessible name, allowlisted attributes, where it sits,
// a short HTML outline, its box), and the source file that rendered it when the app's framework can
// tell (source.ts). Read from the live DOM and never written to it. Pure over the element's
// document, so it runs under happy-dom in tests.

// The bridge's copy of the caps. The desk checks them again; UiCaps keeps the copies equal.
export const CAPS: UiCaps = {
  selector: 512,
  file: 1024,
  text: 300,
  name: 200,
  outline: 2048,
  attrs: 12,
  attr: 200,
  url: 2048,
  route: 2048,
  title: 300,
  quote: 500,
  elements: 16,
  shot: 33_554_432,
};

// Attributes worth an agent's grep. Never `value`: what someone typed into a field is theirs.
const ATTRS = [
  "id",
  "data-testid",
  "data-test",
  "data-cy",
  "data-component",
  "name",
  "type",
  "role",
  "aria-label",
  "href",
  "placeholder",
  "title",
  "alt",
  "for",
];

export const LANDMARKS =
  "main, nav, aside, header, footer, form, dialog, section[aria-label], section[aria-labelledby], [role=main], [role=navigation], [role=complementary], [role=banner], [role=contentinfo], [role=search], [role=form], [role=region], [role=dialog], [role=alertdialog]";
export const HEADINGS = "h1, h2, h3, h4, h5, h6, [role=heading]";
// What a click on a part of a control means: the control. An icon in a button picks the button.
export const CONTROLS =
  "button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch]";

export const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
// Cut to `max` characters, ending in "…" so the reader knows.
export const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// The element a click at `hit` means: the control it sits in, else the element itself. An SVG
// shape means the icon it belongs to.
export function targetOf(hit: Element): Element | null {
  const doc = hit.ownerDocument;
  let el: Element | null = hit;
  if (el.namespaceURI === "http://www.w3.org/2000/svg")
    el = el.closest("svg")?.parentElement ?? el.parentElement;
  if (!el || el === doc.documentElement || el === doc.body) return null;
  return el.closest(CONTROLS) ?? el;
}

const INPUT_ROLES: Record<string, string> = {
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
};
const TAG_ROLES: Record<string, string> = {
  button: "button",
  textarea: "textbox",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  nav: "navigation",
  main: "main",
  aside: "complementary",
  header: "banner",
  footer: "contentinfo",
  form: "form",
  dialog: "dialog",
  table: "table",
  tr: "row",
  td: "cell",
  th: "columnheader",
  ul: "list",
  ol: "list",
  li: "listitem",
  option: "option",
  progress: "progressbar",
  article: "article",
  fieldset: "group",
  details: "group",
  hr: "separator",
};

// Its ARIA role: the explicit one, else the one its tag implies.
export function roleOf(el: Element): string | undefined {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = el.localName;
  if (tag === "a") return el.hasAttribute("href") ? "link" : undefined;
  if (tag === "img") return el.getAttribute("alt") === "" ? "presentation" : "img";
  if (tag === "select")
    return el.hasAttribute("multiple") || Number(el.getAttribute("size")) > 1
      ? "listbox"
      : "combobox";
  if (tag === "section")
    return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")
      ? "region"
      : undefined;
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "hidden") return undefined;
    return INPUT_ROLES[type] ?? (el.hasAttribute("list") ? "combobox" : "textbox");
  }
  return TAG_ROLES[tag];
}

// Roles whose accessible name is their text.
const NAMED_BY_CONTENT = new Set(
  "button link heading tab menuitem option cell columnheader rowheader checkbox radio switch treeitem tooltip".split(
    " ",
  ),
);
const isField = (el: Element) => ["input", "select", "textarea"].includes(el.localName);

// Its accessible name, the way assistive tech would read it (the common cases of the algorithm).
export function nameOf(el: Element): string | undefined {
  const name =
    labelledBy(el) ||
    squash(el.getAttribute("aria-label")) ||
    (isField(el) ? fieldLabel(el) : "") ||
    (el.localName === "img" ? squash(el.getAttribute("alt")) : "") ||
    (NAMED_BY_CONTENT.has(roleOf(el) ?? "") ? textOf(el) : "") ||
    squash(el.getAttribute("title"));
  return name ? cap(name, CAPS.name) : undefined;
}

// The words of the elements aria-labelledby points at, fields inside them skipped as in a label.
const labelledBy = (el: Element) =>
  squash(
    (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => {
        const ref = id ? el.ownerDocument.getElementById(id) : null;
        return ref ? wordsOf(ref) : "";
      })
      .join(" "),
  );

function fieldLabel(el: Element): string {
  const labels = (el as HTMLInputElement).labels;
  const text = labels ? [...labels].map((l) => squash(wordsOf(l))).join(" ") : "";
  return text || squash(el.getAttribute("placeholder"));
}

// A label's words, skipping every field inside it, the one it names included. A field's content is
// a select's options or a textarea's text; accname reads its value instead, and that is what
// someone typed or picked, which stays theirs.
const wordsOf = (node: Node): string =>
  node.nodeType === 3
    ? (node.textContent ?? "")
    : node.nodeType === 1 && isField(node as Element)
      ? ""
      : [...node.childNodes].map(wordsOf).join("");

// Visible text. A field's value is what someone typed, so fields have none.
export function textOf(el: Element): string {
  if (isField(el)) return "";
  const html = el as HTMLElement;
  return squash(typeof html.innerText === "string" ? html.innerText : el.textContent);
}

// The nearest landmark around it, as `role "name"`.
function landmarkOf(el: Element): string | undefined {
  const lm = el.parentElement?.closest(LANDMARKS);
  if (!lm) return undefined;
  const role = roleOf(lm) ?? lm.localName;
  const name = labelledBy(lm) || squash(lm.getAttribute("aria-label"));
  return cap(name ? `${role} "${name}"` : role, CAPS.name);
}

// The nearest heading above it: the last heading before it in the closest ancestor that has one.
function headingOf(el: Element): string | undefined {
  for (let scope = el.parentElement; scope; scope = scope.parentElement) {
    const before = [...scope.querySelectorAll(HEADINGS)].filter(
      (h) => h !== el && !h.contains(el) && !!(h.compareDocumentPosition(el) & 4),
    );
    const h = before[before.length - 1];
    if (h) return cap(squash(h.textContent), CAPS.name) || undefined;
  }
  return undefined;
}

const VOID = new Set([
  "area",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "wbr",
]);
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

// A short HTML sketch: the element's tag with its class and allowlisted attributes, its first few
// children two levels down, text cut short. Enough to recognise the template it came from.
function outlineOf(el: Element): string {
  const sketch = (node: Element, depth: number): string => {
    const attrs = ["class", ...ATTRS]
      .map((a) => [a, node.getAttribute(a)] as const)
      .filter((e): e is [string, string] => !!e[1])
      .map(([a, v]) => ` ${a}="${escapeAttr(cap(v, 80))}"`)
      .join("");
    const open = `<${node.localName}${attrs}>`;
    if (VOID.has(node.localName)) return open;
    if (node.localName === "svg") return `${open}…</svg>`;
    const kids: string[] = [];
    for (const child of node.childNodes) {
      if (kids.length === 6) {
        kids.push("…");
        break;
      }
      if (child.nodeType === 3) {
        const text = squash(child.textContent);
        if (text) kids.push(escapeText(cap(text, 40)));
      } else if (child.nodeType === 1) {
        const c = child as Element;
        kids.push(depth > 0 ? sketch(c, depth - 1) : `<${c.localName}>…</${c.localName}>`);
      }
    }
    return `${open}${kids.join("")}</${node.localName}>`;
  };
  return cap(sketch(el, 2), CAPS.outline);
}

function attrsOf(el: Element): Record<string, string> | undefined {
  const entries = ATTRS.map((a) => [a, el.getAttribute(a)] as const)
    .filter((e): e is [string, string] => !!e[1])
    .slice(0, CAPS.attrs)
    .map(([a, v]) => [a, cap(v, CAPS.attr)]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

// The source that rendered it, within the caps. A file over its cap is dropped rather than cut:
// cut short, it names another file.
function sourceOf(el: Element): UiSource | undefined {
  const source = resolveSource(el);
  if (!source || source.file.length > CAPS.file) return undefined;
  if (source.component) source.component = cap(source.component, CAPS.name);
  return source;
}

// Everything the agent gets about one element. Optional fields are left out when empty.
export function describeElement(el: Element): UiElement {
  const r = el.getBoundingClientRect();
  const out: UiElement = {
    selector: selectorFor(el),
    tag: el.localName,
    rect: {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    },
  };
  const text = textOf(el);
  if (text) out.text = cap(text, CAPS.text);
  const role = roleOf(el);
  if (role) out.role = cap(role, CAPS.name);
  const name = nameOf(el);
  if (name) out.name = name;
  const attrs = attrsOf(el);
  if (attrs) out.attrs = attrs;
  const landmark = landmarkOf(el);
  if (landmark) out.landmark = landmark;
  const heading = headingOf(el);
  if (heading) out.heading = heading;
  out.outline = outlineOf(el);
  const source = sourceOf(el);
  if (source) out.source = source;
  return out;
}

// The hover label: `role · "name"`, kept short.
export function labelOf(el: Element): { role: string; name: string } {
  return { role: roleOf(el) ?? el.localName, name: cap(nameOf(el) ?? "", 40) };
}
