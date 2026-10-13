import type { Rect, UiAnnotationRecord, UiMark } from "./types";

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

export const openChangeCount = (list: readonly UiAnnotationRecord[]) =>
  list.filter((a) => a.status === "open" && a.intent === "change").length;

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

// The row's tooltip carries the state the row itself doesn't draw.
export function rowTitle(a: UiAnnotationRecord): string {
  return [`#${a.number}`, "Change request", a.status === "resolved" ? "Resolved" : ""]
    .filter(Boolean)
    .join(" · ");
}

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
