import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

import { buildDiffSource } from "./state.js";

let root: string;
let mainBranch: string;
const git = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
const write = (rel: string, body: string) => writeFileSync(path.join(root, rel), body);

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "galley-ds-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.co"]);
  git(["config", "user.name", "tester"]);
  write("a.txt", "a\nb\nc\n");
  git(["add", "a.txt"]);
  git(["commit", "-qm", "init"]);
  mainBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(); // main or master
});
after(() => rmSync(root, { recursive: true, force: true }));

test("file mode: untracked file → full file as additions, no per-hunk changes", async () => {
  write("PLAN.md", "# Plan\n\n- step 1\n");
  const src = await buildDiffSource({ mode: "file", root, path: path.join(root, "PLAN.md") });
  assert.ok(src);
  assert.equal(src!.files.length, 1);
  assert.equal(src!.files[0]!.oldFile.contents, ""); // nothing to diff against → all additions
  assert.equal(src!.files[0]!.newFile.contents, "# Plan\n\n- step 1\n");
  assert.equal(src!.changes.length, 0); // a doc to comment on, not accept/reject
  rmSync(path.join(root, "PLAN.md"));
});

test("file mode: tracked + unchanged → full file, no changes", async () => {
  const src = await buildDiffSource({ mode: "file", root, path: path.join(root, "a.txt") });
  assert.ok(src);
  assert.equal(src!.changes.length, 0);
  assert.equal(src!.files[0]!.oldFile.contents, src!.files[0]!.newFile.contents);
});

test("file mode: tracked + changed → diff with stageable changes", async () => {
  write("a.txt", "a\nCHANGED\nc\n");
  const src = await buildDiffSource({ mode: "file", root, path: path.join(root, "a.txt") });
  assert.ok(src);
  assert.ok(src!.changes.length >= 1);
  assert.ok(src!.changes.every((c) => c.stageable === true));
  git(["checkout", "--", "a.txt"]); // restore
});

test("repo mode: working diff → stageable changes", async () => {
  write("a.txt", "a\nCHANGED\nc\n");
  const src = await buildDiffSource({ mode: "repo", root });
  assert.ok(src);
  assert.ok(src!.changes.length >= 1);
  assert.ok(src!.changes.every((c) => c.stageable === true));
  git(["checkout", "--", "a.txt"]);
});

test("pr mode: base..HEAD committed changes → verdict-only (not stageable)", async () => {
  git(["checkout", "-q", "-b", "feature"]);
  write("a.txt", "a\nPR-CHANGE\nc\n");
  git(["commit", "-qm", "pr change", "--", "a.txt"]);
  const src = await buildDiffSource({ mode: "pr", root, base: mainBranch });
  assert.ok(src);
  assert.ok(src!.changes.length >= 1);
  assert.ok(src!.changes.every((c) => c.stageable === false));
});

// The old side must read from the INDEX, not HEAD: the UI re-diffs old/new contents
// itself, so a HEAD baseline resurrects already-staged hunks as pending diff. (Staging
// is what advances the review baseline between rounds — see buildDiffSource.)
test("repo mode: staged content is the old-side baseline, not HEAD", async () => {
  write("a.txt", "a\nROUND1\nc\n");
  git(["add", "a.txt"]); // round 1: reviewed + staged
  write("a.txt", "a\nROUND1\nc\nROUND2\n"); // round 2: agent edits again
  const src = await buildDiffSource({ mode: "repo", root });
  assert.ok(src);
  assert.equal(src!.files[0]!.oldFile.contents, "a\nROUND1\nc\n"); // index, not HEAD
  assert.equal(src!.files[0]!.newFile.contents, "a\nROUND1\nc\nROUND2\n");
  assert.equal(src!.changes.length, 1); // only the round-2 edit is up for review
  assert.equal(src!.changes[0]!.side, "additions");
});

test("repo mode: fully staged file with no further edits → no diff at all", async () => {
  git(["checkout", "--", "a.txt"]); // working tree back to the index version
  const src = await buildDiffSource({ mode: "repo", root });
  assert.equal(src, null);
});

test("file mode: staged content is the old-side baseline, not HEAD", async () => {
  write("a.txt", "a\nROUND1\nc\nFILE2\n");
  const src = await buildDiffSource({ mode: "file", root, path: path.join(root, "a.txt") });
  assert.ok(src);
  assert.equal(src!.files[0]!.oldFile.contents, "a\nROUND1\nc\n"); // index, not HEAD
  assert.equal(src!.changes.length, 1);
  git(["restore", "--staged", "a.txt"]);
  git(["checkout", "--", "a.txt"]);
});

// `git diff` never lists untracked files, so the working review must surface them itself —
// otherwise a brand-new file the agent created (but never `git add`ed) silently vanishes.
test("repo mode: untracked file → full additions alongside tracked changes", async () => {
  write("a.txt", "a\nUNTRACKED-NEIGHBOR\nc\n"); // a tracked change…
  write("new.ts", "export const x = 1;\n"); // …and a brand-new untracked file
  const src = await buildDiffSource({ mode: "repo", root });
  assert.ok(src);
  const newFile = src!.files.find((f) => f.path === "new.ts");
  assert.ok(newFile, "untracked file should appear in the working diff");
  assert.equal(newFile!.oldFile.contents, ""); // nothing to diff against → all additions
  assert.equal(newFile!.newFile.contents, "export const x = 1;\n");
  assert.equal(
    src!.changes.filter((c) => c.path === "new.ts").length,
    0, // no per-hunk changes — whole-file Approve stages it via `git add`
  );
  assert.ok(src!.changes.some((c) => c.path === "a.txt")); // tracked change still present
  git(["checkout", "--", "a.txt"]);
  rmSync(path.join(root, "new.ts"));
});

// Guards the early-return: with every tracked change staged, `git diff` is empty — but an
// untracked-only working tree must still open a desk, not return null.
test("repo mode: only untracked files, nothing else changed → non-null", async () => {
  write("new.ts", "export const y = 2;\n");
  const src = await buildDiffSource({ mode: "repo", root });
  assert.ok(src, "untracked-only working tree should still produce a review");
  assert.equal(src!.files.length, 1);
  assert.equal(src!.files[0]!.path, "new.ts");
  rmSync(path.join(root, "new.ts"));
});

test("repo mode: staged diff ignores untracked files", async () => {
  write("new.ts", "export const z = 3;\n"); // untracked, never added
  const src = await buildDiffSource({ mode: "repo", root, staged: true });
  assert.equal(src, null); // nothing staged, and untracked must not leak into staged mode
  rmSync(path.join(root, "new.ts"));
});
