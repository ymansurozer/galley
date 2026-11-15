import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffHunk, DiffLine } from "../types";
import {
  linePart,
  readLinePart,
  sliceRange,
  slicePatch,
  sliceRows,
  spanLabel,
} from "./topics-lines-derive";

// app.ts's hunk: line 10 replaced by two lines, three lines of context each side.
const line = (kind: DiffLine["kind"], text: string): DiffLine => ({
  kind,
  text,
  diffPosition: 0,
  hunkHeader: "",
});
const replaced: DiffHunk = {
  header: "@@ -7,7 +7,8 @@",
  oldStart: 7,
  oldCount: 7,
  newStart: 7,
  newCount: 8,
  lines: [
    line("context", "l7"),
    line("context", "l8"),
    line("context", "l9"),
    line("delete", "l10"),
    line("add", "C1"),
    line("add", "C2"),
    line("context", "l11"),
    line("context", "l12"),
    line("context", "l13"),
  ],
};
// Two lines added after line 30 (new 31-32), lower down.
const added: DiffHunk = {
  header: "@@ -30,0 +31,2 @@",
  oldStart: 30,
  oldCount: 0,
  newStart: 31,
  newCount: 2,
  lines: [line("add", "N1"), line("add", "N2")],
};
const where = (rows: ReturnType<typeof sliceRows>) =>
  rows.map((r) => `${r.kind}:${r.side}:${r.line}:${r.text}`);

test("a range draws its lines and the removed lines among them, each anchored as Code mode anchors it", () => {
  assert.deepEqual(where(sliceRows([replaced, added], 10, 11)), [
    "delete:deletions:10:l10",
    "add:additions:10:C1",
    "add:additions:11:C2",
  ]);
  assert.deepEqual(where(sliceRows([replaced, added], 9, 12)), [
    "context:additions:9:l9",
    "delete:deletions:10:l10",
    "add:additions:10:C1",
    "add:additions:11:C2",
    "context:additions:12:l11",
  ]);
  // A range ending on the line before a removal still shows it: the removal touches the range.
  assert.deepEqual(where(sliceRows([replaced], 8, 9)), [
    "context:additions:8:l8",
    "context:additions:9:l9",
    "delete:deletions:10:l10",
  ]);
  assert.deepEqual(where(sliceRows([replaced, added], 31, 31)), ["add:additions:31:N1"]);
  // An untracked file: its own lines, all added.
  assert.deepEqual(where(sliceRows([], 2, 3, ["a", "b", "c", "d"])), [
    "add:additions:2:b",
    "add:additions:3:c",
  ]);
});

test("a slice's range by side spans the old and new lines its rows show", () => {
  assert.deepEqual(sliceRange(sliceRows([replaced], 9, 12)), {
    additions: [9, 12],
    deletions: [9, 11],
  });
  // No removed or context line: an empty range on the old side.
  assert.deepEqual(sliceRange(sliceRows([added], 31, 32)), {
    additions: [31, 32],
    deletions: [1, 0],
  });
});

test("the slice's patch holds a hunk per run of rows, numbered as the file is", () => {
  assert.equal(
    slicePatch("src/app.ts", sliceRows([replaced, added], 9, 32)),
    [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -9,5 +9,6 @@",
      " l9",
      "-l10",
      "+C1",
      "+C2",
      " l11",
      " l12",
      " l13",
      "@@ -30,0 +31,2 @@",
      "+N1",
      "+N2",
      "",
    ].join("\n"),
  );
  assert.equal(
    slicePatch("src/app.ts", sliceRows([replaced], 10, 11)),
    "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -10,1 +10,2 @@\n-l10\n+C1\n+C2\n",
  );
});

test("a line part names its side, line and path, and reads back", () => {
  const part = linePart("deletions", 10, "src/a:b.ts");
  assert.equal(part, "line:deletions:10:src/a:b.ts");
  assert.deepEqual(readLinePart(part), { side: "deletions", line: 10, path: "src/a:b.ts" });
  assert.equal(readLinePart("body:3"), null);
  assert.equal(spanLabel({ path: "a.ts", start: 4, end: 4 }), "a.ts:4");
  assert.equal(spanLabel({ path: "a.ts", start: 4, end: 9 }), "a.ts:4-9");
});
