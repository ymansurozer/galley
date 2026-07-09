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

// ── git -M rename handling (issue 01) ────────────────────────────────────────

test("a pure rename (zero hunks, distinct paths) is kept, from the rename headers", () => {
  const diff = `diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
`;
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1); // NOT filtered out despite zero hunks
  // Paths come from the rename headers, so spaces survive (the diff --git regex would mangle them).
  assert.equal(files[0]!.oldPath, "old name.txt");
  assert.equal(files[0]!.newPath, "new name.txt");
  assert.equal(files[0]!.hunks.length, 0);
});

test("a rename+edit keeps distinct paths AND its hunk", () => {
  const diff = `diff --git a/old.txt b/new.txt
similarity index 80%
rename from old.txt
rename to new.txt
index 1111111..2222222 100644
--- a/old.txt
+++ b/new.txt
@@ -1,2 +1,2 @@
 a
-b
+B
`;
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.oldPath, "old.txt");
  assert.equal(files[0]!.newPath, "new.txt");
  assert.equal(files[0]!.hunks.length, 1);
});

test("a mode-only change (zero hunks, same path) stays dropped", () => {
  const diff = `diff --git a/s.sh b/s.sh
old mode 100644
new mode 100755
`;
  assert.equal(parseUnifiedDiff(diff).length, 0);
});

test("a same-path binary diff stays dropped", () => {
  const diff = `diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
`;
  assert.equal(parseUnifiedDiff(diff).length, 0);
});

test("a renamed binary (distinct paths + Binary line) is dropped, not read as text", () => {
  const diff = `diff --git a/old.png b/new.png
similarity index 60%
rename from old.png
rename to new.png
index 1111111..2222222 100644
Binary files a/old.png and b/new.png differ
`;
  assert.equal(parseUnifiedDiff(diff).length, 0);
});
