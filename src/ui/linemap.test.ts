import { test } from "node:test";
import assert from "node:assert/strict";
import type { FileDiffMetadata } from "@pierre/diffs";
import { anchorSelection, buildLineMap } from "./linemap.js";

// Hand-built fixture (importing @pierre's parser would pull component code into node).
// One hunk, three change blocks separated by context, mirroring the shape
// parseDiffFromFile produces. Only the fields buildLineMap reads are populated.
//
//   raw old (deletions)        raw new (additions)
//   1  ctx                     1  ctx
//   2  del A1  ─┐ block A      2  add A1 ─┐ block A (2 del → 3 add)
//   3  del A2  ─┘              3  add A2  │
//                              4  add A3 ─┘
//   4  ctx                     5  ctx
//   5  del B1  ─  block B      6  add B1 ─┐ block B (1 del → 2 add)
//                              7  add B2 ─┘
//   6  ctx                     8  ctx
//   7  del C1 ─┐ block C       —          (3 del → 0 add, pure deletion)
//   8  del C2  │
//   9  del C3 ─┘
//   10 ctx                     9  ctx
function fixture(): FileDiffMetadata {
  const ctx = (lines: number, delIdx: number, addIdx: number) => ({
    type: "context" as const,
    lines,
    deletionLineIndex: delIdx,
    additionLineIndex: addIdx,
  });
  const chg = (dels: number, adds: number, delIdx: number, addIdx: number) => ({
    type: "change" as const,
    deletions: dels,
    additions: adds,
    deletionLineIndex: delIdx,
    additionLineIndex: addIdx,
  });
  return {
    hunks: [
      {
        hunkContent: [
          ctx(1, 0, 0),
          chg(2, 3, 1, 1), // block A: old 2-3 → new 2-4
          ctx(1, 3, 4),
          chg(1, 2, 4, 5), // block B: old 5 → new 6-7
          ctx(1, 5, 7),
          chg(3, 0, 6, 8), // block C: old 7-9, pure deletion
          ctx(1, 9, 8),
        ],
      },
    ],
  } as unknown as FileDiffMetadata;
}

test("buildLineMap with no decisions is identity", () => {
  const m = buildLineMap(fixture(), []);
  assert.equal(m.toDisplay("deletions", 7), 7);
  assert.equal(m.fromDisplay("additions", 6), 6);
});

test("accepting a block shifts later DELETION-side lines by adds − dels", () => {
  // Accept block A (2 del → 3 add): the deletion side now shows the 3 additions as
  // context, so everything past old line 3 renders one line lower.
  const m = buildLineMap(fixture(), [{ hunkIndex: 0, changeIndex: 1, status: "accepted" }]);
  assert.equal(m.toDisplay("deletions", 3), 3); // inside/at the block: unshifted
  assert.equal(m.toDisplay("deletions", 4), 5); // ctx after A
  assert.equal(m.toDisplay("deletions", 7), 8); // block C start
  assert.equal(m.toDisplay("additions", 6), 6); // addition side untouched by an accept
  // Round-trips
  assert.equal(m.fromDisplay("deletions", m.toDisplay("deletions", 7)), 7);
  assert.equal(m.fromDisplay("deletions", m.toDisplay("deletions", 4)), 4);
});

test("rejecting a block shifts later ADDITION-side lines by dels − adds", () => {
  // Reject block B (1 del → 2 add): the addition side shows the 1 deletion as context,
  // so everything past new line 7 renders one line higher.
  const m = buildLineMap(fixture(), [{ hunkIndex: 0, changeIndex: 3, status: "rejected" }]);
  assert.equal(m.toDisplay("additions", 5), 5); // before the block
  assert.equal(m.toDisplay("additions", 8), 7); // ctx after B
  assert.equal(m.toDisplay("deletions", 7), 7); // deletion side untouched by a reject
  assert.equal(m.fromDisplay("additions", m.toDisplay("additions", 8)), 8);
});

test("multiple decisions accumulate in document order", () => {
  // Accept A (+1 on deletions past old 3) and accept C (−3 on deletions past old 9).
  const m = buildLineMap(fixture(), [
    { hunkIndex: 0, changeIndex: 1, status: "accepted" },
    { hunkIndex: 0, changeIndex: 5, status: "accepted" },
  ]);
  assert.equal(m.toDisplay("deletions", 4), 5); // after A only
  assert.equal(m.toDisplay("deletions", 10), 8); // after A (+1) and C (−3)
  assert.equal(m.fromDisplay("deletions", 8), 10);
  assert.equal(m.fromDisplay("deletions", 5), 4);
});

test("non-change or out-of-range decided positions are ignored", () => {
  const m = buildLineMap(fixture(), [
    { hunkIndex: 0, changeIndex: 0, status: "accepted" }, // context entry
    { hunkIndex: 5, changeIndex: 0, status: "accepted" }, // no such hunk
  ]);
  assert.equal(m.toDisplay("deletions", 10), 10);
});

// ── Anchoring a selection on a resolved block's row ──────────────────────────
// A resolved block renders one version of its code in both gutters, so a row anchors to the line
// it shows: the new side for an accept, the old side for a reject.

test("a row of an accepted block anchors to the new-side line it shows, from either gutter", () => {
  // Accept A (old 2-3 → new 2-4): display deletions 2-4 show new lines 2-4.
  const m = buildLineMap(fixture(), [{ hunkIndex: 0, changeIndex: 1, status: "accepted" }]);
  assert.deepEqual(m.anchorAt("deletions", 2), { side: "additions", line: 2 });
  assert.deepEqual(m.anchorAt("deletions", 4), { side: "additions", line: 4 });
  assert.deepEqual(m.anchorAt("additions", 3), { side: "additions", line: 3 });
  // Real rows around it keep their own side: old ctx 4 renders at deletions 5.
  assert.deepEqual(m.anchorAt("deletions", 5), { side: "deletions", line: 4 });
  assert.deepEqual(m.anchorAt("deletions", 1), { side: "deletions", line: 1 });
});

test("a row of a rejected block anchors to the old-side line it shows, from either gutter", () => {
  // Reject C (old 7-9, a pure deletion): display additions 9-11 show old lines 7-9.
  const m = buildLineMap(fixture(), [{ hunkIndex: 0, changeIndex: 5, status: "rejected" }]);
  assert.deepEqual(m.anchorAt("additions", 9), { side: "deletions", line: 7 });
  assert.deepEqual(m.anchorAt("additions", 11), { side: "deletions", line: 9 });
  assert.deepEqual(m.anchorAt("deletions", 8), { side: "deletions", line: 8 });
  // New ctx 9 renders at additions 12.
  assert.deepEqual(m.anchorAt("additions", 12), { side: "additions", line: 9 });
});

test("rows anchor to their shown lines with accepts and rejects mixed and lines shifted", () => {
  // Accept A and B (each shifts the deletion side +1), reject C. Deletions: B's new lines 6-7
  // render at 6-7 below A's extra line; additions: C's old 7-9 render at 9-11.
  const m = buildLineMap(fixture(), [
    { hunkIndex: 0, changeIndex: 1, status: "accepted" },
    { hunkIndex: 0, changeIndex: 3, status: "accepted" },
    { hunkIndex: 0, changeIndex: 5, status: "rejected" },
  ]);
  assert.deepEqual(m.anchorAt("deletions", 6), { side: "additions", line: 6 });
  assert.deepEqual(m.anchorAt("deletions", 7), { side: "additions", line: 7 });
  assert.deepEqual(m.anchorAt("deletions", 8), { side: "deletions", line: 6 }); // ctx
  assert.deepEqual(m.anchorAt("additions", 10), { side: "deletions", line: 8 });
});

test("a selection anchors each end to its row, and a range across real rows keeps its side", () => {
  const m = buildLineMap(fixture(), [{ hunkIndex: 0, changeIndex: 1, status: "accepted" }]);
  // Two rows of accepted A, from the old gutter: the new lines they show.
  assert.deepEqual(anchorSelection(m, "deletions", 2, 3), {
    side: "additions",
    line: 2,
    endLine: 3,
  });
  assert.deepEqual(anchorSelection(m, "deletions", 3), { side: "additions", line: 3 });
  // ctx 1 through A's first row: a real row in the range, so both ends map as before.
  assert.deepEqual(anchorSelection(m, "deletions", 1, 2), {
    side: "deletions",
    line: 1,
    endLine: 2,
  });
});
