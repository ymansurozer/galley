import type { Rect, UiMarkElement, UiMarkTarget, UiSource } from "../types";
import { CAPS, cap, nameOf, textOf } from "./describe";
import { resolveSource } from "./source";
import { findQuote, textRects } from "./targets";

// Finding an annotation's target again on a page loaded after it was made, maybe after the agent
// changed the code behind it. An element is looked for three ways, in order: where its source says
// it was rendered (the tracer's file:line:column, or its component's file), by the selector it was
// captured with, and by its tag and text. Every match is checked against what the element showed:
// its text (else its accessible name) must still be what it was, so a template line or a selector
// that now renders something else is no match. A way that finds more than one candidate finds
// nothing: a target that can't be told apart is unplaced, never pinned to a guess. Read from the
// live DOM, never written to it, and pure over the document, so it runs under happy-dom in tests.

// What a target was found as: its elements (the first is the one whose finding places it, and
// carries the pin; the rest are those found too), a region's box and the element it moves with,
// or a quote and the element holding it.
export type Found =
  | { kind: "element"; els: [Element, ...Element[]] }
  | { kind: "region"; rect: Rect; anchor: { el: Element; rect: Rect } | null }
  | { kind: "text"; holder: Element; quote: string };

// A found target where it is now: its boxes (the elements' boxes, the region's box, or the quote's
// line boxes; the pin goes on the first), and the element it moves with. Null when the element that
// places it has left the page, or its quote has left its holder.
export type Located = {
  kind: UiMarkTarget["kind"];
  boxes: [Rect, ...Rect[]];
  anchor: Element | null;
};

// A candidate passes when it still shows what the element showed; `text`, when given, lets the
// search skip elements whose text can't hold it before running the exact (slower) test.
type Check = { test: (el: Element) => boolean; text?: string };

const boxOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

// Text compared roughly: no whitespace, any case (innerText applies text-transform, textContent
// doesn't), and without the "…" a capped string ends in.
const bare = (s: string) => s.replace(/…$/, "").replace(/\s+/g, "").toLowerCase();

// What the element showed, as it was captured (describe.ts): its visible text cut to the cap, else
// its accessible name. Null when it showed neither (an unlabelled icon, a bare box).
function showing(rec: UiMarkElement): Check | null {
  const { text, name } = rec;
  if (text) return { test: (el) => cap(textOf(el), CAPS.text) === text, text };
  if (name) return { test: (el) => nameOf(el) === name };
  return null;
}

// A text target's holder passes while its quote is still in it.
const quoting = (quote: string): Check => ({
  test: (el) => findQuote(el, quote) !== null,
  text: quote,
});

const sameSource = (a: UiSource | undefined, b: UiSource) =>
  !!a && a.file === b.file && a.line === b.line && a.column === b.column;

const queryAll = (doc: Document, selector: string): Element[] => {
  try {
    return [...doc.querySelectorAll(selector)];
  } catch {
    return [];
  }
};

// A selector made of positions (`div:nth-of-type(2) > button`) names whatever sits there now; one
// made of a handle (an id, an attribute, a class, a tag alone on the page) names the thing.
const positional = (selector: string) =>
  selector.includes(" > ") || selector.includes(":nth-of-type(");

// Of several elements that each pass, those sharing the most of the classes it had, then the one
// that sits where it was captured (overlapping its box by at least half of the smaller of the two).
// Still several, or none: no answer.
function narrow(els: Element[], rec: UiMarkElement): Element | null {
  const classes = rec.classes ?? [];
  const score = (el: Element) => classes.filter((c) => el.classList.contains(c)).length;
  const best = Math.max(0, ...els.map(score));
  const classed = best ? els.filter((el) => score(el) === best) : els;
  if (classed.length === 1) return classed[0]!;
  const at = rec.rect;
  const there = classed.filter((el) => {
    const r = boxOf(el);
    const w = Math.min(r.x + r.width, at.x + at.width) - Math.max(r.x, at.x);
    const h = Math.min(r.y + r.height, at.y + at.height) - Math.max(r.y, at.y);
    return w > 0 && h > 0 && w * h >= Math.min(r.width * r.height, at.width * at.height) / 2;
  });
  return there.length === 1 ? there[0]! : null;
}

// The element `rec` describes, on the page as it is now, or null. `check` is what a match must
// still show (null: nothing to check, as for an unlabelled icon). `innermost`: of a candidate and
// one inside it that both pass, only the inner one counts (a quote is in every element around it).
export function findElement(
  doc: Document,
  rec: UiMarkElement,
  check: Check | null = showing(rec),
  innermost = false,
): Element | null {
  const sameTag = (el: Element) => el.localName === rec.tag;
  // Every element of its tag that passes the check, rough text first.
  const passing = () => {
    const want = check?.text && bare(check.text);
    const els = queryAll(doc, rec.tag).filter(
      (el) =>
        sameTag(el) &&
        (!want || bare(el.textContent ?? "").includes(want)) &&
        (!check || check.test(el)),
    );
    return innermost ? els.filter((el) => !els.some((o) => o !== el && el.contains(o))) : els;
  };
  let candidates: Element[] | null = null;

  // 1. Where its source says it was rendered: an element of its tag rendered there.
  const { source } = rec;
  if (source) {
    candidates = passing();
    const there = candidates.filter((el) => sameSource(resolveSource(el), source));
    if (there.length === 1) return there[0]!;
  }

  // 2. The selector it was captured with, while it still matches one element of its tag showing
  // what it showed. With nothing to check, only a selector naming a handle is trusted.
  const hits = queryAll(doc, rec.selector);
  const hit = hits.length === 1 && sameTag(hits[0]!) ? hits[0]! : null;
  if (hit && (check ? check.test(hit) : !positional(rec.selector))) return hit;

  // 3. Its tag and text: the one element showing it, else narrowed by class, then position.
  if (!check) return null;
  candidates ??= passing();
  if (candidates.length === 1) return candidates[0]!;
  return candidates.length ? narrow(candidates, rec) : null;
}

// A target found again: an element target by its first element (the others are drawn where they
// are found too); a region by the first of its elements still found, else at the box it was drawn
// as; a text target by an element holding its quote. Null when it isn't found.
export function refind(doc: Document, target: UiMarkTarget): Found | null {
  if (target.kind === "element") {
    const [first, ...rest] = target.elements;
    const primary = first && findElement(doc, first);
    if (!primary) return null;
    const els: [Element, ...Element[]] = [primary];
    for (const rec of rest) {
      const el = findElement(doc, rec);
      if (el && !els.includes(el)) els.push(el);
    }
    return { kind: "element", els };
  }
  if (target.kind === "region") {
    for (const rec of target.elements) {
      const el = findElement(doc, rec);
      if (el) return { kind: "region", rect: target.rect, anchor: { el, rect: rec.rect } };
    }
    return { kind: "region", rect: target.rect, anchor: null };
  }
  const holder = findElement(doc, target.element, quoting(target.quote), true);
  return holder ? { kind: "text", holder, quote: target.quote } : null;
}

// Whether a found target still stands as found: its elements still on the page, and a quote still
// in its holder. One that doesn't is looked for again.
export function stands(found: Found): boolean {
  if (found.kind === "element") return found.els.every((el) => el.isConnected);
  if (found.kind === "region") return !found.anchor || found.anchor.el.isConnected;
  return found.holder.isConnected && findQuote(found.holder, found.quote) !== null;
}

// Where a found target is now. A region's box keeps its offset from its anchor as the anchor
// moves. `find` finds a quote in its holder: a quoteFinder's, for marks redrawn again and again.
export function located(
  found: Found,
  find: (holder: Element, quote: string) => Range | null = findQuote,
): Located | null {
  const { kind } = found;
  if (found.kind === "element") {
    const [first, ...rest] = found.els;
    if (!first.isConnected) return null;
    const others = rest.filter((el) => el.isConnected).map(boxOf);
    return { kind, boxes: [boxOf(first), ...others], anchor: first };
  }
  if (found.kind === "region") {
    const { rect, anchor } = found;
    if (!anchor) return { kind, boxes: [rect], anchor: null };
    if (!anchor.el.isConnected) return null;
    const now = boxOf(anchor.el);
    // Hidden for now (no box): the box stays where it was drawn.
    if (now.width + now.height === 0) return { kind, boxes: [rect], anchor: null };
    const moved = { ...rect, x: rect.x + now.x - anchor.rect.x, y: rect.y + now.y - anchor.rect.y };
    return { kind, boxes: [moved], anchor: anchor.el };
  }
  if (!found.holder.isConnected) return null;
  const range = find(found.holder, found.quote);
  const [first, ...rest] = range ? textRects(range) : [];
  return first ? { kind, boxes: [first, ...rest], anchor: found.holder } : null;
}
