import type { PickedTarget, Rect } from "../types";
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
// elements under a dragged box, a text selection's quote and holder, and finding a quote again in
// its holder for its mark (refind.ts finds the rest). Read from the live DOM, never written to it;
// pure over the document (hit testing is passed in), so it runs under happy-dom in tests.

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
  const quote = rangeQuote(range);
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
// Text nodes that aren't the page's text: the source of its scripts and styles.
const pageText = (node: Node) => {
  const parent = node.parentElement?.localName;
  return parent !== "script" && parent !== "style" && parent !== "noscript";
};

// The page's text a range runs over, one range per text node, cut to the range's ends. Script and
// style source between its ends isn't part of it: a drag that ends on a layer the app appends to
// <body> runs over everything in between.
function textParts(range: Range): Range[] {
  const root = range.commonAncestorContainer;
  const doc = root.ownerDocument;
  if (!doc) return [];
  const part = (node: Node) => {
    const r = doc.createRange();
    r.selectNodeContents(node);
    if (node === range.startContainer) r.setStart(node, range.startOffset);
    if (node === range.endContainer) r.setEnd(node, range.endOffset);
    return r;
  };
  if (root.nodeType === 3) return pageText(root) ? [part(root)] : [];
  const parts: Range[] = [];
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  // From the range's first text node when it starts in one, not from the top of `root`, and only
  // as far as its end: text nodes in a range come one after another.
  const start = range.startContainer;
  if (start.nodeType === 3) walker.currentNode = start;
  let inside = false;
  for (let n = start.nodeType === 3 ? start : walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) {
      if (inside) break;
      continue;
    }
    inside = true;
    if (pageText(n)) parts.push(part(n));
  }
  return parts;
}

// The page's text a range runs over, whitespace collapsed: what a quote of it says.
const rangeQuote = (range: Range) =>
  squash(
    textParts(range)
      .map((part) => part.toString())
      .join(""),
  );

// What a quote matches on: all of it, or what's left of one cut at its cap (ending in "…").
const quoted = (quote: string) => (quote.endsWith("…") ? quote.slice(0, -1) : quote).trim();

// The page's text under `root` with its whitespace collapsed, as quotes are taken, and where each
// text node's share of it starts. `trimmed`: the node's leading whitespace collapsed into the space
// before it (or into nothing, at the start).
function collapsedText(root: Element) {
  let text = "";
  const parts: Array<{ node: Text; at: number; trimmed: boolean }> = [];
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!pageText(n)) continue;
    const node = n as Text;
    let piece = node.data.replace(/\s+/g, " ");
    const trimmed = piece.startsWith(" ") && (!text || text.endsWith(" "));
    if (trimmed) piece = piece.slice(1);
    if (!piece) continue;
    parts.push({ node, at: text.length, trimmed });
    text += piece;
  }
  return { text, parts };
}

// The offset in its text node of the collapsed text's character `i`, by walking that node alone.
function offsetIn(part: { node: Text; at: number; trimmed: boolean }, i: number): number {
  const data = part.node.data;
  const space = (r: number) => /\s/.test(data[r]!);
  for (let r = 0, k = part.at; r < data.length; r++) {
    if (space(r) && (r === 0 ? part.trimmed : space(r - 1))) continue;
    if (k === i) return r;
    k++;
  }
  return data.length;
}

// `quote` found again in `root`'s text: a range over its first occurrence, compared with whitespace
// collapsed, as the quote was taken. A quote cut at its cap (ending in "…") is matched on what's
// left of it. Null when it isn't there.
export function findQuote(root: Element, quote: string): Range | null {
  const want = quoted(quote);
  if (!want) return null;
  const { text, parts } = collapsedText(root);
  const i = text.indexOf(want);
  if (i < 0) return null;
  const end = i + want.length - 1;
  // The text node holding the collapsed text's character `k`: the last to start at or before it.
  const partAt = (k: number) => {
    let lo = 0;
    let hi = parts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (parts[mid]!.at <= k) lo = mid;
      else hi = mid - 1;
    }
    return parts[lo]!;
  };
  const first = partAt(i);
  const last = partAt(end);
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, offsetIn(first, i));
  range.setEnd(last.node, offsetIn(last, end) + 1);
  return range;
}

// How long a quote that wasn't found is left alone before it's searched for again.
const RETRY_MISS = 1000;

// findQuote for the marks the page redraws on every scroll frame and every half second: a found
// range is kept per mark and reused while it still quotes the same text inside its holder. A
// quote that wasn't there is searched for again only after RETRY_MISS, since each search reads all
// of its holder's text.
export function quoteFinder(now = () => performance.now()) {
  const found = new Map<string, { range: Range | null; at: number }>();
  return {
    find(key: string, holder: Element, quote: string): Range | null {
      const seen = found.get(key);
      const r = seen?.range;
      if (r) {
        const intact =
          r.startContainer.isConnected &&
          r.endContainer.isConnected &&
          holder.contains(r.commonAncestorContainer) &&
          rangeQuote(r) === quoted(quote);
        if (intact) return r;
      } else if (seen && now() - seen.at < RETRY_MISS) return null;
      const range = findQuote(holder, quote);
      found.set(key, { range, at: now() });
      return range;
    },
    // Forget the marks no longer drawn, and the page text their ranges hold on to.
    keep(keys: ReadonlySet<string>) {
      for (const key of found.keys()) if (!keys.has(key)) found.delete(key);
    },
  };
}

// The boxes of the text a range runs over, one per line fragment: its text nodes' own rects, not
// the boxes of the elements it wholly contains, which Range.getClientRects adds.
export function textRects(range: Range): Rect[] {
  return textParts(range).flatMap((part) =>
    [...part.getClientRects()]
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
  );
}
