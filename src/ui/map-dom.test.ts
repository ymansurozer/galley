import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { estimateMeasure } from "./map-check";
import { layoutMap, type MapStage } from "./map-derive";
import { lightMapLinks, mapHtml, mapListHtml } from "./map-dom";
import type { GuideLink } from "../types";

// Five groups in three stages: a feeds b and c, b feeds d, a skips past b to d (crossing b), and
// d links back to a (a note).
const STAGES: MapStage[] = [
  { id: "src", label: "Sources", groups: [{ id: "a", title: "Alpha <one>", summary: "Reads." }] },
  {
    id: "mid",
    label: "Middle",
    groups: [
      { id: "b", title: "Beta", summary: "Shapes." },
      { id: "c", title: "Gamma" },
    ],
  },
  { id: "out", label: "Out", groups: [{ id: "d", title: "Delta", summary: "Writes." }] },
];
const LINKS: GuideLink[] = [
  { from: "a", to: "b", label: "rows" },
  { from: "a", to: "c", label: "ids" },
  { from: "b", to: "d", label: "shaped rows" },
  { from: "a", to: "d", label: "raw & ready" },
  { from: "d", to: "a", label: "feedback" },
];

function mount(html: string) {
  const window = new Window();
  const host = window.document.createElement("div");
  host.innerHTML = html;
  return host as unknown as HTMLElement;
}

const layout = layoutMap(STAGES, LINKS, estimateMeasure())!;

test("the map's markup has a box per group, a line per drawn link and dots per box crossed", () => {
  const host = mount(mapHtml(layout));
  const boxes = [...host.querySelectorAll<HTMLElement>(".map-box")];
  assert.deepEqual(
    boxes.map((b) => b.dataset.group),
    ["a", "b", "c", "d"],
  );
  assert.equal(boxes[0]!.querySelector(".map-title")!.textContent, "Alpha <one>", "escaped");
  assert.equal(boxes[0]!.querySelector(".map-sum")!.textContent, "Reads.");
  assert.equal(boxes[2]!.querySelector(".map-sum"), null, "no summary, no line for one");
  const lines = [...host.querySelectorAll<HTMLElement>(".map-link")];
  assert.deepEqual(
    lines.map((l) => `${l.dataset.from}>${l.dataset.to}`),
    ["a>b", "a>c", "b>d", "a>d"],
  );
  for (const l of lines) assert.equal(l.querySelectorAll("path").length, 2, "a line and its arrow");
  const dots = [...host.querySelectorAll<HTMLElement>(".map-cross")];
  assert.deepEqual(
    dots.map((d) => [`${d.dataset.from}>${d.dataset.to}`, d.dataset.box]),
    [["a>d", "b"]],
  );
  const notes = [...host.querySelectorAll<HTMLElement>(".map-note")];
  assert.deepEqual(
    notes.map((n) => [n.dataset.from, n.dataset.to, n.textContent]),
    [["d", "a", "↩ Alpha <one> · feedback"]],
  );
  // A wrapped note's later lines hang under its text, past the "↩".
  assert.match(notes[0]!.getAttribute("style")!, /padding-left:([\d.]+)px;text-indent:-\1px/);
  const labels = [...host.querySelectorAll<HTMLElement>(".map-label")];
  assert.ok(
    labels.some((l) => l.textContent === "raw & ready" && l.dataset.links === '[["a","d"]]'),
  );
  assert.deepEqual(
    [...host.querySelectorAll(".map-head")].map((h) => h.textContent),
    ["Sources", "Middle", "Out"],
  );
});

test("pointing at a box lights its links and dims the rest; leaving puts them back", () => {
  const host = mount(mapHtml(layout));
  lightMapLinks(host, "c");
  const hot = (sel: string) =>
    [...host.querySelectorAll<HTMLElement>(`${sel}.map-hot`)].map(
      (e) => `${e.dataset.from}>${e.dataset.to}`,
    );
  assert.ok(host.querySelector(".map")!.classList.contains("map-focus"));
  assert.deepEqual(hot(".map-link"), ["a>c"]);
  assert.deepEqual(hot(".map-cross"), []);
  lightMapLinks(host, "d");
  assert.deepEqual(hot(".map-link"), ["b>d", "a>d"]);
  assert.deepEqual(hot(".map-cross"), ["a>d"]);
  assert.deepEqual(hot(".map-note"), ["d>a"]);
  lightMapLinks(host, null);
  assert.equal(host.querySelectorAll(".map-hot").length, 0);
  assert.ok(!host.querySelector(".map")!.classList.contains("map-focus"));
});

test("pointing at a thread on one link lights that link alone, in the drawing and the list", () => {
  const host = mount(mapHtml(layout) + mapListHtml(STAGES, LINKS));
  lightMapLinks(host, null, ["a", "d"]);
  const hot = [...host.querySelectorAll<HTMLElement>(".map-hot")].map(
    (e) =>
      `${e.className.replace(" map-hot", "")} ${e.dataset.from ?? e.dataset.group}>${e.dataset.to ?? ""}`,
  );
  assert.deepEqual(hot, ["map-link a>d", "map-label a>d", "map-cross a>d", "map-list-feed a>d"]);
  // A box's thread lights the box, in the drawing and as its list row.
  lightMapLinks(host, "b");
  assert.ok(host.querySelector('.map-box[data-group="b"]')!.classList.contains("map-hot"));
  assert.ok(host.querySelector('.map-list-row[data-group="b"]')!.classList.contains("map-hot"));
  lightMapLinks(host, null);
  assert.equal(host.querySelectorAll(".map-hot").length, 0);
});

test("the narrow list has each group under its stage, with what it feeds", () => {
  const host = mount(mapListHtml(STAGES, LINKS));
  assert.deepEqual(
    [...host.querySelectorAll(".map-list-stage")].map((s) => s.textContent),
    ["Sources", "Middle", "Out"],
  );
  const rows = [...host.querySelectorAll<HTMLElement>(".map-list-row")];
  assert.deepEqual(
    rows.map((r) => r.dataset.group),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    [...rows[0]!.querySelectorAll(".map-list-feed")].map((f) => f.textContent),
    ["→ Beta · rows", "→ Gamma · ids", "→ Delta · raw & ready"],
  );
  assert.deepEqual(
    [...rows[3]!.querySelectorAll(".map-list-feed")].map((f) => f.textContent),
    ["→ Alpha <one> · feedback"],
  );
  assert.equal(rows[2]!.querySelectorAll(".map-list-feed").length, 0);
});

test("the list joins the links leaving a group with one label into one line", () => {
  const host = mount(
    mapListHtml(STAGES, [
      { from: "a", to: "b", label: "rows" },
      { from: "a", to: "c", label: "rows" },
    ]),
  );
  const feeds = [...host.querySelectorAll<HTMLElement>(".map-list-feed")];
  assert.deepEqual(
    feeds.map((f) => [f.textContent, f.dataset.links]),
    [["→ Beta, Gamma · rows", '[["a","b"],["a","c"]]']],
  );
});

test("lighting finds a group's links whatever its id holds", () => {
  const stages: MapStage[] = [
    {
      id: "s1",
      label: "One",
      groups: [
        { id: "x", title: "X" },
        { id: "x y", title: "X Y" },
      ],
    },
    { id: "s2", label: "Two", groups: [{ id: "y>z", title: "YZ" }] },
  ];
  const links: GuideLink[] = [
    { from: "x", to: "y>z", label: "rows" },
    { from: "x y", to: "y>z", label: "rows" },
  ];
  const host = mount(mapHtml(layoutMap(stages, links, estimateMeasure())!));
  const hot = () =>
    [...host.querySelectorAll<HTMLElement>(".map-link.map-hot, .map-label.map-hot")].map(
      (e) => `${e.dataset.from} → ${e.dataset.to}`,
    );
  lightMapLinks(host, "x");
  assert.deepEqual(hot(), ["x → y>z", "x → y>z"]);
  lightMapLinks(host, "x y");
  assert.deepEqual(hot(), ["x y → y>z", "x y → y>z"]);
  lightMapLinks(host, "y");
  assert.equal(host.querySelectorAll(".map-hot").length, 0);
});
