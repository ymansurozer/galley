import { test } from "node:test";
import assert from "node:assert/strict";
import { fileTree, treeFileOrder } from "./tree-derive.js";

// The tree over `paths` where `reviewed` are the changed files, indexed in the order given (the
// state.files order); any other path is an unchanged project file.
function orderOf(paths: string[], reviewed: string[]) {
  const index = new Map(reviewed.map((p, i) => [p, i]));
  return treeFileOrder(fileTree(paths, index, []));
}

test("treeFileOrder reads folders before files, each level by name — not the file array", () => {
  // git's byte order: uppercase first, and "a.ts" before the "a/" folder ('.' < '/').
  const files = ["README.md", "package.json", "src/a.ts", "src/a/x.ts", "src/b.ts"];
  // Files tab: src/ → a/ → x.ts, then a.ts, b.ts; then package.json, README.md.
  assert.deepEqual(orderOf(files, files), [3, 2, 4, 1, 0]);
});

test("treeFileOrder places a changed test right after its source file", () => {
  const files = ["lib/foo.test.ts", "lib/bar.ts", "lib/foo.ts", "lib/foo.spec.ts"];
  // Standalone by name the tests would read bar, foo.spec, foo.test, foo — folded, they follow foo.
  assert.deepEqual(orderOf(files, files), [1, 2, 3, 0]);
});

test("treeFileOrder skips unchanged files but nests a changed test under its unchanged source", () => {
  const reviewed = ["lib/foo.test.ts", "lib/foo.testing.ts"];
  // By name alone the test sorts before foo.testing.ts…
  assert.deepEqual(orderOf(reviewed, reviewed), [0, 1]);
  // …but with unchanged files shown, foo.ts is listed and its changed test folds beneath it,
  // after foo.testing.ts.
  assert.deepEqual(orderOf([...reviewed, "lib/foo.ts"], reviewed), [1, 0]);
});
