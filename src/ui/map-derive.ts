import type { GuideLink } from "../types";

// The Overview's map, laid out from the guide alone: one column per stage, one box per group, a
// line per link. Pure geometry — the text measurer is passed in, so it runs without a browser —
// and map-dom.ts draws it. The rules, settled with the reviewer over many shapes of change:
//   - fewer than three groups: no map. No links at all: every stage is a column of boxes, no lines.
//   - boxes carry the group's summary while there is room (each column at least 176 px, no stage
//     over five groups); beyond that they show the title only.
//   - a group sits level with the middle of what feeds it.
//   - a group that feeds others with different labels gets one exit per label, with room for each
//     label, and the box grows if it must. A group that feeds three or more fans out like a tree,
//     each branch labelled on its own run.
//   - a link inside a stage runs straight between neighbours, or jogs round the side.
//   - a link back to an earlier stage is a note under its source, not a line.
//   - a link that skips a stage where a box stands in its way runs along that box's bottom or top
//     strip, where no text sits, with its label under or over its own box; its stretch inside the
//     box is reported (crossings), so the drawing can show it as light dots over the box. Rows
//     stand further apart when a map has such a link, to make room for those labels.
//   - a stage nothing flows into or out of sits apart in the last column.

export type MapGroup = { id: string; title: string; summary?: string };
export type MapStage = { id: string; label: string; groups: MapGroup[] };
// The three faces the map sets text in; the measurer maps each to a real font.
export type MapFont = "label" | "title" | "summary";
// The width of one line of text, in px.
export type Measure = (text: string, font: MapFont) => number;

export type Point = [number, number];
export type Rect = { x: number; y: number; w: number; h: number };

// The text metrics the drawing uses; the layout leaves room by them, map-dom.ts sets them.
export const MAP_TEXT = {
  // A label or note line, 10 px type.
  labelLine: 12,
  // A title line, 13 px type.
  titleLine: 16,
  // A summary line, 11.5 px type, under the title with a 4 px gap.
  summaryLine: 15,
  summaryGap: 4,
  // A box's padding round its text: cards start at the top, titles alone sit in the middle.
  padX: 12,
  cardPadTop: 10,
} as const;

export type MapHead = { label: string; x: number; y: number; w: number };
// A box at x, y (the layout's boxW by boxH). `text` is where its title and summary sit.
export type MapBox = {
  id: string;
  x: number;
  y: number;
  title: string[];
  summary: string[];
  text: Rect;
};
// A label: its first baseline at y, each line labelLine below the last. `links` are the keys of
// the links it speaks for: a label is said once per exit, so links leaving a box together share it.
export type MapLabel = {
  x: number;
  y: number;
  anchor: "start" | "middle";
  lines: string[];
  links: string[];
};
// A note under its source box: its first line's top at y.
export type MapNote = { x: number; y: number; lines: string[] };
// A crossing link's stretch inside a box it passes.
export type MapCrossing = { box: string; x1: number; x2: number; y: number };
export type MapLinkKind = "forward" | "same" | "back";
export type MapLink = {
  from: string;
  to: string;
  label: string;
  // `${from}>${to}`, unique: the guide refuses a repeated pair.
  key: string;
  kind: MapLinkKind;
  // A drawn link: its corners, start to end (the end has the arrow). A link back has none.
  points?: Point[];
  // The label this link's line carries, when it is the one that says it.
  caption?: MapLabel;
  // A link back to an earlier stage: the note that stands for it.
  note?: MapNote;
  crossings: MapCrossing[];
};
export type MapLayout = {
  // Boxes with the summary under the title (cards), or the title only.
  cards: boolean;
  width: number;
  height: number;
  boxW: number;
  boxH: number;
  heads: MapHead[];
  boxes: MapBox[];
  links: MapLink[];
};

// The width the map is laid out for when the caller gives none.
export const MAP_WIDTH = 1084;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// Words onto lines of at most `w` px; a word wider than the line keeps a line of its own.
export function wrapText(measure: Measure, text: string, w: number, font: MapFont): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, font) > w) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

type Edge = {
  from: string;
  to: string;
  label: string;
  key: string;
  kind: MapLinkKind;
  fan: boolean;
  // Boxes standing in the run of a link that skips stages.
  over: string[];
  under: boolean;
  strip?: "top" | "bottom";
  // The row whose strip it runs along.
  stripRow?: number;
  tight: boolean;
  note?: { at: number; lines: string[] };
  pts?: Point[];
  lab?: {
    x: number;
    y: number;
    anchor: "start" | "middle";
    w: number;
    mode: "up" | "down" | "mid";
  };
  shown?: MapLabel;
  // A jog round the side of its stage: the box it reaches, and whether downwards.
  jog?: { to: string; down: boolean };
  cross: MapCrossing[];
};

export function layoutMap(
  stages: MapStage[],
  links: GuideLink[],
  measure: Measure,
  avail = MAP_WIDTH,
): MapLayout | null {
  const group = new Map(stages.flatMap((s) => s.groups.map((g) => [g.id, g] as const)));
  const ids = [...group.keys()];
  if (ids.length < 3) return null;
  const wrap = (text: string, w: number, font: MapFont = "label") =>
    wrapText(measure, text, w, font);
  const titleOf = (id: string) => group.get(id)!.title;

  const E: Edge[] = links
    .filter((l) => group.has(l.from) && group.has(l.to) && l.from !== l.to)
    .map((l) => ({
      from: l.from,
      to: l.to,
      label: l.label,
      key: `${l.from}>${l.to}`,
      kind: "forward",
      fan: false,
      over: [],
      under: false,
      tight: false,
      cross: [],
    }));
  const touched = new Set(E.flatMap((e) => [e.from, e.to]));
  let flow = stages.filter((s) => s.groups.some((g) => touched.has(g.id)));
  let apart = stages.filter((s) => !flow.includes(s));
  if (!flow.length) {
    flow = stages.slice();
    apart = [];
  }

  // Width: cards with the summary while they fit, titles only when the map gets wide or tall.
  const n = flow.length;
  const GAP = 84;
  const Y0 = 34;
  const fit = Math.floor((avail - (n - 1) * GAP) / n);
  const maxRows = Math.max(...flow.map((s) => s.groups.length));
  const cards = fit >= 176 && maxRows <= 5;
  const NW = clamp(fit, 132, cards ? 200 : 184);
  const W =
    n === 1 ? NW : Math.max(n * NW + (n - 1) * GAP, Math.min(avail, n * NW + (n - 1) * 140));
  const gap = n > 1 ? (W - n * NW) / (n - 1) : 0;

  // Columns from stages; a group sits level with the lower median of what feeds it.
  const COL = new Map<string, number>();
  const SLOT = new Map<string, number>();
  const col = (id: string) => COL.get(id)!;
  const slot = (id: string) => SLOT.get(id)!;
  flow.forEach((s, ci) => s.groups.forEach((g) => COL.set(g.id, ci)));
  for (const e of E)
    e.kind = col(e.to) > col(e.from) ? "forward" : col(e.to) === col(e.from) ? "same" : "back";
  flow.forEach((s, ci) => {
    const med = (id: string) => {
      const p = E.filter((e) => e.to === id && e.kind === "forward")
        .map((e) => slot(e.from))
        .sort((a, b) => a - b);
      return p.length ? p[(p.length - 1) >> 1]! : null;
    };
    const ranked = s.groups.map((g, i) => ({ id: g.id, i, want: ci === 0 ? i : med(g.id) }));
    let last = -1;
    const placed = ranked.filter((r) => r.want !== null) as Array<{
      id: string;
      i: number;
      want: number;
    }>;
    for (const r of placed.sort((a, b) => a.want - b.want || a.i - b.i)) {
      SLOT.set(r.id, Math.max(r.want, last + 1));
      last = slot(r.id);
    }
    for (const r of ranked.filter((r) => r.want === null)) {
      const peer = E.find((e) => e.from === r.id && e.kind === "same" && SLOT.has(e.to));
      SLOT.set(r.id, Math.max(peer ? slot(peer.to) + 1 : 0, last + 1));
      last = slot(r.id);
    }
  });
  let rows = Math.max(...SLOT.values()) + 1;

  // A group that feeds three or more others fans out like a tree to those it alone feeds: one
  // exit, a bend near the source, each branch labelled on its own run. Everything else bends near
  // its target, as links gathering into one box should.
  const fwd = E.filter((e) => e.kind === "forward");
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const e of fwd) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  for (const e of fwd) e.fan = outDeg.get(e.from)! >= 3 && inDeg.get(e.to) === 1;
  // A link that skips stages may find boxes standing in its run (over). It crosses them.
  for (const e of fwd) {
    const row = e.fan ? slot(e.to) : slot(e.from);
    e.over = [...COL.keys()].filter(
      (id) => col(id) > col(e.from) && col(id) < col(e.to) && slot(id) === row,
    );
    e.under = e.over.length > 0;
  }
  const drawn = fwd;

  // A link back to an earlier stage is a note under its source.
  const notes = new Map<string, { edges: Edge[]; lines: number }>();
  for (const e of E)
    if (e.kind === "back")
      (notes.get(e.from) ?? notes.set(e.from, { edges: [], lines: 0 }).get(e.from)!).edges.push(e);
  for (const [id, nt] of notes) {
    // A straight link to the box below already has its label in that gap; keep to the left half.
    const shared = E.some(
      (e) =>
        e.kind === "same" &&
        Math.abs(slot(e.from) - slot(e.to)) === 1 &&
        Math.min(slot(e.from), slot(e.to)) === slot(id) &&
        col(e.from) === col(id),
    );
    const nw = shared ? NW / 2 - 6 : NW - 4;
    let at = 0;
    for (const e of nt.edges) {
      const lines = wrap(`↩ ${titleOf(e.to)} · ${e.label}`, nw);
      e.note = { at, lines };
      at += lines.length;
    }
    nt.lines = at;
  }
  const noteLines = Math.max(0, ...[...notes.values()].map((nt) => nt.lines));

  // Exits: one per label for links that bend near their target, one for a whole fan. Each exit
  // keeps room above its line for its label (measured at the narrowest a label can get).
  type Exit = { es: Edge[]; at: number; lines: number; y: number };
  const exits = new Map<string, { gs: Exit[]; span: number }>();
  let need = 0;
  const FAN = "\u0000fan";
  for (const id of COL.keys()) {
    const by = new Map<string, Edge[]>();
    for (const e of drawn)
      if (e.from === id) {
        const k = e.fan ? FAN : e.label;
        (by.get(k) ?? by.set(k, []).get(k)!).push(e);
      }
    if (!by.size) continue;
    const gs: Exit[] = [...by.entries()]
      .map(([k, es]) => ({
        es,
        at: es.reduce((a, e) => a + slot(e.to), 0) / es.length,
        lines: k === FAN ? 1 : wrap(k, 60).length,
        y: 0,
      }))
      .sort((a, b) => a.at - b.at);
    let y = 0;
    gs.forEach((g, i) => {
      if (i) y += 10 + 12 * g.lines;
      g.y = y;
    });
    exits.set(id, { gs, span: y });
    need = Math.max(need, y);
  }

  // Height: the tallest card's text, or the room the busiest box needs for its exits.
  const titles = new Map(ids.map((id) => [id, wrap(titleOf(id), NW - 2 * MAP_TEXT.padX, "title")]));
  const summaries = new Map(
    ids.map((id) => {
      const s = group.get(id)!.summary;
      return [id, cards && s ? wrap(s, NW - 2 * MAP_TEXT.padX, "summary") : []];
    }),
  );
  const textH = (id: string) =>
    titles.get(id)!.length * MAP_TEXT.titleLine +
    (summaries.get(id)!.length
      ? MAP_TEXT.summaryGap + summaries.get(id)!.length * MAP_TEXT.summaryLine
      : 0);
  const text = cards
    ? Math.max(76, Math.max(...ids.map(textH)) + 26)
    : Math.max(44, Math.max(...ids.map((id) => titles.get(id)!.length)) * MAP_TEXT.titleLine + 14);
  const PM0 = text < 60 ? 10 : 14;
  const NH = Math.max(text, Math.min(need, 110) + 2 * PM0);
  const PM = NH < 60 ? 10 : 14;
  const PS = NH < 60 ? 12 : 20;
  // A crossing link's label sits above or below its box, so the rows stand further apart.
  const marginGap = fwd.some((e) => e.under) ? 60 : 0;
  const ROWP = NH + Math.max(cards ? 34 : 36, 10 + noteLines * 12 + 8, marginGap);

  const X = (ci: number) => Math.round(ci * (NW + gap));
  const box = new Map<string, { x: number; y: number }>();
  for (const id of COL.keys()) box.set(id, { x: X(col(id)), y: Y0 + slot(id) * ROWP });
  const at = (id: string) => box.get(id)!;
  const heads: MapHead[] = flow.map((s, ci) => ({ label: s.label, x: X(ci), y: 0, w: NW }));
  // A stage nothing flows into or out of takes the lowest run of free rows of the last column with
  // a free row above it for its heading, its groups in the guide's order; or, short of one, rows
  // of its own under the map, dropped by a heading's height below what is above.
  const lastCol = n - 1;
  const used = new Set([...COL.keys()].filter((id) => col(id) === lastCol).map(slot));
  let drop = 0;
  for (const s of apart) {
    const k = s.groups.length;
    const free = (from: number) =>
      !used.has(from - 1) &&
      Array.from({ length: k }, (_, i) => from + i).every((r) => !used.has(r));
    let top = -1;
    for (let r = rows - k; r >= 1; r--)
      if (free(r)) {
        top = r;
        break;
      }
    let y = Y0 + top * ROWP;
    if (top < 0) {
      top = rows;
      drop += 30;
      y = Y0 + top * ROWP + drop;
    }
    s.groups.forEach((g, i) => {
      box.set(g.id, { x: X(lastCol), y: y + i * ROWP });
      used.add(top + i);
    });
    rows = Math.max(rows, top + k);
    heads.push({ label: s.label, x: X(lastCol), y: y - 32, w: NW });
  }

  const outY = new Map<string, number>();
  for (const [id, { gs, span }] of exits) {
    const room = NH - 2 * PM;
    const k = span > room ? room / span : 1;
    for (const g of gs)
      for (const e of g.es) {
        outY.set(e.key, Math.round(at(id).y + NH / 2 - (span * k) / 2 + g.y * k));
        e.tight = k < 0.7;
      }
  }
  // Where each drawn link enters its target. A box with one way in takes it at its middle.
  const port = new Map<string, number>();
  for (const id of COL.keys()) {
    const b = at(id);
    const inc = drawn.filter((e) => e.to === id);
    if (inc.length === 1 && inc[0]!.fan) {
      port.set(inc[0]!.key, b.y + NH / 2);
      continue;
    }
    const want = inc
      .map((e) => ({ e, y: clamp(outY.get(e.key)! - b.y, PM, NH - PM) }))
      .sort((a, c) => a.y - c.y);
    for (let i = 1; i < want.length; i++) want[i]!.y = Math.max(want[i]!.y, want[i - 1]!.y + PS);
    const over = want.length ? want[want.length - 1]!.y - (NH - 10) : 0;
    if (over > 0) for (const w of want) w.y -= over;
    for (const w of want) port.set(w.e.key, b.y + w.y);
  }

  // Where a box's title and summary sit: a card's start at the top, a title alone in the middle.
  const textRect = (id: string): Rect => {
    const b = at(id);
    const h = textH(id);
    const top = cards ? MAP_TEXT.cardPadTop : (NH - h) / 2;
    return { x: b.x + MAP_TEXT.padX, y: b.y + top, w: NW - 2 * MAP_TEXT.padX, h };
  };

  // Whether a line at height y passes the boxes clear of their text.
  const clearOfText = (over: string[], y: number) =>
    over.every((id) => {
      const r = textRect(id);
      return y < r.y - 2 || y > r.y + r.h + 2;
    });

  // A crossing link takes a strip along the bottom or top of its row's boxes. The strips lie
  // outside where a box's own lines may leave or arrive, so they are free, and no text sits there
  // (a card's title starts high, so its inner top strip may not be). A row has up to four; a link
  // past them falls back to a free height inside the boxes, clear of their text.
  const strips = new Map<number, Set<number>>();
  const moved = new Set<Edge>();
  const setEnd = (e: Edge, y: number) => (e.fan ? port : outY).set(e.key, y);
  for (const e of drawn.filter((e) => e.under)) {
    const home = e.fan ? e.to : e.from;
    const taken = strips.get(slot(home)) ?? strips.set(slot(home), new Set()).get(slot(home))!;
    const pick = (
      [
        ["bottom", NH - 6],
        ["top", 6],
        ["bottom", NH - 13],
        ["top", 13],
      ] as const
    ).find(([, off]) => !taken.has(off) && clearOfText(e.over, at(home).y + off));
    if (pick) {
      taken.add(pick[1]);
      e.strip = pick[0];
      e.stripRow = slot(home);
      setEnd(e, at(home).y + pick[1]);
      moved.add(e);
      continue;
    }
    const busy: number[] = [];
    const labels: number[] = [];
    // Lines with a label above them: a label's height apart either way.
    const spaced: number[] = [];
    for (const d of drawn) {
      if (d === e) continue;
      // An exit of the box in front carries its label just above its line.
      if (e.over.includes(d.from)) {
        busy.push(outY.get(d.key)!);
        if (d.label) labels.push(outY.get(d.key)!);
      }
      if (e.over.includes(d.to)) busy.push(port.get(d.key)!);
      // The box's other exits carry labels too.
      if (!e.fan && d.from === e.from && outY.get(d.key) !== outY.get(e.key))
        spaced.push(outY.get(d.key)!);
      // So does each branch of its fan, at the height it reaches its box.
      if (!e.fan && d.fan && d.from === e.from) spaced.push(port.get(d.key)!);
      // Another crossing link, with its label above its line.
      if (d.under && moved.has(d)) spaced.push(d.fan ? port.get(d.key)! : outY.get(d.key)!);
    }
    const hb = at(home);
    const y0 = e.fan ? port.get(e.key)! : outY.get(e.key)!;
    const free = (y: number) =>
      y >= hb.y + 8 &&
      y <= hb.y + NH - 8 &&
      busy.every((b) => Math.abs(b - y) >= 7) &&
      spaced.every((b) => Math.abs(b - y) >= 18) &&
      labels.every((b) => y > b || b - y >= 20) &&
      clearOfText(e.over, y);
    const near = Array.from(
      { length: Math.ceil(NH / 9) * 2 + 1 },
      (_, i) => (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 9,
    );
    const d = near.find((d) => free(y0 + d));
    if (d !== undefined) setEnd(e, y0 + d);
    moved.add(e);
  }

  const lane = new Map<string, number>();
  const lanes = new Map<number, number>();
  const slane = new Map<string, number>();
  const slanes = new Map<number, number>();
  const jogLane = new Map<string, number>();
  const jogLanes = new Map<number, number>();
  let below = 0;
  for (const e of E) {
    const a = at(e.from);
    const b = at(e.to);
    const ca = col(e.from);
    const cb = col(e.to);
    if (e.note) {
      if (slot(e.from) === rows - 1) below = Math.max(below, 8 + notes.get(e.from)!.lines * 12);
      continue;
    }
    if (e.kind === "same") {
      if (Math.abs(slot(e.from) - slot(e.to)) === 1) {
        const x = a.x + NW / 2;
        e.pts =
          a.y > b.y
            ? [
                [x, a.y],
                [x, b.y + NH],
              ]
            : [
                [x, a.y + NH],
                [x, b.y],
              ];
        e.lab = {
          x: x + 7,
          y: (e.pts[0]![1] + e.pts[1]![1]) / 2 + 3,
          anchor: "start",
          w: Math.max(60, NW / 2 - 12),
          mode: "mid",
        };
      } else {
        // Not neighbours: jog round the right side instead of running through what is between.
        // Each box jogged into has its own lane, so jogs into different boxes never share a run.
        const down = b.y > a.y;
        const ay = a.y + (down ? NH - 12 : 12);
        const by = b.y + (down ? 12 : NH - 12);
        if (!jogLane.has(e.to)) {
          const k = (jogLanes.get(ca) ?? 0) + 1;
          jogLanes.set(ca, k);
          jogLane.set(e.to, a.x + NW + 8 + (k - 1) * 10);
        }
        const jx = jogLane.get(e.to)!;
        e.pts = [
          [a.x + NW, ay],
          [jx, ay],
          [jx, by],
          [a.x + NW, by],
        ];
        // Its label sits in the row gap beside the box it reaches, clear of that box's own exits.
        e.lab = {
          x: jx + 6,
          y: down ? b.y - 8 : b.y + NH + 13,
          anchor: "start",
          w: Math.max(60, gap - 28),
          mode: down ? "up" : "down",
        };
        e.jog = { to: e.to, down };
      }
    } else {
      const sx = a.x + NW;
      const sy = outY.get(e.key)!;
      const tx = b.x;
      const ty = port.get(e.key)!;
      if (sy === ty) {
        e.pts = [
          [sx, sy],
          [tx, ty],
        ];
        e.lab = {
          x: sx + 10,
          y: sy - 6,
          anchor: "start",
          w: Math.max(60, Math.min(e.under ? gap - 28 : tx - sx - 12, 220)),
          mode: "up",
        };
      } else if (e.fan) {
        if (!slane.has(e.from)) {
          const k = (slanes.get(ca) ?? 0) + 1;
          slanes.set(ca, k);
          slane.set(e.from, sx + 16 + (k - 1) * 12);
        }
        const lx = slane.get(e.from)!;
        e.pts = [
          [sx, sy],
          [lx, sy],
          [lx, ty],
          [tx, ty],
        ];
        e.lab = {
          x: lx + 8,
          y: ty - 6,
          anchor: "start",
          w: Math.max(60, Math.min(tx - lx - 16, 220)),
          mode: "up",
        };
      } else {
        if (!lane.has(e.to)) {
          const k = (lanes.get(cb) ?? 0) + 1;
          lanes.set(cb, k);
          lane.set(e.to, tx - 16 - (k - 1) * 12);
        }
        const cx = lane.get(e.to)!;
        e.pts = [
          [sx, sy],
          [cx, sy],
          [cx, ty],
          [tx, ty],
        ];
        const run = cx - sx;
        // The label sits in the first gap: further along there may be a box in front of it.
        e.lab =
          cb === ca + 1 || e.under
            ? {
                x: sx + 10,
                y: sy - 6,
                anchor: "start",
                w: Math.max(60, e.under ? gap - 28 : run - 12),
                mode: "up",
              }
            : {
                x: (sx + cx) / 2,
                y: sy - 6,
                anchor: "middle",
                w: Math.min(run - 24, 220),
                mode: "up",
              };
      }
      if (e.under)
        for (let i = 1; i < e.pts.length; i++) {
          const [x1, y1] = e.pts[i - 1]!;
          const [x2, y2] = e.pts[i]!;
          if (y1 !== y2) continue;
          for (const id of e.over) {
            const o = at(id);
            if (
              y1 > o.y &&
              y1 < o.y + NH &&
              Math.min(x1, x2) <= o.x &&
              Math.max(x1, x2) >= o.x + NW
            )
              e.cross.push({ box: id, x1: o.x, x2: o.x + NW, y: y1 });
          }
        }
    }
  }

  // The labels, once every line is placed. A label is said once per exit; every branch of a fan,
  // every crossing link and every jog carries its own.
  const exitsOf = new Map<string, Edge[]>();
  for (const e of E) {
    if (!e.pts) continue;
    const k = e.fan || e.under || e.jog ? e.key : `${e.from}|${e.label}|${e.kind}`;
    (exitsOf.get(k) ?? exitsOf.set(k, []).get(k)!).push(e);
  }
  const runs = E.flatMap((e) =>
    (e.pts ?? []).slice(1).flatMap(([x, y], i) => {
      const [px, py] = e.pts![i]!;
      return px === x ? [{ key: e.key, x, y1: Math.min(y, py), y2: Math.max(y, py) }] : [];
    }),
  );
  const labelRect = (
    l: { x: number; anchor: "start" | "middle" },
    y0: number,
    lines: string[],
  ): Rect => {
    const w = Math.max(...lines.map((t) => measure(t, "label")));
    return {
      x: l.anchor === "middle" ? l.x - w / 2 : l.x,
      y: y0 - 8,
      w,
      h: (lines.length - 1) * 12 + 10,
    };
  };
  // Labels already stacked in a row's strip margin, or in the gap beside a box jogged into.
  const stacked = new Map<string, number>();
  for (const es of exitsOf.values()) {
    const e = es[0]!;
    if (e.tight) continue;
    const lab = { ...e.lab! };
    // A crossing link's label sits over or under its own box, past the strip lines between; a
    // jog's in the gap beside the box it reaches. Several there stack away from the box.
    const stack = e.strip ? `${e.stripRow}|${e.strip}` : e.jog ? `jog|${e.jog.to}` : null;
    const before = stack ? (stacked.get(stack) ?? 0) : 0;
    if (e.strip === "bottom") {
      lab.y = Y0 + e.stripRow! * ROWP + NH + 7 + before * 12;
      lab.mode = "down";
    } else if (e.strip === "top") lab.y = Y0 + e.stripRow! * ROWP - before * 12;
    else if (e.jog) lab.y += (e.jog.down ? -1 : 1) * before * 12;
    const own = new Set(es.map((x) => x.key));
    const place = () => {
      const lines = wrap(e.label, lab.w);
      const m = lines.length - 1;
      const y =
        lab.mode === "up" ? lab.y - m * 12 : lab.mode === "mid" ? lab.y - (m * 12) / 2 : lab.y;
      return { lines, y, rect: labelRect(lab, y, lines) };
    };
    let p = place();
    // Clear of other links' upright runs: end before one well along, or start just past one at
    // its start.
    for (let tries = 0; tries < 4; tries++) {
      const r = p.rect;
      const hit = runs
        .filter(
          (v) =>
            !own.has(v.key) &&
            v.x > r.x - 2 &&
            v.x < r.x + r.w + 2 &&
            v.y2 > r.y &&
            v.y1 < r.y + r.h,
        )
        .sort((a, b) => a.x - b.x)[0];
      if (!hit || lab.anchor !== "start") break;
      if (hit.x - lab.x >= 44) lab.w = hit.x - 5 - lab.x;
      else {
        const shift = hit.x + 6 - lab.x;
        lab.x += shift;
        lab.w = Math.max(40, lab.w - shift);
      }
      p = place();
    }
    if (stack) stacked.set(stack, before + p.lines.length);
    e.shown = { x: lab.x, y: p.y, anchor: lab.anchor, lines: p.lines, links: es.map((x) => x.key) };
  }

  // The map is as big as what it draws: a jog or a label past the last column, a label under the
  // last row, widen or deepen it.
  let W2 = W;
  let H2 = Y0 + (rows - 1) * ROWP + NH + below + drop;
  const reach = (r: Rect) => {
    W2 = Math.max(W2, Math.ceil(r.x + r.w + 2));
    H2 = Math.max(H2, Math.ceil(r.y + r.h + 2));
  };
  for (const e of E) {
    for (const [x, y] of e.pts ?? []) reach({ x, y, w: 0, h: 0 });
    if (e.shown) reach(labelRect(e.shown, e.shown.y, e.shown.lines));
  }

  const boxes: MapBox[] = ids.map((id) => ({
    id,
    ...at(id),
    title: titles.get(id)!,
    summary: summaries.get(id)!,
    text: textRect(id),
  }));
  const out: MapLink[] = E.map((e) => {
    const l: MapLink = {
      from: e.from,
      to: e.to,
      label: e.label,
      key: e.key,
      kind: e.kind,
      crossings: e.cross,
    };
    if (e.pts) l.points = e.pts;
    if (e.shown) l.caption = e.shown;
    if (e.note) {
      const a = at(e.from);
      l.note = { x: a.x + 2, y: a.y + NH + 4 + e.note.at * 12, lines: e.note.lines };
    }
    return l;
  });
  for (const l of out)
    if (l.note)
      reach({
        x: l.note.x,
        y: l.note.y,
        w: Math.max(...l.note.lines.map((t) => measure(t, "label"))),
        h: l.note.lines.length * 12,
      });
  return { cards, width: W2, height: H2, boxW: NW, boxH: NH, heads, boxes, links: out };
}

// A path through the points with its corners rounded.
export function roundedPath(pts: Point[], r = 6) {
  let d = `M${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    if (i < pts.length - 1) {
      const [px, py] = pts[i - 1]!;
      const [nx, ny] = pts[i + 1]!;
      const rr = Math.min(
        r,
        (Math.abs(x - px) + Math.abs(y - py)) / 2,
        (Math.abs(nx - x) + Math.abs(ny - y)) / 2,
      );
      const ux = Math.sign(x - px);
      const uy = Math.sign(y - py);
      const vx = Math.sign(nx - x);
      const vy = Math.sign(ny - y);
      d += ` L${x - ux * rr} ${y - uy * rr} Q${x} ${y} ${x + vx * rr} ${y + vy * rr}`;
    } else d += ` L${x} ${y}`;
  }
  return d;
}

// The open arrowhead at the path's end.
export function arrowHead(pts: Point[]) {
  const [x, y] = pts[pts.length - 1]!;
  const [px, py] = pts[pts.length - 2]!;
  const ux = Math.sign(x - px);
  const uy = Math.sign(y - py);
  const bx = x - ux * 5;
  const by = y - uy * 5;
  return `M${bx - uy * 3} ${by + ux * 3} L${x} ${y} L${bx + uy * 3} ${by - ux * 3}`;
}
