import type { GuideLink } from "../types";
import { MAP_TEXT, type MapLayout, type Measure, type Point, type Rect } from "./map-derive";

// What a drawn map must never do, read off the layout's own output. map-derive.test.ts runs it
// over the corpus with estimated text widths; the gallery runs it in a browser with the real ones.
// Not part of the desk's bundle.

// A rough width for each face, from the sans font's proportions: a sliver for narrow letters and
// punctuation, wider for capitals and m/w, the rest in between. Close enough to real widths that
// a layout passing with it passes in the browser; the gallery checks that claim.
export function estimateMeasure(): Measure {
  const size = { label: 10, title: 13 * 1.03, summary: 11.5 } as const;
  return (text, font) => {
    let em = 0;
    for (const ch of text) {
      if (ch === " ") em += 0.28;
      else if ("iljtfr.,:;'!|()".includes(ch)) em += 0.32;
      else if (/[A-Z]|[mw]/.test(ch)) em += 0.7;
      else if (/[0-9]/.test(ch)) em += 0.58;
      else em += 0.55;
    }
    return em * size[font];
  };
}

// A label or note line's ink: from the ascent above its baseline to the descent below.
const ASCENT = 8;
const DESCENT = 2;

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Whether an axis-aligned segment runs through a rect's inside.
function cuts([x1, y1]: Point, [x2, y2]: Point, r: Rect) {
  const lx = Math.min(x1, x2);
  const hx = Math.max(x1, x2);
  const ly = Math.min(y1, y2);
  const hy = Math.max(y1, y2);
  return lx < r.x + r.w && hx > r.x && ly < r.y + r.h && hy > r.y;
}

const segments = (pts: Point[]) => pts.slice(1).map((p, i) => [pts[i]!, p] as const);

// The rects a map's labels take, each with the links it speaks for, and its notes'.
export function mapTextRects(layout: MapLayout, measure: Measure) {
  const labels = layout.links.flatMap((l) => {
    const c = l.caption;
    if (!c) return [];
    const w = Math.max(...c.lines.map((s) => measure(s, "label")));
    const x = c.anchor === "middle" ? c.x - w / 2 : c.x;
    const h = (c.lines.length - 1) * MAP_TEXT.labelLine + ASCENT + DESCENT;
    return [{ links: c.links, rect: { x, y: c.y - ASCENT, w, h } }];
  });
  const notes = layout.links.flatMap((l) => {
    const n = l.note;
    if (!n) return [];
    const w = Math.max(...n.lines.map((s) => measure(s, "label")));
    return [{ link: l.key, rect: { x: n.x, y: n.y, w, h: n.lines.length * MAP_TEXT.labelLine } }];
  });
  return { labels, notes };
}

// Every way the layout breaks the map's invariants, one line each; empty when it holds.
export function mapProblems(layout: MapLayout, links: GuideLink[], measure: Measure): string[] {
  const out: string[] = [];
  const { boxW, boxH, width, height } = layout;
  const boxRect = (b: { x: number; y: number }) => ({ x: b.x, y: b.y, w: boxW, h: boxH });
  const { labels, notes } = mapTextRects(layout, measure);
  const inside = (r: Rect) =>
    r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= width + 0.5 && r.y + r.h <= height + 0.5;

  // No two boxes overlap.
  for (const [i, a] of layout.boxes.entries())
    for (const b of layout.boxes.slice(i + 1))
      if (overlap(boxRect(a), boxRect(b))) out.push(`boxes ${a.id} and ${b.id} overlap`);

  // Every box, heading, label and note lies inside the map.
  for (const b of layout.boxes) if (!inside(boxRect(b))) out.push(`box ${b.id} is outside the map`);
  for (const h of layout.heads)
    if (!inside({ x: h.x, y: h.y, w: h.w, h: 22 }))
      out.push(`heading ${h.label} is outside the map`);
  for (const l of labels)
    if (!inside(l.rect)) out.push(`label of ${l.links[0]} is outside the map`);
  for (const n of notes) if (!inside(n.rect)) out.push(`note for ${n.link} is outside the map`);
  for (const l of layout.links)
    for (const p of l.points ?? [])
      if (p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > height) {
        out.push(`line ${l.key} runs outside the map`);
        break;
      }

  // A box's text fits the box.
  for (const b of layout.boxes)
    if (b.text.y < b.y || b.text.y + b.text.h > b.y + boxH)
      out.push(`box ${b.id}'s text overflows it`);

  // No drawn line crosses the text of a box it does not start or end at.
  for (const l of layout.links)
    for (const [p, q] of segments(l.points ?? []))
      for (const b of layout.boxes)
        if (b.id !== l.from && b.id !== l.to && cuts(p, q, b.text))
          out.push(`line ${l.key} crosses ${b.id}'s text`);

  // Every link is drawn or noted, exactly once, and nothing else is.
  const want = new Set(links.map((l) => `${l.from}>${l.to}`));
  const seen = new Map<string, number>();
  for (const l of layout.links) {
    const ways = (l.points ? 1 : 0) + (l.note ? 1 : 0);
    if (ways !== 1) out.push(`link ${l.key} is drawn or noted ${ways} times`);
    seen.set(l.key, (seen.get(l.key) ?? 0) + 1);
    if (!want.has(l.key)) out.push(`link ${l.key} is not in the guide`);
  }
  for (const k of want)
    if (seen.get(k) !== 1) out.push(`link ${k} appears ${seen.get(k) ?? 0} times`);

  // Every drawn link's label is said by some label on the map.
  const said = new Set(labels.flatMap((l) => l.links));
  for (const l of layout.links)
    if (l.points && !said.has(l.key)) out.push(`link ${l.key}'s label is never shown`);

  // A label never lies on another link's line, nor under a box (the boxes are drawn over the lines).
  for (const lab of labels) {
    for (const l of layout.links) {
      if (lab.links.includes(l.key)) continue;
      if (segments(l.points ?? []).some(([p, q]) => cuts(p, q, lab.rect)))
        out.push(`label of ${lab.links[0]} lies on line ${l.key}`);
    }
    for (const b of layout.boxes)
      if (overlap(lab.rect, boxRect(b)))
        out.push(`label of ${lab.links[0]} lies under box ${b.id}`);
  }
  // Notes sit clear of boxes, lines and each other; labels clear of each other.
  for (const n of notes) {
    for (const b of layout.boxes)
      if (overlap(n.rect, boxRect(b))) out.push(`note for ${n.link} lies on box ${b.id}`);
    for (const l of layout.links)
      if (segments(l.points ?? []).some(([p, q]) => cuts(p, q, n.rect)))
        out.push(`note for ${n.link} lies on line ${l.key}`);
  }
  const texts = [
    ...labels.map((l) => ({ name: `label of ${l.links[0]}`, rect: l.rect })),
    ...notes.map((n) => ({ name: `note for ${n.link}`, rect: n.rect })),
  ];
  for (const [i, a] of texts.entries())
    for (const b of texts.slice(i + 1))
      if (overlap(a.rect, b.rect)) out.push(`${a.name} overlaps ${b.name}`);

  return out;
}
