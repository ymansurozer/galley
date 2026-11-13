import type { GuideLink } from "../types";
import {
  LANE,
  linkKey,
  MAP_TEXT,
  type MapLabel,
  type MapLayout,
  type MapLink,
  type Measure,
  type Point,
  type Rect,
} from "./map-derive";

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
// Two links' parallel runs closer than this read as one line.
const TRACK = 5;
// A label closer than this to an arrowhead crowds it.
const ARROW_GAP = 4;
// Two texts closer than this read as one.
const TEXT_GAP = 4;
// A box's rounded corner (7 px), which an arrowhead must not land on. A line may leave a little
// nearer the edge (a crossing link's strip, 6 px in), where the corner bends the edge by under a
// third of a pixel.
const CORNER = 8;
const CORNER_START = 5;
// A stage-side jog's clearance from its column.
const JOG_ROOM = 16;

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// The gap between two rects (0 when they touch or overlap).
const rectGap = (a: Rect, b: Rect) =>
  Math.hypot(
    Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)),
    Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)),
  );

const segRect = ([x1, y1]: Point, [x2, y2]: Point): Rect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
});

// Whether an axis-aligned segment runs through a rect's inside.
function cuts(p: Point, q: Point, r: Rect) {
  const s = segRect(p, q);
  return s.x < r.x + r.w && s.x + s.w > r.x && s.y < r.y + r.h && s.y + s.h > r.y;
}

const segments = (pts: Point[] = []) => pts.slice(1).map((p, i) => [pts[i]!, p] as const);

// How close a text rect comes to a link's line.
const lineGap = (r: Rect, l: MapLink) =>
  Math.min(Infinity, ...segments(l.points).map(([p, q]) => rectGap(r, segRect(p, q))));

// The room an arrowhead takes at a path's end.
function arrowRect(pts: Point[]): Rect {
  const [x, y] = pts[pts.length - 1]!;
  const [px, py] = pts[pts.length - 2]!;
  const ux = Math.sign(x - px);
  const uy = Math.sign(y - py);
  return segRect([x - ux * 5 - uy * 3, y - uy * 5 - ux * 3], [x + uy * 3, y + ux * 3]);
}

export function labelRect(c: MapLabel, measure: Measure): Rect {
  const w = Math.max(...c.lines.map((s) => measure(s, "label")));
  const h = (c.lines.length - 1) * MAP_TEXT.labelLine + ASCENT + DESCENT;
  return { x: c.x, y: c.y - ASCENT, w, h };
}

// The rects a map's labels take, each with the links it speaks for, and its notes'.
export function mapTextRects(layout: MapLayout, measure: Measure) {
  const labels = layout.links.flatMap((l) =>
    (
      [
        [l.caption, "label"],
        [l.echo, "repeated label"],
      ] as const
    ).flatMap(([c, what]) =>
      c ? [{ name: `${what} of ${l.key}`, links: c.links, rect: labelRect(c, measure) }] : [],
    ),
  );
  const notes = layout.links.flatMap((l) => {
    const n = l.note;
    if (!n) return [];
    // Its later lines hang in by the indent.
    const w = Math.max(...n.lines.map((s, i) => (i ? n.indent : 0) + measure(s, "label")));
    return [
      {
        name: `note for ${l.key}`,
        link: l.key,
        rect: { x: n.x, y: n.y, w, h: n.lines.length * MAP_TEXT.labelLine },
      },
    ];
  });
  return { labels, notes };
}

// Two links that leave by one exit share their first run: a fan's branches, or links that leave a
// box with one label.
const shareExit = (a: MapLink, b: MapLink) =>
  a.from === b.from &&
  a.kind === "forward" &&
  b.kind === "forward" &&
  (a.fan && b.fan ? true : a.label === b.label);

// Every way the layout breaks the map's invariants, one line each; empty when it holds.
export function mapProblems(layout: MapLayout, links: GuideLink[], measure: Measure): string[] {
  const out: string[] = [];
  const { boxW, boxH, width, height } = layout;
  const boxRect = (b: { x: number; y: number }) => ({ x: b.x, y: b.y, w: boxW, h: boxH });
  const boxOf = new Map(layout.boxes.map((b) => [b.id, b]));
  const { labels, notes } = mapTextRects(layout, measure);
  const inside = (r: Rect) =>
    r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= width + 0.5 && r.y + r.h <= height + 0.5;
  const drawn = layout.links.filter((l) => l.points);

  // No two boxes overlap.
  for (const [i, a] of layout.boxes.entries())
    for (const b of layout.boxes.slice(i + 1))
      if (overlap(boxRect(a), boxRect(b))) out.push(`boxes ${a.id} and ${b.id} overlap`);

  // Every box, heading, label and note lies inside the map.
  for (const b of layout.boxes) if (!inside(boxRect(b))) out.push(`box ${b.id} is outside the map`);
  for (const h of layout.heads)
    if (!inside({ x: h.x, y: h.y, w: h.w, h: 22 }))
      out.push(`heading ${h.label} is outside the map`);
  for (const t of [...labels, ...notes])
    if (!inside(t.rect)) out.push(`${t.name} is outside the map`);
  for (const l of drawn)
    if (l.points!.some(([x, y]) => x < 0 || x > width || y < 0 || y > height))
      out.push(`line ${l.key} runs outside the map`);

  // A box's text fits the box.
  for (const b of layout.boxes)
    if (b.text.y < b.y || b.text.y + b.text.h > b.y + boxH)
      out.push(`box ${b.id}'s text overflows it`);

  // No drawn line crosses the text of a box it does not start or end at.
  for (const l of drawn)
    for (const [p, q] of segments(l.points))
      for (const b of layout.boxes)
        if (b.id !== l.from && b.id !== l.to && cuts(p, q, b.text))
          out.push(`line ${l.key} crosses ${b.id}'s text`);

  // Every link is drawn or noted, exactly once, and nothing else is.
  const want = new Set(links.map((l) => linkKey(l.from, l.to)));
  const seen = new Map<string, number>();
  for (const l of layout.links) {
    const ways = (l.points ? 1 : 0) + (l.note ? 1 : 0);
    if (ways !== 1) out.push(`link ${l.key} is drawn or noted ${ways} times`);
    seen.set(l.key, (seen.get(l.key) ?? 0) + 1);
    if (!want.has(l.key)) out.push(`link ${l.key} is not in the guide`);
  }
  for (const k of want)
    if (seen.get(k) !== 1) out.push(`link ${k} appears ${seen.get(k) ?? 0} times`);

  // Every drawn link's label is said by some label on the map; a link that crosses two boxes or
  // more says it again before the box it reaches.
  const said = new Set(labels.flatMap((l) => l.links));
  for (const l of drawn) if (!said.has(l.key)) out.push(`link ${l.key}'s label is never shown`);
  for (const l of drawn)
    if (new Set(l.crossings.map((c) => c.box)).size >= 2 && !l.echo)
      out.push(
        `link ${l.key} crosses ${l.crossings.length} boxes and is labelled only at its start`,
      );

  // Two links never run on one track: their parallel runs stay apart, unless they leave by one
  // exit. Their lanes up and down a gap stand at least LANE apart, so they read as two at a
  // glance. (Level runs leave at the exit heights a box's size sets, so they keep only TRACK.)
  const beside = (p: Point, q: Point, r: Point, s: Point, flat: boolean, apart: number) => {
    const [across, along] = flat ? [1, 0] : [0, 1];
    if (Math.abs(p[across]! - r[across]!) >= apart) return false;
    const lo = Math.max(Math.min(p[along]!, q[along]!), Math.min(r[along]!, s[along]!));
    const hi = Math.min(Math.max(p[along]!, q[along]!), Math.max(r[along]!, s[along]!));
    return hi - lo > 2;
  };
  for (const [i, a] of drawn.entries())
    for (const b of drawn.slice(i + 1)) {
      if (shareExit(a, b)) continue;
      const runs = segments(a.points).flatMap(([p, q]) =>
        segments(b.points).map(([r, s]) => [p, q, r, s] as const),
      );
      const flat = runs.filter(([p, q, r, s]) => p[1] === q[1] && r[1] === s[1]);
      const upright = runs.filter(([p, q, r, s]) => p[0] === q[0] && r[0] === s[0]);
      if (
        [...flat.map((r) => [r, true] as const), ...upright.map((r) => [r, false] as const)].some(
          ([[p, q, r, s], f]) => beside(p, q, r, s, f, TRACK),
        )
      )
        out.push(`lines ${a.key} and ${b.key} run on one track`);
      else if (upright.some(([p, q, r, s]) => beside(p, q, r, s, false, LANE)))
        out.push(`the lanes of ${a.key} and ${b.key} stand under ${LANE} px apart`);
    }

  // Every line leaves its source and every arrowhead lands on its target on a straight stretch
  // of the box's edge, not off it and not on a rounded corner.
  for (const l of drawn) {
    const pts = l.points!;
    for (const [end, id, prev] of [
      [pts[0]!, l.from, pts[1]!],
      [pts[pts.length - 1]!, l.to, pts[pts.length - 2]!],
    ] as const) {
      const b = boxOf.get(id)!;
      const corner = id === l.to ? CORNER : CORNER_START;
      const flat = end[1] === prev[1];
      const onEdge = flat
        ? (end[0] === b.x || end[0] === b.x + boxW) &&
          end[1] >= b.y + corner &&
          end[1] <= b.y + boxH - corner
        : (end[1] === b.y || end[1] === b.y + boxH) &&
          end[0] >= b.x + corner &&
          end[0] <= b.x + boxW - corner;
      if (!onEdge) out.push(`line ${l.key} ${id === l.to ? "ends" : "starts"} off ${id}'s edge`);
    }
    // A jog round the side keeps clear of its column.
    if (l.kind === "same" && pts.length === 4 && pts[1]![0] - pts[0]![0] < JOG_ROOM)
      out.push(`line ${l.key} jogs too close to its column`);
  }

  // A label is nearer its own line than any other, and lies on no line and under no box (the
  // boxes are drawn over the lines). It keeps clear of other text and of arrowheads.
  for (const lab of labels) {
    const mine = drawn.filter((l) => lab.links.includes(l.key));
    const own = Math.min(...mine.map((l) => lineGap(lab.rect, l)));
    // Not even its own line runs through it.
    for (const l of mine)
      if (segments(l.points).some(([p, q]) => cuts(p, q, lab.rect)))
        out.push(`${lab.name} lies on its own line`);
    for (const l of drawn) {
      if (lab.links.includes(l.key) || mine.some((m) => shareExit(m, l) && m.fan)) continue;
      const gap = lineGap(lab.rect, l);
      if (segments(l.points).some(([p, q]) => cuts(p, q, lab.rect)))
        out.push(`${lab.name} lies on line ${l.key}`);
      else if (gap <= own) out.push(`${lab.name} is as near line ${l.key} as its own`);
    }
    for (const b of layout.boxes)
      if (overlap(lab.rect, boxRect(b))) out.push(`${lab.name} lies under box ${b.id}`);
    for (const l of drawn)
      if (rectGap(lab.rect, arrowRect(l.points!)) < ARROW_GAP)
        out.push(`${lab.name} touches the arrowhead of ${l.key}`);
    for (const h of layout.heads)
      if (overlap(lab.rect, { x: h.x, y: h.y, w: h.w, h: 22 }))
        out.push(`${lab.name} lies on heading ${h.label}`);
  }
  // Notes sit clear of boxes and lines.
  for (const n of notes) {
    for (const b of layout.boxes)
      if (overlap(n.rect, boxRect(b))) out.push(`${n.name} lies on box ${b.id}`);
    for (const l of drawn)
      if (segments(l.points).some(([p, q]) => cuts(p, q, n.rect)))
        out.push(`${n.name} lies on line ${l.key}`);
  }
  const texts = [...labels, ...notes];
  for (const [i, a] of texts.entries())
    for (const b of texts.slice(i + 1))
      if (rectGap(a.rect, b.rect) < TEXT_GAP) out.push(`${a.name} runs into ${b.name}`);
  return out;
}
