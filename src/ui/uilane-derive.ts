import type {
  Rect,
  ThreadMessage,
  UiAnnotationRecord,
  UiElement,
  UiMark,
  UiMarkElement,
  UiMarkTarget,
  UiSource,
  UiTarget,
} from "./types";

// Pure derivations for the UI lane's pins, cards and composer (store-free, so they unit-test —
// see skim-derive.ts for the pattern). uilane.ts is the store-reading side.

// An annotation requests a change when it was opened as one, or when the reviewer requested one
// later in its thread (a question with a Request change reply). The Send sends exactly these
// (uiannotations.ts keeps the server's copy of the rule).
export const requestsChange = (a: UiAnnotationRecord) =>
  a.intent === "change" || a.comments.some((m) => m.role !== "agent" && m.intent === "action");

export const isOpenChange = (a: UiAnnotationRecord) => a.status === "open" && requestsChange(a);

export const openChangeCount = (list: readonly UiAnnotationRecord[]) =>
  list.filter(isOpenChange).length;

// A question is answered once an agent reply lands after it was asked, in its thread: the code
// lane's waiting indicator (annotations.ts) and the UI lane's rows both read it. state.ts keeps the
// server's copy, for openQuestions.
export const answered = (question: ThreadMessage, thread: readonly ThreadMessage[]) =>
  thread.some(
    (r) =>
      r.role === "agent" &&
      +new Date(r.createdAt) > +new Date(question.askedAt ?? question.createdAt),
  );

// What a reviewer's message turns into: a change request into a question, and back. A note, or
// the agent's message, doesn't turn.
export const turnsInto = (m: ThreadMessage) =>
  m.role === "agent"
    ? null
    : m.intent === "action"
      ? ("question" as const)
      : m.intent === "question"
        ? ("action" as const)
        : null;

// Turn a reviewer's message into the other kind. Turned into a question, it's asked now, so an
// agent reply from before doesn't answer it.
export function turnInto(m: ThreadMessage, intent: "action" | "question", now: string) {
  m.intent = intent;
  if (intent === "question") m.askedAt = now;
  else delete m.askedAt;
}

// When a message was last asked, or null when it isn't a question (any more). An ask that waited on
// a save sends only if this hasn't moved meanwhile: a later turn supersedes it.
export const askStamp = (m: ThreadMessage | undefined) =>
  m && m.role !== "agent" && m.intent === "question" ? (m.askedAt ?? m.createdAt) : null;

// An annotation's kind lives on it (its pin, row tint and tooltip) and on its opening message (what
// the Send sends), so the two turn together.
export function turnAnnotationInto(
  a: UiAnnotationRecord,
  intent: "action" | "question",
  now: string,
) {
  a.intent = intent === "question" ? "question" : "change";
  if (a.comments[0]) turnInto(a.comments[0], intent, now);
}

// An open annotation waits on the agent while a question of the reviewer's in its thread is
// unanswered.
export const isWaiting = (a: UiAnnotationRecord) =>
  a.status === "open" &&
  a.comments.some((m) => m.role !== "agent" && m.intent === "question" && !answered(m, a.comments));

export const waitingCount = (list: readonly UiAnnotationRecord[]) => list.filter(isWaiting).length;

// The Send dialog's UI line: what goes (open change requests, and questions still waiting, which go
// as openQuestions), and what doesn't (resolved annotations, answered questions that request no
// change).
export function sendSummary(list: readonly UiAnnotationRecord[]) {
  const open = list.filter((a) => a.status === "open" && requestsChange(a));
  const pages = new Set(open.map((a) => a.page.route)).size;
  const waiting = waitingCount(list);
  const answered = list.filter(
    (a) => a.status === "open" && !requestsChange(a) && !isWaiting(a),
  ).length;
  const resolved = list.filter((a) => a.status === "resolved").length;
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  const notSent = [
    resolved ? `${resolved} resolved` : "",
    answered ? n(answered, "answered question") : "",
  ].filter(Boolean);
  return {
    ui:
      [
        open.length ? `${n(open.length, "change request")} on ${n(pages, "page")}` : "",
        waiting ? n(waiting, "open question") : "",
      ]
        .filter(Boolean)
        .join(" · ") || "No change requests",
    uiNotSent: notSent.length ? `Not sent: ${notSent.join(" · ")}` : "",
  };
}

// The agent's replies from the poll (`galley comment --ui`) that the tab's threads lack, added to
// them. Only agent messages: the tab owns everything else, and a message or annotation it dropped
// isn't brought back. Returns how many it added.
export function mergeAgentReplies(
  local: readonly UiAnnotationRecord[],
  server: readonly UiAnnotationRecord[],
): number {
  let added = 0;
  for (const a of local) {
    const have = new Set(a.comments.map((m) => m.id));
    const replies =
      server
        .find((s) => s.id === a.id)
        ?.comments.filter((m) => m.role === "agent" && !have.has(m.id)) ?? [];
    a.comments.push(...replies);
    added += replies.length;
  }
  return added;
}

// The tab's placements, kept on the desk's state the poll is adopting (`server`, after a reload
// moved the diff). The tab marks every annotation unvisited as soon as it sees the reload, and the
// page's answers to its relook land on the tab's copy, possibly while the desk's state is still
// on its way: a placement the tab has looked for is never older than the desk's.
export function keepPlacements(
  server: readonly UiAnnotationRecord[],
  local: readonly UiAnnotationRecord[],
) {
  for (const a of server) {
    const looked = local.find((l) => l.id === a.id)?.placement;
    if (looked && looked !== "unvisited") a.placement = looked;
  }
}

// Numbers are global and never reused: past every annotation here and the highest number ever
// given (`last`), so deleting the newest #3 doesn't free 3 for a different annotation.
export const nextNumber = (list: readonly UiAnnotationRecord[], last: number) =>
  list.reduce((max, a) => Math.max(max, a.number), last) + 1;

// A row's line: the body's first non-empty line, without markdown's marks.
export function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim()) ?? "";
  return line
    .replace(/^\s*(#+|>|[-*+]\s)\s*/, "")
    .replace(/[*`]/g, "")
    .replace(/(^|[\s(])_+|_+(?=[\s).,!?:;]|$)/g, "$1")
    .trim();
}

// The elements a target names: an element or region target's, a text target's holder, none for a
// page.
export const targetElements = (target: UiTarget): UiElement[] =>
  target.kind === "page" ? [] : target.kind === "text" ? [target.element] : target.elements;

// The source an annotation shows: its first element's that has one.
export const annotationSource = (target: UiTarget): UiSource | undefined =>
  targetElements(target).find((el) => el.source)?.source;

// An element as the composer names it: role (else tag) and accessible name.
const elementLabel = (el: UiElement) => {
  const what = el.role ?? el.tag;
  return el.name ? `${what} · "${el.name}"` : what;
};

// What the floating composer says it's on. Of several elements, the first: the head counts the
// rest beside it.
export function targetLabel(target: UiTarget): string {
  if (target.kind === "page") return "Whole page";
  if (target.kind === "text") return `Text in ${elementLabel(target.element)}`;
  if (target.kind === "region") {
    const { rect, elements } = target;
    const n = elements.length;
    const size = `Region ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    return n ? `${size} · ${n} element${n === 1 ? "" : "s"}` : size;
  }
  const [first] = target.elements;
  return first ? elementLabel(first) : "";
}

// Where a new pick's composer starts, until the bridge reports where the pick is now: beside all of
// its elements, its box, or its text's holder. A page has no anchor.
export function draftAnchor(target: UiTarget): Rect | null {
  if (target.kind === "page") return null;
  if (target.kind === "region") return target.rect;
  if (target.kind === "text") return target.element.rect;
  const [first, ...rest] = target.elements;
  if (!first) return null;
  let { x, y } = first.rect;
  let right = x + first.rect.width;
  let bottom = y + first.rect.height;
  for (const { rect: r } of rest) {
    x = Math.min(x, r.x);
    y = Math.min(y, r.y);
    right = Math.max(right, r.x + r.width);
    bottom = Math.max(bottom, r.y + r.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

// A source as the desk shows it: a label (the last two path segments and the line), what the editor
// opens (the repo-relative path and line; no path when the file isn't in the repo `root`), and a
// tooltip with the component, the full place, and whether a library rendered the element. Paths
// are compared whichever OS wrote them: forward slashes, an upper-case drive letter, and a
// drive-letter path counted as absolute.
export function sourcePlace(source: UiSource, root: string) {
  const slashed = (p: string) =>
    p.replace(/\\/g, "/").replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const base = slashed(root).replace(/\/+$/, "");
  const { line, column, component, vendor } = source;
  const file = slashed(source.file);
  const path = file.startsWith(`${base}/`)
    ? file.slice(base.length + 1)
    : /^([A-Z]:|\/|\.\.\/)/.test(file)
      ? null
      : file;
  const at = line ? `:${line}` : "";
  return {
    label: file.split("/").slice(-2).join("/") + at,
    path,
    line: line ?? 1,
    title: [
      component,
      `${path ?? file}${at}${line && column ? `:${column}` : ""}`,
      vendor ? "A library component renders it; this is where the app uses it" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
export type SourcePlace = ReturnType<typeof sourcePlace>;

// What ⇧↓/⇧↑ walk in the UI view: every annotation, on every page and resolved or not, by number.
export const stepOrder = (list: readonly UiAnnotationRecord[]) =>
  [...list].sort((x, y) => x.number - y.number).map((a) => a.id);

// The one after (dir 1) or before (dir -1) `current` in `order`, wrapping. With no selection (or
// one the order doesn't hold), the first, or the last going back.
export function stepFrom(order: readonly string[], current: string | null, dir: 1 | -1) {
  const n = order.length;
  if (!n) return null;
  const i = current ? order.indexOf(current) : -1;
  const from = i < 0 ? (dir > 0 ? -1 : n) : i;
  // The index wraps into 0..n-1, and n > 0.
  return order[(((from + dir) % n) + n) % n]!;
}

// The classes an element had, read off the start of its outline (`<button class="btn primary" …>`).
// The outline caps each attribute's value, so a class list cut short loses its last, partial class.
export function outlineClasses(outline: string | undefined): string[] {
  const value = outline?.match(/^<[a-z][\w-]*\s+class="([^"]*)"/)?.[1];
  if (!value) return [];
  const classes = value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .split(/\s+/)
    .filter(Boolean);
  if (value.endsWith("…")) classes.pop();
  return classes;
}

// What the bridge finds an element by again (types.ts, UiMarkElement).
function markElement(el: UiElement): UiMarkElement {
  const out: UiMarkElement = { selector: el.selector, tag: el.tag, rect: { ...el.rect } };
  if (el.text) out.text = el.text;
  if (el.name) out.name = el.name;
  const classes = outlineClasses(el.outline);
  if (classes.length) out.classes = classes;
  if (el.source) out.source = { ...el.source };
  return out;
}

// How the bridge finds a target's mark on the page (types.ts, UiMarkTarget): by its elements, by
// its box moving with the first of its elements still found, or by its quote in its holder. A page
// target has no mark on the page. Built of fresh objects: it's posted to the page, and postMessage
// can't clone the store's reactive proxies.
export function markTarget(target: UiTarget): UiMarkTarget | null {
  if (target.kind === "page") return null;
  if (target.kind === "text")
    return { kind: "text", quote: target.quote, element: markElement(target.element) };
  const elements = target.elements.map(markElement);
  return target.kind === "element"
    ? { kind: "element", elements }
    : { kind: "region", rect: { ...target.rect }, elements };
}

// The pins the bridge draws on one page: all its annotations, the resolved ones dimmed.
export function marksFor(list: readonly UiAnnotationRecord[], route: string): UiMark[] {
  return list.flatMap((a) => {
    const target = a.page.route === route && markTarget(a.target);
    return target
      ? [
          {
            id: a.id,
            number: a.number,
            target,
            resolved: a.status === "resolved",
            question: a.intent === "question",
          },
        ]
      : [];
  });
}

// A pin the desk draws itself: in the address bar for a page annotation, and in the stage's tray
// for one whose target couldn't be found on its page. Dimmed once resolved, like the page's pins.
const deskPin = (a: UiAnnotationRecord, selected: string | null) => ({
  id: a.id,
  number: a.number,
  question: a.intent === "question",
  resolved: a.status === "resolved",
  selected: a.id === selected,
});
export type DeskPin = ReturnType<typeof deskPin>;

// The pins of one page's page annotations, which the address bar shows.
export const pageMarks = (
  list: readonly UiAnnotationRecord[],
  route: string,
  selected: string | null,
) =>
  list
    .filter((a) => a.target.kind === "page" && a.page.route === route)
    .map((a) => deskPin(a, selected));

// The pins of one page's annotations that weren't found on it when it last settled: the tray at
// the stage's top-left shows them, by number.
export const trayPins = (
  list: readonly UiAnnotationRecord[],
  route: string,
  selected: string | null,
) =>
  list
    .filter((a) => a.page.route === route && a.placement === "unplaced" && a.target.kind !== "page")
    .sort((x, y) => x.number - y.number)
    .map((a) => deskPin(a, selected));

// Where the floating composer goes, in desk coordinates: right of its target, else left of it,
// else below it (above when there's no room below), always inside the stage. Without a target (the
// whole page) it sits at the stage's top right.
export function placeComposer(
  target: Rect | null,
  card: { width: number; height: number },
  stage: Rect,
  gap = 12,
): { left: number; top: number } {
  const margin = 8;
  const minLeft = stage.x + margin;
  const maxLeft = Math.max(minLeft, stage.x + stage.width - card.width - margin);
  const minTop = stage.y + margin;
  const maxTop = Math.max(minTop, stage.y + stage.height - card.height - margin);
  if (!target) return { left: maxLeft, top: minTop };
  const right = target.x + target.width;
  const bottom = target.y + target.height;
  let left: number;
  let top: number;
  if (right + gap + card.width <= stage.x + stage.width - margin) {
    left = right + gap;
    top = target.y;
  } else if (target.x - gap - card.width >= minLeft) {
    left = target.x - gap - card.width;
    top = target.y;
  } else {
    left = target.x;
    top = bottom + gap <= maxTop ? bottom + gap : target.y - gap - card.height;
  }
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return { left: clamp(left, minLeft, maxLeft), top: clamp(top, minTop, maxTop) };
}
