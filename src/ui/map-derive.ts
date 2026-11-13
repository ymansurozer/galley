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
  lines: string[];
  links: string[];
};
// A note under its source box: its first line's top at y.
// A note's lines after the first hang under its text, `indent` in from the "↩" that opens it.
export type MapNote = { x: number; y: number; lines: string[]; indent: number };
// A crossing link's stretch inside a box it passes.
export type MapCrossing = { box: string; x1: number; x2: number; y: number };
export type MapLinkKind = "forward" | "same" | "back";
// A link's key: its two ends, unambiguous whatever characters a group id holds.
export const linkKey = (from: string, to: string) =>
  `${JSON.stringify(from)}>${JSON.stringify(to)}`;
export type MapLink = {
  from: string;
  to: string;
  label: string;
  // linkKey(from, to), unique: the guide refuses a repeated pair.
  key: string;
  kind: MapLinkKind;
  // A drawn link: its corners, start to end (the end has the arrow). A link back has none.
  points?: Point[];
  // A branch of a fan: it shares its exit and first run with the fan's other branches.
  fan?: true;
  // The label this link's line carries, when it is the one that says it.
  caption?: MapLabel;
  // A link that crosses two boxes or more says its label again before the box it reaches.
  echo?: MapLabel;
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
// How far a way into a box stays from its top and bottom: clear of the rounded corners.
const PORT = 12;
// Runs of different links this far apart read as two lanes at a glance; closer only where the gap
// has no room.
export const LANE = 10;
// The gap between two notes under one box.
const NOTE_GAP = 5;

// Words onto lines of at most `w` px; a word wider than the line keeps a line of its own.
export function wrapText(
  measure: Measure,
  text: string,
  w: number,
  font: MapFont,
  rest = w,
): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, font) > (out.length ? rest : w)) {
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
  // The strip of its row a crossing link runs along, and the height it runs at.
  strip?: "top" | "bottom";
  stripY?: number;
  // A crossing link that leaves at its exit height and drops to its run before the first box.
  drop?: boolean;
  note?: { at: number; lines: string[] };
  pts?: Point[];
  caption?: MapLabel;
  echo?: MapLabel;
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
  // How far a note's later lines hang in: past the "↩ " that opens its first.
  const hang = measure("↩ ", "label");
  const titleOf = (id: string) => group.get(id)!.title;

  const E: Edge[] = links
    .filter((l) => group.has(l.from) && group.has(l.to) && l.from !== l.to)
    .map((l) => ({
      from: l.from,
      to: l.to,
      label: l.label,
      key: linkKey(l.from, l.to),
      kind: "forward",
      fan: false,
      over: [],
      under: false,
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
      const lines = wrapText(measure, `↩ ${titleOf(e.to)} · ${e.label}`, nw, "label", nw - hang);
      e.note = { at, lines };
      at += lines.length;
    }
    nt.lines = at;
  }
  // Notes under one box stand a little apart, so each reads as its own.
  const noteHeight = (nt: { edges: Edge[]; lines: number }) =>
    nt.lines * 12 + (nt.edges.length - 1) * NOTE_GAP;
  const notesH = Math.max(0, ...[...notes.values()].map(noteHeight));

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
  // A box is tall enough for every exit with room for its label, and for every way in to land
  // clear of its corners.
  const PM0 = text < 60 ? 10 : 14;
  const ins = [...COL.keys()].map((id) => fwd.filter((e) => e.to === id).length);
  const NH = Math.max(text, need + 2 * PM0, (Math.max(1, ...ins) - 1) * 12 + 2 * PORT);
  const PS = NH < 60 ? 12 : 20;
  // A crossing link's label sits above or below its box, so the rows stand further apart.
  const marginGap = fwd.some((e) => e.under) ? 60 : 0;
  const ROWP = NH + Math.max(cards ? 34 : 36, 10 + notesH + 8, marginGap);

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
  for (const [id, { gs, span }] of exits)
    for (const g of gs)
      for (const e of g.es) outY.set(e.key, Math.round(at(id).y + NH / 2 - span / 2 + g.y));
  // Where each drawn link enters its target, clear of the box's rounded corners. A box with one way
  // in takes it at its middle; several are spread as near their sources' heights as the box allows.
  const port = new Map<string, number>();
  for (const id of COL.keys()) {
    const b = at(id);
    const inc = drawn.filter((e) => e.to === id);
    // A fan's branch into its only way in arrives at the middle, or level with the fan's exit
    // when the box stands in the source's row, so it runs straight across.
    if (inc.length === 1 && inc[0]!.fan) {
      const e = inc[0]!;
      port.set(
        e.key,
        slot(e.from) === slot(id)
          ? clamp(outY.get(e.key)!, b.y + PORT, b.y + NH - PORT)
          : b.y + NH / 2,
      );
      continue;
    }
    const step = inc.length > 1 ? Math.min(PS, (NH - 2 * PORT) / (inc.length - 1)) : 0;
    const want = inc
      .map((e) => ({ e, y: clamp(outY.get(e.key)! - b.y, PORT, NH - PORT) }))
      .sort((a, c) => a.y - c.y);
    // Heights the box to its left leaves at for elsewhere: a way in there would run on their track.
    const left = [...COL.keys()].find((o) => col(o) === col(id) - 1 && slot(o) === slot(id));
    const busy = drawn
      .filter((d) => d.from === left && d.to !== id)
      .map((d) => outY.get(d.key)! - b.y);
    let last = -Infinity;
    const placedIn = want.every((w) => {
      const y = Array.from(
        { length: NH },
        (_, i) => w.y + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 2,
      ).find(
        (y) =>
          y >= PORT &&
          y <= NH - PORT &&
          y >= last + step &&
          busy.every((h) => Math.abs(h - y) >= 7),
      );
      if (y === undefined) return false;
      w.y = last = y;
      return true;
    });
    if (!placedIn) {
      for (const w of want) w.y = clamp(outY.get(w.e.key)! - b.y, PORT, NH - PORT);
      for (let i = 1; i < want.length; i++)
        want[i]!.y = Math.max(want[i]!.y, want[i - 1]!.y + step);
      const over = want.length ? want[want.length - 1]!.y - (NH - PORT) : 0;
      if (over > 0) for (const w of want) w.y -= over;
      if (want.length && want[0]!.y < PORT) want.forEach((w, i) => (w.y = PORT + i * step));
    }
    for (const w of want) port.set(w.e.key, Math.round(b.y + w.y));
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
  const moved: Edge[] = [];
  for (const e of drawn.filter((e) => e.under)) {
    const home = e.fan ? e.to : e.from;
    const hb = at(home);
    const taken = strips.get(slot(home)) ?? strips.set(slot(home), new Set()).get(slot(home))!;
    const chosen = (
      [
        ["bottom", NH - 6],
        ["top", 6],
        ["bottom", NH - 13],
        ["top", 13],
      ] as const
    ).find(([, off]) => !taken.has(off) && clearOfText(e.over, hb.y + off));
    if (chosen) {
      taken.add(chosen[1]);
      e.strip = chosen[0];
      e.stripY = hb.y + chosen[1];
      e.drop = chosen[1] === 13 || chosen[1] === NH - 13;
    } else {
      const busy: number[] = [];
      const labels: number[] = [];
      // Lines with a label above them: a label's height apart either way.
      const spaced: number[] = [];
      for (const d of drawn) {
        if (d === e) continue;
        // An exit of the box in front carries its label just above its line.
        if (e.over.includes(d.from)) {
          busy.push(outY.get(d.key)!);
          labels.push(outY.get(d.key)!);
        }
        if (e.over.includes(d.to)) busy.push(port.get(d.key)!);
        // The box's other exits carry labels too, and so does each branch of its fan.
        if (!e.fan && d.from === e.from && outY.get(d.key) !== outY.get(e.key))
          spaced.push(outY.get(d.key)!);
        if (!e.fan && d.fan && d.from === e.from) spaced.push(port.get(d.key)!);
        // Another crossing link, with its label above its line.
        if (moved.includes(d)) spaced.push(d.stripY!);
      }
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
      e.stripY = y0 + (d ?? 0);
      e.drop = true;
    }
    // A link on an outer strip leaves its box along it, its label over or under the box. One on
    // an inner strip or a free height would leave beside another strip line, where no label could
    // say which line is its own: it leaves at its own exit height and drops to its run just before
    // the first box in its way.
    if (!e.fan && !e.drop) outY.set(e.key, e.stripY);
    moved.push(e);
  }

  // ── The lines. Each drawn link's path is placed in turn, and where it bends its lane is searched
  // so that no two links run on one track (links leaving by one exit share their first run, as a
  // fan's branches share their trunk). Fixed runs go first: straight links and links between
  // neighbours in a stage. Then fans, then links gathering into a box (the one from the furthest
  // source on the lane nearest the box, so they don't cross), then jogs round a stage's side. ──
  const placed: Array<{ e: Edge; p: Point; q: Point }> = [];
  // A run on another link's track is a clash. One closer than LANE to it is a small cost, so a
  // lane is taken that close only when the gap has no room further off.
  const clashes = (e: Edge, pts: Point[]) => {
    let n = 0;
    for (const [p, q] of segments(pts))
      for (const s of placed)
        if (s.e === e || shareExit(s.e, e)) continue;
        else if (oneTrack(p, q, s.p, s.q)) n++;
        else if (oneTrack(p, q, s.p, s.q, LANE)) n += 0.01;
    return n;
  };
  const lay = (e: Edge, pts: Point[]) => {
    e.pts = corners(pts);
    for (const [p, q] of segments(pts)) placed.push({ e, p, q });
  };
  // The option with the fewest clashes; the earliest of those.
  const pick = <T>(options: T[], score: (o: T) => number): T => {
    let best: { o: T; s: number } | undefined;
    for (const o of options) {
      const s = score(o);
      if (!best || s < best.s) best = { o, s };
      if (s === 0) break;
    }
    if (!best) throw new Error("map layout: no option to pick from");
    return best.o;
  };
  // Lanes in the gap before column c, from the box side outwards (the gap's right end is X(c)).
  const lanesBefore = (c: number, from: "left" | "right") => {
    const lo = X(c - 1) + NW + 16;
    const hi = X(c) - 16;
    const xs: number[] = [];
    for (
      let x = from === "right" ? hi : lo;
      x >= lo && x <= hi;
      x += from === "right" ? -LANE : LANE
    )
      xs.push(x);
    return xs.length ? xs : [Math.round((lo + hi) / 2)];
  };
  const sx = (e: Edge) => at(e.from).x + NW;
  const tx = (e: Edge) => at(e.to).x;
  // The run along a strip past the boxes in the way, then into the target through the last gap.
  const intoTarget = (e: Edge, y: number, cx: number): Point[] =>
    y === port.get(e.key)!
      ? [[tx(e), y]]
      : [
          [cx, y],
          [cx, port.get(e.key)!],
          [tx(e), port.get(e.key)!],
        ];

  for (const e of E) {
    if (e.kind === "same" && Math.abs(slot(e.from) - slot(e.to)) === 1) {
      const a = at(e.from);
      const b = at(e.to);
      const x = a.x + NW / 2;
      lay(
        e,
        a.y > b.y
          ? [
              [x, a.y],
              [x, b.y + NH],
            ]
          : [
              [x, a.y + NH],
              [x, b.y],
            ],
      );
    } else if (e.kind === "forward" && !e.fan && !e.drop && outY.get(e.key) === port.get(e.key))
      lay(e, [
        [sx(e), outY.get(e.key)!],
        [tx(e), port.get(e.key)!],
      ]);
  }
  for (const id of COL.keys()) {
    const fan = drawn.filter((e) => e.from === id && e.fan);
    if (!fan.length) continue;
    const sy = outY.get(fan[0]!.key)!;
    const trunk = lanesBefore(col(id) + 1, "left");
    const branch = (e: Edge, lx: number): Point[] => {
      const ty = port.get(e.key)!;
      if (e.under) {
        const cx = pick(lanesBefore(col(e.to), "right"), (cx) =>
          clashes(e, [[lx, e.stripY!], ...intoTarget(e, e.stripY!, cx)]),
        );
        return [[sx(e), sy], [lx, sy], [lx, e.stripY!], ...intoTarget(e, e.stripY!, cx)];
      }
      return ty === sy
        ? [
            [sx(e), sy],
            [tx(e), ty],
          ]
        : [
            [sx(e), sy],
            [lx, sy],
            [lx, ty],
            [tx(e), ty],
          ];
    };
    const lx = pick(trunk, (lx) => fan.reduce((n, e) => n + clashes(e, branch(e, lx)), 0));
    for (const e of fan) lay(e, branch(e, lx));
  }
  const gathers = drawn
    .filter((e) => !e.fan && !e.pts)
    .sort((a, b) => {
      if (a.to !== b.to) return col(a.to) - col(b.to) || slot(a.to) - slot(b.to);
      const da = outY.get(a.key)! - port.get(a.key)!;
      const db = outY.get(b.key)! - port.get(b.key)!;
      // From above, the highest source first; from below, the lowest.
      return Math.sign(da) - Math.sign(db) || (da < 0 ? da - db : db - da);
    });
  for (const e of gathers) {
    const sy = outY.get(e.key)!;
    const head = (dx: number): Point[] =>
      e.drop
        ? [
            [sx(e), sy],
            [dx, sy],
            [dx, e.stripY!],
          ]
        : [[sx(e), sy]];
    const y = e.drop ? e.stripY! : sy;
    const options = (e.drop ? lanesBefore(col(e.from) + 1, "right") : [0]).flatMap((dx) =>
      lanesBefore(col(e.to), "right").map((cx) => [...head(dx), ...intoTarget(e, y, cx)]),
    );
    lay(
      e,
      pick(options, (o) => clashes(e, o)),
    );
  }
  // A jog round the right side of its stage, clear of the column, leaving and arriving on the
  // straight part of the boxes' edges.
  // The longest jog takes the lane nearest the column, so a shorter one's label beside its lane
  // never sits across a longer one's.
  const jogs = E.filter((e) => e.kind === "same" && !e.pts).sort(
    (a, b) => Math.abs(slot(b.to) - slot(b.from)) - Math.abs(slot(a.to) - slot(a.from)),
  );
  for (const e of jogs) {
    const a = at(e.from);
    const b = at(e.to);
    const right = a.x + NW;
    const down = b.y > a.y;
    const options: Point[][] = [];
    for (const jx of [20, 30, 40, 50, 60].map((d) => right + d))
      for (const offA of [16, 24, 32])
        for (const offB of [16, 24, 32]) {
          const ay = down ? a.y + NH - offA : a.y + offA;
          const by = down ? b.y + offB : b.y + NH - offB;
          options.push([
            [right, ay],
            [jx, ay],
            [jx, by],
            [right, by],
          ]);
        }
    lay(
      e,
      pick(options, (o) => clashes(e, o)),
    );
  }
  for (const e of drawn.filter((e) => e.under))
    for (const [[x1, y1], [x2, y2]] of segments(e.pts!)) {
      if (y1 !== y2) continue;
      for (const id of e.over) {
        const o = at(id);
        if (y1 > o.y && y1 < o.y + NH && Math.min(x1, x2) <= o.x && Math.max(x1, x2) >= o.x + NW)
          e.cross.push({ box: id, x1: o.x, x2: o.x + NW, y: y1 });
      }
    }

  // ── The notes, then the labels. A label is said once per exit; every branch of a fan, every
  // crossing link and every jog carries its own. Each label tries the places its kind of link
  // offers, nearest its exit first, and takes the first that is clear: of the boxes, of other
  // links' lines and arrowheads, of other text, and nearer its own line than any other. ──
  let below = 0;
  const notesOut = new Map<Edge, MapNote>();
  for (const [id, nt] of notes) {
    const a = at(id);
    nt.edges.forEach((e, i) =>
      notesOut.set(e, {
        x: a.x + 2,
        y: a.y + NH + 4 + e.note!.at * 12 + i * NOTE_GAP,
        lines: e.note!.lines,
        indent: hang,
      }),
    );
    if (slot(id) === rows - 1) below = Math.max(below, 8 + noteHeight(nt));
  }
  const textW = (lines: string[]) => Math.max(...lines.map((t) => measure(t, "label")));
  const noteW = (n: MapNote) =>
    Math.max(textW(n.lines.slice(0, 1)), n.indent + textW(n.lines.slice(1)));
  const texts: Rect[] = [
    ...heads.map((h) => ({ x: h.x, y: h.y, w: h.w, h: 22 })),
    ...[...notesOut.values()].map((n) => ({
      x: n.x,
      y: n.y,
      w: noteW(n),
      h: n.lines.length * 12,
    })),
  ];
  const boxRects = [...box.values()].map((b) => ({ x: b.x - 2, y: b.y - 2, w: NW + 4, h: NH + 4 }));
  const arrows = drawn.filter((e) => e.pts).map((e) => arrowRect(e.pts!));
  arrows.push(...E.filter((e) => e.kind === "same").map((e) => arrowRect(e.pts!)));
  const lineGap = (r: Rect, e: Edge) =>
    Math.min(...segments(e.pts!).map(([p, q]) => rectGap(r, segRect(p, q))));
  const others = (own: Edge[]) =>
    E.filter((d) => d.pts && !own.includes(d) && !own.some((o) => o.fan && shareExit(o, d)));
  // How badly a label at r misplaces: 0 when it is clear.
  const misplaced = (r: Rect, own: Edge[]) => {
    let bad = 0;
    if (r.x < 0 || r.y < 0) bad += 100;
    for (const b of boxRects) if (rectGap(r, b) === 0) bad += 100;
    const mine = Math.min(...own.map((e) => lineGap(r, e)));
    if (mine > 8) bad += 5;
    // Its own line through it hides the label as surely as another's (a repeat's elbow).
    if (mine === 0) bad += 40;
    for (const d of others(own)) {
      const g = lineGap(r, d);
      if (g < 3) bad += 40;
      else if (g <= mine + 2) bad += 20;
    }
    for (const t of texts) if (rectGap(r, t) < 6) bad += 30;
    for (const a of arrows) if (rectGap(r, a) < 4) bad += 20;
    return bad;
  };
  // A spot for a label: its first line's baseline at y ("up" grows upwards, "mid" centres on y);
  // the label starts at x, or ends there when it sits on the left of an upright run.
  type Spot = { x: number; y: number; w: number; mode: "up" | "down" | "mid"; left?: boolean };
  const uprights = (own: Edge[]) =>
    others(own).flatMap((d) =>
      segments(d.pts!)
        .filter(([p, q]) => p[0] === q[0])
        .map(([p, q]) => ({ x: p[0], y1: Math.min(p[1], q[1]), y2: Math.max(p[1], q[1]) })),
    );
  const fitLabel = (e: Edge, s: Spot, w: number) => {
    const lines = wrap(e.label, clamp(w, 40, 220));
    const m = lines.length - 1;
    const y = s.mode === "up" ? s.y - m * 12 : s.mode === "mid" ? s.y - m * 6 : s.y;
    const width = textW(lines);
    const x = s.left ? s.x - width : s.x;
    return { lines, x, y, rect: { x, y: y - 8, w: width, h: m * 12 + 10 } };
  };
  // The first clear spot, or the least bad. A label that would cross another link's upright run
  // ends before it when there is room.
  const settle = (e: Edge, own: Edge[], spots: Spot[]) => {
    let best: { label: MapLabel; rect: Rect; bad: number } | undefined;
    const runs = uprights(own);
    for (const s of spots) {
      let f = fitLabel(e, s, s.w);
      for (let t = 0; t < 3 && !s.left; t++) {
        const r = f.rect;
        const hit = runs
          .filter((v) => v.x > r.x + 30 && v.x < r.x + r.w + 3 && v.y2 > r.y && v.y1 < r.y + r.h)
          .sort((p, q) => p.x - q.x)[0];
        if (!hit) break;
        f = fitLabel(e, s, hit.x - 5 - s.x);
      }
      const bad = misplaced(f.rect, own);
      if (!best || bad < best.bad)
        best = {
          label: { x: f.x, y: f.y, lines: f.lines, links: own.map((o) => o.key) },
          rect: f.rect,
          bad,
        };
      if (bad === 0) break;
    }
    if (!best) throw new Error("map layout: no spot for a label");
    return best;
  };
  const keep = (b: { label: MapLabel; rect: Rect }) => {
    texts.push(b.rect);
    return b.label;
  };
  // Spots along a level run from x0 to x1 at height y: over it, then under it, stepping away from
  // the line (past strip lines and stacked labels) only when nothing nearer is clear. Over first
  // for every link, a bottom strip's too, so the labels of a box's exits read on one side.
  const alongRun = (x0: number, x1: number, y: number): Spot[] => {
    const spots: Spot[] = [];
    for (let k = 0; k < 4; k++)
      for (const side of ["up", "down"])
        for (let x = x0 + 10; x === x0 + 10 || x + 30 <= x1 - 4; x += 8)
          spots.push(
            side === "up"
              ? { x, y: y - 6 - k * 14, w: x1 - 4 - x, mode: "up" }
              : { x, y: y + 13 + k * 14, w: x1 - 4 - x, mode: "down" },
          );
    return spots;
  };
  // Spots beside an upright run at x, from y0 towards y1: on its right, or on both sides.
  const besideRun = (x: number, y0: number, y1: number, widths: number[], both = false): Spot[] => {
    const spots: Spot[] = [];
    const dir = Math.sign(y1 - y0) || 1;
    for (let d = 0; d <= Math.abs(y1 - y0); d += 12)
      for (const w of widths) {
        spots.push({ x: x + 7, y: y0 + dir * d + 3, w, mode: "mid" });
        if (both) spots.push({ x: x - 7, y: y0 + dir * d + 3, w, mode: "mid", left: true });
      }
    return spots;
  };
  // Spots near where a link reaches its target: along its last level run in the gap before it,
  // and beside the lane it turns down or up in.
  const nearTarget = (e: Edge): Spot[] => {
    const pts = e.pts!;
    const start = X(col(e.to) - 1) + NW;
    const spots: Spot[] = [];
    for (const [p, q] of segments(pts).reverse()) {
      if (Math.max(p[0], q[0]) <= start) break;
      if (p[1] === q[1])
        spots.push(...alongRun(Math.max(start, Math.min(p[0], q[0])), Math.max(p[0], q[0]), p[1]));
      else spots.push(...besideRun(p[0], q[1], p[1], [gap / 2 - 16], true));
    }
    return spots;
  };
  const firstGapEnd = (e: Edge) => Math.min(X(col(e.from) + 1), e.pts![1]![0]);
  const groups = new Map<string, Edge[]>();
  for (const e of E) {
    if (!e.pts) continue;
    const k = e.fan || e.under || e.kind === "same" ? e.key : `${e.from}|${e.label}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  for (const own of groups.values()) {
    const e = own[0]!;
    const pts = e.pts!;
    const [p0, p1] = pts;
    let spots: Spot[];
    if (e.kind === "same" && pts.length === 2) {
      const mid = (p0![1] + p1![1]) / 2;
      spots = besideRun(p0![0], mid, mid + 12, [NW / 2 - 12, NW / 2 - 12 + gap / 2]);
    } else if (e.kind === "same") {
      const [, [jx, ay], [, by]] = pts;
      spots = besideRun(jx!, ay! + Math.sign(by! - ay!) * 12, by!, [
        Math.max(60, gap - (jx! - p0![0]) - 12),
      ]);
    } else if (e.fan && pts.length > 2) {
      const [, , [lx, ly], [nx]] = pts;
      spots = alongRun(lx!, Math.min(nx!, X(col(e.from) + 1)), ly!);
    } else spots = alongRun(p0![0], Math.min(...own.map(firstGapEnd)), p0![1]);
    const atSource = settle(e, own, spots);
    // A crossing link whose label cannot be told apart at its source (its strip runs beside
    // another) says it near its target instead. One past two boxes or more says it there as well.
    const far = new Set(e.cross.map((c) => c.box)).size >= 2;
    const atTarget = e.under && (far || atSource.bad) ? settle(e, own, nearTarget(e)) : undefined;
    if (atTarget && atSource.bad && atTarget.bad < atSource.bad) e.caption = keep(atTarget);
    else {
      e.caption = keep(atSource);
      // Said again only where it can be told apart: a muddled echo is worse than none.
      if (atTarget && far && atTarget.bad === 0) e.echo = keep(atTarget);
    }
  }

  // The map is as big as what it draws: a jog or a label past the last column, a label under the
  // last row, widen or deepen it.
  let W2 = W;
  let H2 = Y0 + (rows - 1) * ROWP + NH + below + drop;
  for (const r of [
    ...texts,
    ...E.flatMap((e) => (e.pts ?? []).map(([x, y]) => ({ x, y, w: 0, h: 0 }))),
  ]) {
    W2 = Math.max(W2, Math.ceil(r.x + r.w + 2));
    H2 = Math.max(H2, Math.ceil(r.y + r.h + 2));
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
    if (e.fan) l.fan = true;
    if (e.caption) l.caption = e.caption;
    if (e.echo) l.echo = e.echo;
    if (notesOut.has(e)) l.note = notesOut.get(e)!;
    return l;
  });
  return { cards, width: W2, height: H2, boxW: NW, boxH: NH, heads, boxes, links: out };
}

// Two links leaving by one exit share their first run: a fan's branches, or links that leave a box
// with one label.
const shareExit = (a: Edge, b: Edge) =>
  a.from === b.from &&
  a.kind === "forward" &&
  b.kind === "forward" &&
  (a.fan && b.fan ? true : !a.fan && !b.fan && a.label === b.label);

// A path's corners alone: no repeated point, and no point midway along a straight run.
function corners(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && q[0] === p[0] && q[1] === p[1]) continue;
    const o = out[out.length - 2];
    if (o && q && ((o[0] === q[0] && q[0] === p[0]) || (o[1] === q[1] && q[1] === p[1]))) out.pop();
    out.push(p);
  }
  return out;
}

type Seg = readonly [Point, Point];
const segments = (pts: Point[]): Seg[] => pts.slice(1).map((p, i) => [pts[i]!, p] as const);
const segRect = ([x1, y1]: Point, [x2, y2]: Point): Rect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
});
const rectGap = (a: Rect, b: Rect) =>
  Math.hypot(
    Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)),
    Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h)),
  );
// Whether two runs lie on one track: parallel, closer than a line can be told apart, and side by
// side for more than a point.
function oneTrack(p: Point, q: Point, r: Point, s: Point, apart = 6) {
  const flat = p[1] === q[1] && r[1] === s[1];
  const upright = p[0] === q[0] && r[0] === s[0];
  if (!flat && !upright) return false;
  const [across, along] = flat ? [1, 0] : [0, 1];
  if (Math.abs(p[across]! - r[across]!) >= apart) return false;
  const lo = Math.max(Math.min(p[along]!, q[along]!), Math.min(r[along]!, s[along]!));
  const hi = Math.min(Math.max(p[along]!, q[along]!), Math.max(r[along]!, s[along]!));
  return hi - lo > 2;
}
// The room an arrowhead takes at a path's end.
function arrowRect(pts: Point[]): Rect {
  const [x, y] = pts[pts.length - 1]!;
  const [px, py] = pts[pts.length - 2]!;
  const ux = Math.sign(x - px);
  const uy = Math.sign(y - py);
  return segRect([x - ux * 5 - uy * 3, y - uy * 5 - ux * 3], [x + uy * 3, y + ux * 3]);
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
