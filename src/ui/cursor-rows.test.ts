import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRows, type Row } from "./cursor-rows";

// Build a measured row with the only fields mergeRows reads; `el` is carried through untouched.
function row(side: Row["side"], line: number, top: number, change = false): Row {
  return { el: {} as HTMLElement, side, line, top, height: 20, change };
}

test("orders rows top-to-bottom regardless of input order", () => {
  const out = mergeRows([row("additions", 3, 40), row("additions", 1, 0), row("additions", 2, 20)]);
  assert.deepEqual(
    out.map((r) => r.line),
    [1, 2, 3],
  );
});

test("merges split-view twins at the same rounded top — additions stays primary", () => {
  // A context line shows in both columns at (near-)identical y; the additions cell sorts first,
  // so it becomes the primary row and the deletions coordinate is preserved as `alt`.
  const out = mergeRows([row("deletions", 3, 10.4), row("additions", 5, 10.2)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].side, "additions");
  assert.equal(out[0].line, 5);
  assert.deepEqual(out[0].alt, { side: "deletions", line: 3 });
});

test("keeps rows at distinct tops separate and merges only on rounded equality", () => {
  const out = mergeRows([
    row("additions", 1, 10.2),
    row("deletions", 9, 10.4), // rounds to 10 → merged into the row above as its twin
    row("additions", 2, 30),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((r) => r.line),
    [1, 2],
  );
  assert.deepEqual(out[0].alt, { side: "deletions", line: 9 });
  assert.equal(out[1].alt, undefined);
});
