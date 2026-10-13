import { existsSync } from "node:fs";
import path from "node:path";

import type {
  Rect,
  ThreadMessage,
  UiAnnotation,
  UiAnnotationRecord,
  UiCaps,
  UiElement,
  UiPage,
  UiSentElement,
  UiSource,
  UiTarget,
} from "./types.js";
import { SHOT_CAP, shotFile } from "./uishots.js";

// The UI lane's annotations at the trust boundary. An annotation's page and target came from the
// app page (bridge → tab → reviewer save), so the desk re-validates every save before storing it:
// malformed entries are dropped, oversized strings are cut to the caps. The tab checks the same
// caps on the bridge's messages; this copy is the one that guards the stored review.
const CAPS: UiCaps = {
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
  shot: SHOT_CAP,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

// Cut to `max` characters, ending in "…" so whoever reads it knows it was cut. Cutting a cut
// string changes nothing.
const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const capped = (v: unknown, max: number) => (nonEmpty(v) ? cap(v, max) : undefined);

// Attribute names as HTML writes them; anything else (spaces, quotes, markup) is not an attribute.
const ATTR_NAME = /^[a-z][\w.:-]{0,63}$/i;
// Annotation and message ids (uuids from the tab) end up in the desk's markup: word characters only.
const isId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,64}$/.test(v);

// A path on the app's own origin, as the address bar shows it. The URL parser reads a backslash in
// the path as a slash (`/\evil.example` is `//evil.example`), and no route has control characters.
function isRoute(v: unknown): v is string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//")) return false;
  const path = v.split(/[?#]/, 1)[0]!;
  return !path.includes("\\") && ![...v].some((c) => c < " " || c === "\x7f");
}

function readRect(v: unknown): Rect | null {
  if (!isObj(v)) return null;
  const { x, y, width, height } = v;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  return { x, y, width, height };
}

// The source the page says rendered an element. Malformed, or a path over its cap (cut short, it
// would name another file), and the element stands without one.
function readSource(v: unknown): UiSource | undefined {
  if (!isObj(v) || !nonEmpty(v.file) || v.file.length > CAPS.file) return undefined;
  if ([...v.file].some((c) => c < " " || c === "\x7f")) return undefined;
  if (v.via !== "vue-tracer" && v.via !== "vue-file") return undefined;
  const source: UiSource = { file: v.file, via: v.via };
  for (const key of ["line", "column"] as const) {
    const n = v[key];
    if (n === undefined) continue;
    if (!Number.isSafeInteger(n) || (n as number) < 1) return undefined;
    source[key] = n as number;
  }
  const component = capped(v.component, CAPS.name);
  if (component) source.component = component;
  if (v.vendor === true) source.vendor = true;
  return source;
}

function readElement(v: unknown): UiElement | null {
  if (!isObj(v)) return null;
  const { selector, tag } = v;
  // A selector can't be cut short: a cut one matches something else, or nothing.
  if (!nonEmpty(selector) || selector.length > CAPS.selector) return null;
  if (typeof tag !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(tag)) return null;
  const rect = readRect(v.rect);
  if (!rect) return null;
  const el: UiElement = { selector, tag, rect };
  const text = capped(v.text, CAPS.text);
  if (text) el.text = text;
  for (const key of ["role", "name", "landmark", "heading"] as const) {
    const s = capped(v[key], CAPS.name);
    if (s) el[key] = s;
  }
  const outline = capped(v.outline, CAPS.outline);
  if (outline) el.outline = outline;
  if (isObj(v.attrs))
    el.attrs = Object.fromEntries(
      Object.entries(v.attrs)
        .filter((e): e is [string, string] => ATTR_NAME.test(e[0]) && typeof e[1] === "string")
        .slice(0, CAPS.attrs)
        .map(([k, s]) => [k, cap(s, CAPS.attr)]),
    );
  const source = readSource(v.source);
  if (source) el.source = source;
  return el;
}

// The page's url isn't taken as sent: it's rebuilt from the route on the desk's app, so it can only
// ever point at the app under review.
function readPage(v: unknown, app: string): UiPage | null {
  if (!isObj(v) || !isObj(v.viewport)) return null;
  const { width, height, dpr } = v.viewport;
  if (!isRoute(v.route)) return null;
  if (![width, height, dpr].every((n) => finite(n) && n > 0)) return null;
  const route = cap(v.route, CAPS.route);
  const url = new URL(route, app);
  if (url.origin !== new URL(app).origin) return null;
  const page: UiPage = {
    url: cap(url.href, CAPS.url),
    route,
    viewport: { width: width as number, height: height as number, dpr: dpr as number },
  };
  const title = capped(v.title, CAPS.title);
  if (title) page.title = title;
  return page;
}

// A thread message, the reviewer's or the agent's (`galley comment --ui`). Bodies are not
// page-sourced and keep the code comments' rule: no cap.
function readMessage(v: unknown): ThreadMessage | null {
  if (!isObj(v)) return null;
  const { id, body, createdAt, updatedAt, role, intent } = v;
  if (!isId(id) || !nonEmpty(body) || !nonEmpty(createdAt) || !nonEmpty(updatedAt)) return null;
  if (role !== "user" && role !== "agent") return null;
  const m: ThreadMessage = { id, body, createdAt, updatedAt, role };
  if (intent === "note" || intent === "action" || intent === "question") m.intent = intent;
  return m;
}

// What an annotation points at: elements (malformed ones dropped, at least one left), a box with a
// size (its elements may be none), a quote and the element holding it, or the page. Element lists
// are capped at CAPS.elements. Anything else is null.
function readTarget(v: unknown): UiTarget | null {
  if (!isObj(v)) return null;
  if (v.kind === "page") return { kind: "page" };
  if (v.kind === "text") {
    const element = readElement(v.element);
    const quote = typeof v.quote === "string" ? v.quote.trim() : "";
    return element && quote ? { kind: "text", quote: cap(quote, CAPS.quote), element } : null;
  }
  const elements = Array.isArray(v.elements)
    ? v.elements
        .map(readElement)
        .filter((e) => e !== null)
        .slice(0, CAPS.elements)
    : [];
  if (v.kind === "element") return elements.length ? { kind: "element", elements } : null;
  if (v.kind !== "region") return null;
  const rect = readRect(v.rect);
  return rect && rect.width > 0 && rect.height > 0 ? { kind: "region", rect, elements } : null;
}

function readAnnotation(v: unknown, app: string): UiAnnotationRecord | null {
  if (!isObj(v)) return null;
  const { id, number, intent, status, placement } = v;
  if (!isId(id)) return null;
  if (!Number.isSafeInteger(number) || (number as number) < 1) return null;
  if (intent !== "change" && intent !== "question") return null;
  if (placement !== "placed" && placement !== "unplaced" && placement !== "unvisited") return null;
  if (status !== "open" && status !== "resolved") return null;
  const page = readPage(v.page, app);
  const target = readTarget(v.target);
  if (!page || !target) return null;
  const comments = Array.isArray(v.comments)
    ? v.comments.map(readMessage).filter((m) => m !== null)
    : [];
  // The opening message is the annotation's body: without one there is nothing to send.
  if (!comments.length) return null;
  return {
    id,
    number: number as number,
    intent,
    status,
    placement,
    page,
    target,
    comments,
  };
}

// The `annotations` of a reviewer save, validated against the desk's app (`app`, its UI target):
// the valid entries (first of each id), none without an app, or undefined when the field isn't an
// array at all, which leaves the stored annotations untouched.
export function readUiAnnotations(
  value: unknown,
  app: string | undefined,
): UiAnnotationRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!app) return [];
  const seen = new Set<string>();
  const out: UiAnnotationRecord[] = [];
  for (const entry of value) {
    const a = readAnnotation(entry, app);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

// Paths compared as strings, whichever OS wrote them (the dev server's or the desk's): forward
// slashes, an upper-case drive letter, and a drive-letter path counted as absolute.
const slashed = (p: string) =>
  p.replace(/\\/g, "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase());
const isAbsolutePath = (p: string) => p.startsWith("/") || /^[A-Za-z]:/.test(p);

// A source file as the agent may be handed it: repo-relative, once `.` and `..` are resolved, when
// it lies inside the repo `root` (a relative path counts from the root). Null for any other: the
// path came from the page, which could otherwise point the agent at any file on the machine.
function repoRelative(file: string, root: string): string | null {
  const base = path.posix.normalize(slashed(root)).replace(/\/+$/, "");
  const f = slashed(file);
  const abs = path.posix.normalize(isAbsolutePath(f) ? f : `${base}/${f}`);
  return abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : null;
}

// An element as the agent gets it (UiSentElement): its source's file repo-relative, or, when the
// file lies outside the repo, the source without its file, line and column.
function withRepoSource(el: UiElement, root: string): UiSentElement {
  if (!el.source) return el;
  const file = repoRelative(el.source.file, root);
  if (file !== null) return { ...el, source: { ...el.source, file } };
  const { component, vendor, via } = el.source;
  return { ...el, source: { ...(component && { component }), ...(vendor && { vendor }), via } };
}

// A target with its elements' sources as the agent gets them.
function withRepoSources(target: UiTarget, root: string): UiTarget<UiSentElement> {
  if (target.kind === "page") return target;
  if (target.kind === "text") return { ...target, element: withRepoSource(target.element, root) };
  return { ...target, elements: target.elements.map((el) => withRepoSource(el, root)) };
}

// What a UI question points at, in one line for the agent. Elements are named by the first one's
// role (else tag) and its accessible name (else its text), and how many more there are; a region
// by its size first, a quote by its text and its holder's role, a page as the whole page. Then the
// source's file:line (the first element's that has one inside the repo, repo-relative) when the
// page resolved it.
export function questionTarget(target: UiTarget, root: string): string {
  if (target.kind === "page") return "the whole page";
  const elements = target.kind === "text" ? [target.element] : target.elements;
  const [first, ...more] = elements;
  const label = first && (first.name ?? first.text);
  const named =
    target.kind === "text"
      ? [`text "${cap(target.quote, 80)}" in ${target.element.role ?? target.element.tag}`]
      : [
          target.kind === "region" &&
            `region ${Math.round(target.rect.width)}×${Math.round(target.rect.height)}`,
          first && (first.role ?? first.tag),
          label && `"${cap(label, 80)}"`,
          more.length && `+${more.length} more`,
        ];
  const source = elements.map((el) => withRepoSource(el, root).source).find((s) => s?.file);
  return [...named, source && `${source.file}${source.line ? `:${source.line}` : ""}`]
    .filter(Boolean)
    .join(" · ");
}

// An annotation's screenshots as the agent gets them: both paths, only when the annotation is
// marked as having them and both files are still on disk (the mark can outlive files deleted by
// hand), so the agent is never handed a path to nothing.
function screenshotsOf(a: UiAnnotationRecord, shots: string): UiAnnotation["screenshots"] {
  if (!a.screenshots) return undefined;
  const crop = shotFile(shots, a.id, "crop");
  const viewport = shotFile(shots, a.id, "viewport");
  return existsSync(crop) && existsSync(viewport) ? { crop, viewport, exact: false } : undefined;
}

// An annotation requests a change when it was opened as one, or when the reviewer requested one
// later in its thread: a question whose thread has a Request change reply is sent for that
// request, as a code thread's change-request reply is. The tab counts with its own copy
// (uilane-derive.ts): the worlds share no runtime code, so each copy has its own test.
const requestsChange = (a: UiAnnotationRecord) =>
  a.intent === "change" || a.comments.some((m) => m.role !== "agent" && m.intent === "action");

// What the agent receives: every open annotation that requests a change, its opening message as
// the body and the rest as the thread, source files repo-relative, and its screenshots' paths in
// `shots` (the session's ui-shots/) when both are stored. Resolved annotations are the reviewer's
// "done" and are not sent.
export function uiAnnotationsForAgent(
  records: UiAnnotationRecord[],
  root: string,
  shots: string,
): UiAnnotation[] {
  return records
    .filter((a) => a.status === "open" && requestsChange(a))
    .map((a) => {
      const [opener, ...replies] = a.comments;
      const screenshots = screenshotsOf(a, shots);
      return {
        id: a.id,
        number: a.number,
        body: opener?.body ?? "",
        status: a.status,
        placement: a.placement,
        page: a.page,
        target: withRepoSources(a.target, root),
        ...(screenshots && { screenshots }),
        thread: replies.map((m) => ({
          role: m.role === "agent" ? ("agent" as const) : ("user" as const),
          body: m.body,
          at: m.createdAt,
        })),
      };
    });
}
