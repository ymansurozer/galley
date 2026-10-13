import type { Rect, UiAnnotationRecord, UiMark, UiSource, UiTarget } from "./types";

// Pure derivations for the UI lane's sidebar, pins and composer (store-free, so they unit-test —
// see skim-derive.ts for the pattern). uilane.ts is the store-reading side.

// One page's annotations: open rows in number order, and the resolved ones its toggle reveals.
export type PageGroup = {
  route: string;
  title: string;
  open: UiAnnotationRecord[];
  resolved: UiAnnotationRecord[];
};

// Annotations grouped by page. A page is its path + query (the address-bar route); pages come in
// the order of their lowest number. The group's title is the latest one recorded on that page.
export function pageGroups(list: readonly UiAnnotationRecord[]): PageGroup[] {
  const groups = new Map<string, PageGroup>();
  for (const a of [...list].sort((x, y) => x.number - y.number)) {
    let g = groups.get(a.page.route);
    if (!g)
      groups.set(a.page.route, (g = { route: a.page.route, title: "", open: [], resolved: [] }));
    if (a.page.title) g.title = a.page.title;
    (a.status === "resolved" ? g.resolved : g.open).push(a);
  }
  return [...groups.values()];
}

// A page's own name: its title up to the first separator ("Files · Okafor — I-485" → "Files"),
// the route when it has no title.
export function pageName(title: string | undefined, route: string): string {
  return title?.split(/\s+[·|—–-]\s+/)[0]?.trim() || route;
}

// An annotation requests a change when it was opened as one, or when the reviewer requested one
// later in its thread (a question with a Request change reply). The Send sends exactly these
// (uiannotations.ts keeps the server's copy of the rule).
export const requestsChange = (a: UiAnnotationRecord) =>
  a.intent === "change" || a.comments.some((m) => m.role !== "agent" && m.intent === "action");

export const openChangeCount = (list: readonly UiAnnotationRecord[]) =>
  list.filter((a) => a.status === "open" && requestsChange(a)).length;

// An open annotation waits on the agent while a question of the reviewer's in its thread has no
// agent reply after it (the code lane's "answered" rule, annotations.ts).
export const isWaiting = (a: UiAnnotationRecord) =>
  a.status === "open" &&
  a.comments.some(
    (m) =>
      m.role !== "agent" &&
      m.intent === "question" &&
      !a.comments.some(
        (r) => r.role === "agent" && +new Date(r.createdAt) > +new Date(m.createdAt),
      ),
  );

export const waitingCount = (list: readonly UiAnnotationRecord[]) => list.filter(isWaiting).length;

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

// The row's tooltip carries the state the row itself doesn't draw: resolved, else waiting on the
// agent, else whether the agent had the last word.
export function rowTitle(a: UiAnnotationRecord): string {
  const question = a.intent === "question";
  const state =
    a.status === "resolved"
      ? "Resolved"
      : isWaiting(a)
        ? "Waiting"
        : a.comments.at(-1)?.role === "agent"
          ? question
            ? "Answered"
            : "Agent replied"
          : "";
  return [`#${a.number}`, question ? "Question" : "Change request", state]
    .filter(Boolean)
    .join(" · ");
}

// The source an annotation shows: its first element's that has one.
export const annotationSource = (target: UiTarget): UiSource | undefined =>
  target.elements.find((el) => el.source)?.source;

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

// The rows ⇧↓/⇧↑ walk: every page's open rows, plus the resolved rows of pages showing them, in
// the order the sidebar lists them.
export function stepOrder(groups: readonly PageGroup[], shownResolved: ReadonlySet<string>) {
  return groups.flatMap((g) =>
    [...g.open, ...(shownResolved.has(g.route) ? g.resolved : [])].map((a) => a.id),
  );
}

export function stepFrom(order: readonly string[], current: string | null, dir: 1 | -1) {
  if (!order.length) return null;
  const i = current ? order.indexOf(current) : -1;
  if (i < 0) return dir > 0 ? order[0]! : order[order.length - 1]!;
  return order[(i + dir + order.length) % order.length]!;
}

// The pins for one page: its open annotations, plus a resolved one while it's selected (its row
// revealed and expanded), drawn dimmed.
export function marksFor(
  list: readonly UiAnnotationRecord[],
  route: string,
  selected: string | null,
): UiMark[] {
  return list
    .filter((a) => a.page.route === route && (a.status === "open" || a.id === selected))
    .map((a) => ({
      id: a.id,
      number: a.number,
      // An element target has at least one element: the tab and the server both refuse one without.
      selector: a.target.elements[0]!.selector,
      resolved: a.status === "resolved",
      question: a.intent === "question",
    }));
}

// Where the floating composer goes, in desk coordinates: right of its target, else left of it,
// else below it (above when there's no room below), always inside the stage.
export function placeComposer(
  target: Rect,
  card: { width: number; height: number },
  stage: Rect,
  gap = 12,
): { left: number; top: number } {
  const margin = 8;
  const minLeft = stage.x + margin;
  const maxLeft = Math.max(minLeft, stage.x + stage.width - card.width - margin);
  const minTop = stage.y + margin;
  const maxTop = Math.max(minTop, stage.y + stage.height - card.height - margin);
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
