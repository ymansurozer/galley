import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { clearFolds, foldHunks, type FoldRun } from "./fold-dom";
import { misalignedColumns, type DiffColumn } from "./skim-dom";

// @pierre's shape for a part view of a file with four hunks, in collapse mode: an unchanged-lines
// separator before each hunk and after the last, in both tracks (gutter and content) of every
// column. Hunks 0, 1 and 3 render as plain context (other parts' changes, replayed); hunk 1 carries
// a resolved thread, an annotation that is two rows — [data-line-annotation] in content, a
// [data-gutter-buffer="annotation"] spacer in the gutter. Hunk 2 is the step's own diff: in split,
// its added line faces a filler buffer in the deletions column. Each row carries a data-t label
// so the tests read as row lists; data-line-index is "unified,split" as @pierre writes it.
//
//   sep0 (8 lines) · ctx 8-10 (hunk 0) · sep1 (5) · ctx 16-18 (hunk 1, thread on 17) · sep2 (4)
//   · ctx 23, add 24, ctx 25 (hunk 2) · sep3 (3) · ctx 29-31 (hunk 3) · sep4 (6, trailing)
const HUNKS: Array<[number, number]> = [
  [8, 10],
  [16, 18],
  [23, 25],
  [29, 31],
];

const sep = (n: number, lines: number) =>
  `<div data-t="sep${n}" data-separator="line-info"><div data-separator-wrapper><div data-separator-content><span data-unmodified-lines>${lines} unmodified lines</span></div></div></div>`;
const row = (t: string, i: number, type = "context") =>
  `<div data-t="${t}" data-line-type="${type}" data-line-index="${i},${i}"></div>`;
const context = (from: number, to: number) => {
  let out = "";
  for (let i = from; i <= to; i++) out += row(`ctx${i}`, i);
  return out;
};

// One track of one column: its annotation row and filler buffer differ between gutter and
// content, and only the deletions column pads hunk 2's added line.
function track(annotation: string, filler: string, side: "deletions" | "additions" | "unified") {
  return (
    sep(0, 8) +
    context(8, 10) +
    sep(1, 5) +
    context(16, 17) +
    annotation +
    context(18, 18) +
    sep(2, 4) +
    context(23, 23) +
    (side === "deletions" ? filler : row("add24", 24, "change-addition")) +
    context(25, 25) +
    sep(3, 3) +
    context(29, 31) +
    sep(4, 6)
  );
}

function diff(layout: "split" | "unified"): { doc: Document; columns: DiffColumn[] } {
  const doc = new Window().document as unknown as Document;
  const column = (side: "deletions" | "additions" | "unified"): DiffColumn => {
    const el = doc.createElement("div");
    const gutter = track(
      `<div data-t="gAnn" data-gutter-buffer="annotation" data-buffer-size="1"></div>`,
      `<div data-t="buf" data-gutter-buffer="buffer" data-buffer-size="1"></div>`,
      side,
    );
    const content = track(
      `<div data-t="ann" data-line-annotation="1,17"></div>`,
      `<div data-t="buf" data-content-buffer data-buffer-size="1"></div>`,
      side,
    );
    el.innerHTML = `<div data-gutter>${gutter}</div><div data-content>${content}</div>`;
    doc.body.appendChild(el);
    return {
      gutter: el.querySelector<HTMLElement>("[data-gutter]"),
      content: el.querySelector<HTMLElement>("[data-content]"),
    };
  };
  const columns =
    layout === "split" ? [column("deletions"), column("additions")] : [column("unified")];
  return { doc, columns };
}

// Fold `hunks` (a row's hunk read off the split number of its line index), standing a labelled
// row in for each run. Returns the rows hidden and the runs the first track reported.
function fold(doc: Document, columns: DiffColumn[], ...hunks: number[]) {
  const runs: FoldRun[] = [];
  const hunkOf = (li: string) => {
    const n = Number(li.split(",")[1]);
    const h = HUNKS.findIndex(([lo, hi]) => n >= lo && n <= hi);
    return hunks.includes(h) ? h : undefined;
  };
  const hidden = foldHunks(columns, hunkOf, (run) => {
    runs.push(run);
    const el = doc.createElement("div");
    el.setAttribute("data-t", `fold${run.hunks.join("+")}`);
    return el;
  });
  return { hidden, runs: runs.slice(0, runs.length / (columns.length * 2)) };
}

const visible = (track: HTMLElement | null, attr = "data-t") =>
  Array.from(track!.children)
    .filter((k) => (k as HTMLElement).style.display !== "none")
    .map((k) => k.getAttribute(attr));

// Every shown gutter row faces the content row of the same line — each line number sits beside
// its own code, below a fold as above it.
function assertAligned(columns: DiffColumn[]) {
  assert.deepEqual(misalignedColumns(columns), []);
  for (const col of columns)
    assert.deepEqual(
      visible(col.gutter, "data-line-index"),
      visible(col.content, "data-line-index"),
    );
}

for (const layout of ["split", "unified"] as const) {
  test(`${layout}: folding a hunk hides its rows and the separators beside it, in both tracks of every column`, () => {
    const { doc, columns } = diff(layout);
    const { runs } = fold(doc, columns, 1);
    columns.forEach((col, i) => {
      const own = layout === "split" && i === 0 ? "buf" : "add24";
      const rows = ["sep0", "ctx8", "ctx9", "ctx10", "fold1", "ctx23", own, "ctx25", "sep3"];
      const tail = ["ctx29", "ctx30", "ctx31", "sep4"];
      assert.deepEqual(visible(col.gutter), [...rows, ...tail]);
      assert.deepEqual(visible(col.content), [...rows, ...tail]);
    });
    assert.deepEqual(runs, [{ hunks: [1], lines: 5 + 3 + 4, first: false, last: false }]);
    assertAligned(columns);
  });

  test(`${layout}: a folded hunk's thread folds away with it, both of its rows`, () => {
    const { doc, columns } = diff(layout);
    const { hidden } = fold(doc, columns, 1);
    // Per track: sep1, three lines, the annotation's row, sep2.
    assert.equal(hidden, 6 * 2 * columns.length);
    for (const col of columns) {
      assert.ok(!visible(col.gutter).includes("gAnn"));
      assert.ok(!visible(col.content).includes("ann"));
    }
  });

  test(`${layout}: neighbouring folded hunks fold into one expander counting every line it hides`, () => {
    const { doc, columns } = diff(layout);
    const { runs } = fold(doc, columns, 0, 1);
    for (const col of columns) {
      assert.deepEqual(visible(col.gutter).slice(0, 2), ["fold0+1", "ctx23"]);
      assert.deepEqual(visible(col.content).slice(0, 2), ["fold0+1", "ctx23"]);
    }
    assert.deepEqual(runs, [{ hunks: [0, 1], lines: 8 + 3 + 5 + 3 + 4, first: true, last: false }]);
    assertAligned(columns);
  });

  test(`${layout}: a fold at the end of the file takes the trailing separator`, () => {
    const { doc, columns } = diff(layout);
    const { runs } = fold(doc, columns, 3);
    for (const col of columns) {
      assert.deepEqual(visible(col.gutter).slice(-2), ["ctx25", "fold3"]);
      assert.deepEqual(visible(col.content).slice(-2), ["ctx25", "fold3"]);
    }
    assert.deepEqual(runs, [{ hunks: [3], lines: 3 + 3 + 6, first: false, last: true }]);
    assertAligned(columns);
  });

  test(`${layout}: folding again after clearing gives the same rows (the pass re-runs every render)`, () => {
    const { doc, columns } = diff(layout);
    fold(doc, columns, 0, 3);
    const once = columns.map((c) => [visible(c.gutter), visible(c.content)]);
    clearFolds(doc);
    assert.equal(doc.querySelectorAll("[data-t^=fold]").length, 0);
    assert.ok(visible(columns[0]!.content).includes("ctx8"));
    fold(doc, columns, 0, 3);
    assert.deepEqual(
      columns.map((c) => [visible(c.gutter), visible(c.content)]),
      once,
    );
    assertAligned(columns);
  });
}

test("a separator without an unmodified-lines count stays beside a fold", () => {
  const { doc, columns } = diff("unified");
  for (const s of doc.querySelectorAll("[data-t=sep1]")) s.replaceChildren();
  fold(doc, columns, 1);
  assert.deepEqual(visible(columns[0]!.content).slice(3, 7), ["ctx10", "sep1", "fold1", "ctx23"]);
  assertAligned(columns);
});

test("rows the reviewer unfolded between two folded hunks keep them apart", () => {
  const { doc, columns } = diff("unified");
  // @pierre expanded sep2 from its top: two of its lines render between hunk 1 and the separator.
  for (const track of [columns[0]!.gutter!, columns[0]!.content!]) {
    const sep2 = track.querySelector("[data-t=sep2]")!;
    sep2.insertAdjacentHTML("beforebegin", row("ctx19", 19, "context-expanded"));
  }
  const hunkOf = (li: string) => {
    const n = Number(li.split(",")[1]);
    return n >= 16 && n <= 18 ? 1 : n >= 23 && n <= 25 ? 2 : undefined;
  };
  const labels: string[] = [];
  foldHunks(columns, hunkOf, (run) => {
    labels.push(`fold${run.hunks.join("+")}`);
    const el = doc.createElement("div");
    el.setAttribute("data-t", labels.at(-1)!);
    return el;
  });
  assert.deepEqual(visible(columns[0]!.content).slice(3, 7), ["ctx10", "fold1", "ctx19", "fold2"]);
  assertAligned(columns);
});
