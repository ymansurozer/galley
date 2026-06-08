import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, changeBlocks, changeStableKeyFromBlock } from "./git.js";

const DIFF = `diff --git a/f.txt b/f.txt
index 0000000..1111111 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 a
-b
+B2
`;

test("parseUnifiedDiff extracts the file and its hunk", () => {
  const files = parseUnifiedDiff(DIFF);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.newPath, "f.txt");
  assert.equal(files[0]!.hunks.length, 1);
});

test("changeStableKeyFromBlock uses the first-line convention (side:line:dels:adds)", () => {
  const files = parseUnifiedDiff(DIFF);
  const blocks = changeBlocks(files[0]!.hunks[0]!);
  assert.equal(blocks.length, 1);
  // one delete (old line 2) + one add (new line 2) → keyed on the first added line
  assert.equal(changeStableKeyFromBlock(blocks[0]!), "additions:2:1:1");
});

test("a pure addition keys on the deletions side count of zero", () => {
  const diff = `diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -3,0 +4,1 @@
+added
`;
  const blocks = changeBlocks(parseUnifiedDiff(diff)[0]!.hunks[0]!);
  assert.equal(changeStableKeyFromBlock(blocks[0]!), "additions:4:0:1");
});
