import type { PickedTarget, Rect, UiMarkTarget } from "../types";
import {
  CAPS,
  CONTROLS,
  HEADINGS,
  LANDMARKS,
  cap,
  describeElement,
  squash,
  targetOf,
} from "./describe";

// The targets beyond a single click: ⇧-clicked elements gathered into one pick, the meaningful
// elements under a dragged box, a text selection's quote and holder, and finding any of them again
// on the page for its mark. Read from the live DOM, never written to it; pure over the document
// (hit testing is passed in), so it runs under happy-dom in tests.

// A ⇧-click on `el`: added to the picks, or taken out when it's already there. Once the picks hold
// CAPS.elements, another is refused: the picks stay as they are and the answer is false.
export function togglePick(picks: Element[], el: Element): boolean {
  const i = picks.indexOf(el);
  if (i >= 0) picks.splice(i, 1);
  else if (picks.length < CAPS.elements) picks.push(el);
  else return false;
  return true;
}

// Elements an agent can name in a box: controls, landmarks, headings, media, and anything with text
// of its own.
const MEANINGFUL = `${CONTROLS}, ${LANDMARKS}, ${HEADINGS}, img, svg, canvas, video, picture, iframe`;
const ownText = (el: Element) =>
  [...el.childNodes].some((n) => n.nodeType === 3 && /\S/.test(n.textContent ?? ""));
// How far an element may stick out of the box and still count as inside it: a hand-dragged box
// rarely clears its contents' edges by a pixel.
const SLACK = 4;

const boxOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

// The meaningful elements wholly inside a dragged box (viewport CSS px), in document order, at most
// CAPS.elements. One inside another already taken is left out (the outer one's outline sketches it),
// and so is one hidden under another layer, such as page content under an open dialog: `at` is the
// page's hit test, the element on top at a point. With none inside (a box drawn within a canvas or
// a long paragraph), the element the box sits in, as a click at its centre would pick it; none over
// bare page.
export function regionElements(
  doc: Document,
  rect: Rect,
  at: (x: number, y: number) => Element | null,
): Element[] {
  const inside = (r: Rect) =>
    r.width > 0 &&
    r.height > 0 &&
    r.x >= rect.x - SLACK &&
    r.y >= rect.y - SLACK &&
    r.x + r.width <= rect.x + rect.width + SLACK &&
    r.y + r.height <= rect.y + rect.height + SLACK;
  const shown = (el: Element, r: Rect) => {
    const top = at(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && (top === el || el.contains(top));
  };
  const out: Element[] = [];
  for (const el of doc.body.querySelectorAll("*")) {
    if (out.length === CAPS.elements) break;
    if (out.some((o) => o.contains(el)) || !(el.matches(MEANINGFUL) || ownText(el))) continue;
    const r = boxOf(el);
    if (inside(r) && shown(el, r)) out.push(el);
  }
  if (out.length) return out;
  const hit = at(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const holder = hit && targetOf(hit);
  return holder ? [holder] : [];
}

// A text selection as a target: the selected text with its whitespace collapsed, capped, and the
// element holding all of it, resolved as a click on it would be (the control it's in, else
// itself). Null when only whitespace is selected.
export function textTarget(range: Range): Extract<PickedTarget, { kind: "text" }> | null {
  const quote = squash(range.toString());
  const node = range.commonAncestorContainer;
  const holder = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!quote || !holder) return null;
  return {
    kind: "text",
    quote: cap(quote, CAPS.quote),
    element: describeElement(targetOf(holder) ?? holder),
  };
}

// NodeFilter.SHOW_TEXT: the bridge's tests run where NodeFilter isn't a global.
const SHOW_TEXT = 4;

// `quote` found again in `root`'s text: a range over its first occurrence, compared with whitespace
// collapsed, as the quote was taken. A quote cut at its cap (ending in "…") is matched on what's
// left of it. Null when it isn't there.
export function findQuote(root: Element, quote: string): Range | null {
  const want = (quote.endsWith("…") ? quote.slice(0, -1) : quote).trim();
  if (!want) return null;
  const doc = root.ownerDocument;
  // The collapsed text, and for each of its characters the text node and offset it came from.
  let text = "";
  const from: Array<[Text, number]> = [];
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const parent = node.parentElement?.localName;
    if (parent === "script" || parent === "style") continue;
    for (let i = 0; i < node.data.length; i++) {
      const c = node.data[i]!;
      if (/\s/.test(c)) {
        if (!text || text.endsWith(" ")) continue;
        text += " ";
      } else text += c;
      from.push([node, i]);
    }
  }
  const i = text.indexOf(want);
  if (i < 0) return null;
  const [startNode, startOffset] = from[i]!;
  const [endNode, endOffset] = from[i + want.length - 1]!;
  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset + 1);
  return range;
}

// The boxes of the text a range runs over, one per line fragment: its text nodes' own rects, not
// the boxes of the elements it wholly contains, which Range.getClientRects adds.
export function textRects(range: Range): Rect[] {
  const root = range.commonAncestorContainer;
  const doc = root.ownerDocument;
  if (!doc) return [];
  const rects: Rect[] = [];
  const add = (node: Node) => {
    const part = doc.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    for (const r of part.getClientRects())
      if (r.width > 0 && r.height > 0)
        rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
  };
  if (root.nodeType === 3) add(root);
  else {
    const walker = doc.createTreeWalker(root, SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n)) add(n);
  }
  return rects;
}

const query = (doc: Document, selector: string) => {
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
};

// A mark's target where it is now: its boxes (the elements' boxes, the region's box, or the quote's
// line boxes; the pin goes on the first), and the element it moves with (the first element, the
// region's anchor, the quote's holder). Elements that are gone are left out; null when nothing of
// it is on the page.
export type Located = {
  kind: UiMarkTarget["kind"];
  boxes: [Rect, ...Rect[]];
  anchor: Element | null;
};

export function locate(doc: Document, target: UiMarkTarget): Located | null {
  const { kind } = target;
  if (target.kind === "element") {
    const els = target.selectors.map((s) => query(doc, s)).filter((el) => el !== null);
    const [first, ...rest] = els;
    return first ? { kind, boxes: [boxOf(first), ...rest.map(boxOf)], anchor: first } : null;
  }
  if (target.kind === "region") {
    const { rect, anchor } = target;
    const el = anchor ? query(doc, anchor.selector) : null;
    const now = el && boxOf(el);
    // An anchor that's gone, or hidden (no box), leaves the region where it was drawn.
    if (!anchor || !el || !now || now.width + now.height === 0)
      return { kind, boxes: [rect], anchor: null };
    const moved = { ...rect, x: rect.x + now.x - anchor.rect.x, y: rect.y + now.y - anchor.rect.y };
    return { kind, boxes: [moved], anchor: el };
  }
  const el = query(doc, target.selector);
  const range = el && findQuote(el, target.quote);
  const [first, ...rest] = range ? textRects(range) : [];
  return first ? { kind, boxes: [first, ...rest], anchor: el } : null;
}
