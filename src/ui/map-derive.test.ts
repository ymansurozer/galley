import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateMeasure, mapProblems } from "./map-check";
import { MAP_CORPUS } from "./map-corpus";
import { layoutMap, linkKey, MAP_WIDTH, type MapStage } from "./map-derive";
import type { GuideLink } from "../types";

const measure = estimateMeasure();

// A stage per entry: [label, ...group ids]; each group is titled after its id, with a summary.
const stages = (...s: Array<[string, ...string[]]>): MapStage[] =>
  s.map(([label, ...ids]) => ({
    id: label.toLowerCase(),
    label,
    groups: ids.map((id) => ({ id, title: `Group ${id}`, summary: `What ${id} does.` })),
  }));
const links = (...l: Array<[string, string, string]>): GuideLink[] =>
  l.map(([from, to, label]) => ({ from, to, label }));
const lay = (s: MapStage[], l: GuideLink[] = []) => {
  const layout = layoutMap(s, l, measure);
  assert.ok(layout, "a map");
  return layout;
};
const box = (layout: NonNullable<ReturnType<typeof layoutMap>>, id: string) =>
  layout.boxes.find((b) => b.id === id)!;
const link = (layout: NonNullable<ReturnType<typeof layoutMap>>, key: string) =>
  layout.links.find((l) => l.key === key)!;

test("the map's invariants hold for every shape in the corpus", () => {
  assert.ok(MAP_CORPUS.length >= 20, "at least twenty shapes");
  const failures = MAP_CORPUS.flatMap((shape) => {
    const layout = layoutMap(shape.stages, shape.links, measure, shape.width ?? MAP_WIDTH);
    if (!layout) return [];
    const problems = mapProblems(layout, shape.links, measure);
    const known = shape.known?.problems ?? [];
    return [
      ...problems.filter((p) => !known.includes(p)).map((p) => `${shape.name}: ${p}`),
      ...known.filter((p) => !problems.includes(p)).map((p) => `${shape.name}: no longer ${p}`),
    ];
  });
  assert.deepEqual(failures, []);
});

test("the corpus has a shape with no map and shapes for each rule", () => {
  const drawn = MAP_CORPUS.map((s) => ({ s, l: layoutMap(s.stages, s.links, measure, s.width) }));
  assert.ok(
    drawn.some(({ l }) => l === null),
    "a shape too small for a map",
  );
  assert.ok(
    drawn.some(({ l }) => l && !l.cards),
    "titles only",
  );
  assert.ok(
    drawn.some(({ l }) => l?.cards),
    "cards",
  );
  assert.ok(
    drawn.some(({ l }) => l?.links.some((x) => x.note)),
    "a link back",
  );
  assert.ok(
    drawn.some(({ l }) => l?.links.some((x) => x.crossings.length)),
    "a crossing link",
  );
  assert.ok(
    drawn.some(({ l }) => l && l.width > MAP_WIDTH),
    "wider than the page",
  );
});

test("three stages give three columns in the guide's order, headed by their labels", () => {
  const layout = lay(
    stages(["Data", "a"], ["Logic", "b"], ["Screens", "c"]),
    links(["a", "b", "rows"], ["b", "c", "views"], ["a", "c", "ids"]),
  );
  assert.deepEqual(
    layout.heads.map((h) => h.label),
    ["Data", "Logic", "Screens"],
  );
  const xs = ["a", "b", "c"].map((id) => box(layout, id).x);
  assert.deepEqual(
    xs,
    [...xs].sort((p, q) => p - q),
  );
  assert.equal(new Set(xs).size, 3);
  assert.deepEqual(
    layout.heads.map((h) => h.x),
    xs,
  );
  assert.equal(layout.cards, true, "three columns of one box each have room for summaries");
});

test("five stages give titles only, as does a stage of six groups", () => {
  const five = lay(
    stages(["A", "a"], ["B", "b"], ["C", "c"], ["D", "d"], ["E", "e"]),
    links(["a", "b", "x"], ["b", "c", "x"], ["c", "d", "x"], ["d", "e", "x"]),
  );
  assert.equal(five.cards, false);
  assert.ok(five.boxes.every((b) => b.summary.length === 0));
  const tall = lay(
    stages(["A", "a"], ["B", "b1", "b2", "b3", "b4", "b5", "b6"]),
    links(["a", "b1", "x"]),
  );
  assert.equal(tall.cards, false);
});

test("a group feeding three others leaves by one exit and fans out with a label on each branch", () => {
  const layout = lay(
    stages(["Core", "hub"], ["Users", "x", "y", "z"]),
    links(["hub", "x", "colours"], ["hub", "y", "sizes"], ["hub", "z", "radii"]),
  );
  const branches = ["x", "y", "z"].map((t) => link(layout, linkKey("hub", t)));
  const starts = branches.map((l) => JSON.stringify(l.points![0]));
  assert.equal(new Set(starts).size, 1, "one exit");
  assert.deepEqual(
    branches.map((l) => l.caption?.lines.join(" ")),
    ["colours", "sizes", "radii"],
  );
  for (const [i, l] of branches.entries()) {
    assert.deepEqual(l.caption!.links, [l.key], "each label speaks for its own branch");
    assert.equal(l.points!.at(-1)![1], box(layout, "xyz"[i]!).y + layout.boxH / 2, "into its box");
  }
});

test("two links leaving a box with one label share one exit and one label", () => {
  const layout = lay(
    stages(["A", "a"], ["B", "b", "c"]),
    links(["a", "b", "rows"], ["a", "c", "rows"]),
  );
  assert.deepEqual(link(layout, linkKey("a", "b")).caption?.links, [
    linkKey("a", "b"),
    linkKey("a", "c"),
  ]);
  assert.equal(link(layout, linkKey("a", "c")).caption, undefined);
});

test("a link back to an earlier stage is a note under its source, with no path", () => {
  const layout = lay(
    stages(["Plan", "p"], ["Build", "b"], ["Ship", "s"]),
    links(["p", "b", "spec"], ["b", "s", "build"], ["s", "p", "feedback"]),
  );
  const back = link(layout, linkKey("s", "p"));
  assert.equal(back.kind, "back");
  assert.equal(back.points, undefined);
  assert.deepEqual(back.note?.lines, ["↩ Group p · feedback"]);
  const s = box(layout, "s");
  assert.equal(back.note!.x, s.x + 2);
  assert.ok(back.note!.y >= s.y + layout.boxH, "under its source");
});

test("a link skipping a stage crosses the box in its way along a strip, and says so", () => {
  const layout = lay(
    stages(["A", "a"], ["B", "b"], ["C", "c"]),
    links(["a", "b", "rows"], ["b", "c", "views"], ["a", "c", "ids"]),
  );
  const b = box(layout, "b");
  const { crossings } = link(layout, linkKey("a", "c"));
  assert.equal(crossings.length, 1);
  const [c] = crossings;
  assert.equal(c!.box, "b");
  assert.deepEqual([c!.x1, c!.x2], [b.x, b.x + layout.boxW]);
  const fromEdge = Math.min(c!.y - b.y, b.y + layout.boxH - c!.y);
  assert.ok(fromEdge > 0 && fromEdge <= 13, `within 13 px of b's top or bottom (${fromEdge})`);
  assert.deepEqual(link(layout, linkKey("a", "b")).crossings, []);
});

test("links inside a stage run straight between neighbours and jog round the side otherwise", () => {
  const layout = lay(
    stages(["A", "a"], ["B", "b1", "b2", "b3"]),
    links(["a", "b1", "x"], ["b1", "b2", "next"], ["b1", "b3", "skip"]),
  );
  const next = link(layout, linkKey("b1", "b2"));
  assert.equal(next.kind, "same");
  assert.equal(next.points!.length, 2, "a straight run");
  assert.equal(next.points![0]![0], next.points![1]![0], "upright");
  const skip = link(layout, linkKey("b1", "b3"));
  assert.equal(skip.points!.length, 4);
  const right = box(layout, "b1").x + layout.boxW;
  assert.ok(
    skip.points!.slice(1, 3).every(([x]) => x > right),
    "round the right side",
  );
  assert.ok(layout.width >= Math.max(...skip.points!.map(([x]) => x)), "inside the map");
});

test("fewer than three groups give no map; no links give columns of boxes without lines", () => {
  assert.equal(layoutMap(stages(["A", "a"], ["B", "b"]), links(["a", "b", "x"]), measure), null);
  const layout = lay(stages(["A", "a", "b"], ["B", "c", "d", "e"]));
  assert.deepEqual(
    layout.boxes.map((b) => b.id),
    ["a", "b", "c", "d", "e"],
  );
  assert.equal(layout.links.length, 0);
  assert.equal(layout.heads.length, 2);
});

test("a stage nothing links to sits apart in the last column, its groups in order under its heading", () => {
  const layout = lay(stages(["A", "a"], ["B", "b"], ["Docs", "d1", "d2"]), links(["a", "b", "x"]));
  assert.deepEqual(
    layout.heads.map((h) => h.label),
    ["A", "B", "Docs"],
  );
  const [d1, d2, b] = [box(layout, "d1"), box(layout, "d2"), box(layout, "b")];
  assert.equal(d1.x, b.x, "the last column");
  assert.ok(d1.y > b.y && d2.y > d1.y, "below, in the guide's order");
  const head = layout.heads[2]!;
  assert.ok(head.y + 22 <= d1.y && head.y > b.y + layout.boxH, "its heading between");
});

test("links naming unknown groups or joining a group to itself are left out", () => {
  const layout = lay(
    stages(["A", "a"], ["B", "b", "c"]),
    links(["a", "b", "x"], ["a", "ghost", "y"], ["c", "c", "z"]),
  );
  assert.deepEqual(
    layout.links.map((l) => l.key),
    [linkKey("a", "b")],
  );
});
