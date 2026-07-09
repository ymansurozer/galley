import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, renameSync } from "node:fs";
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

// ── git -M rename handling (issue 01) ────────────────────────────────────────
// Self-contained repos (own git init) so ordering can't collide with the shared-root tests above,
// and so we can force `diff.renames=false` — proving detection rides our explicit -M, not config.

function freshRepo(renamesOff: boolean): { dir: string; main: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "galley-rn-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir }).toString();
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.co"]);
  g(["config", "user.name", "tester"]);
  if (renamesOff) g(["config", "diff.renames", "false"]);
  writeFileSync(path.join(dir, "old.txt"), "a\nb\nc\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  const main = g(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return { dir, main };
}

test("pr mode: rename+edit with diff.renames=false → one file at the new path, edited lines only", async () => {
  const { dir, main } = freshRepo(true);
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir }).toString();
  g(["checkout", "-q", "-b", "feature"]);
  g(["mv", "old.txt", "new.txt"]);
  writeFileSync(path.join(dir, "new.txt"), "a\nB\nc\n"); // one edited line
  g(["commit", "-qam", "rename + edit"]);
  const src = await buildDiffSource({ mode: "pr", root: dir, base: main });
  assert.ok(src);
  assert.equal(src!.files.length, 1);
  const f = src!.files[0]!;
  assert.equal(f.path, "new.txt");
  assert.equal(f.oldFile.name, "old.txt"); // distinct names → @pierre infers rename-changed
  assert.equal(f.newFile.name, "new.txt");
  assert.equal(f.oldFile.contents, "a\nb\nc\n"); // full old content (moved, not re-added)
  assert.equal(f.newFile.contents, "a\nB\nc\n");
  assert.equal(src!.changes.length, 1); // only the edited line is up for review, not the whole file
  rmSync(dir, { recursive: true, force: true });
});

test("pr mode: a pure committed rename → a zero-hunk entry at the new path, distinct names", async () => {
  const { dir, main } = freshRepo(true);
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir }).toString();
  g(["checkout", "-q", "-b", "feature"]);
  g(["mv", "old.txt", "new.txt"]);
  g(["commit", "-qam", "pure rename"]);
  const src = await buildDiffSource({ mode: "pr", root: dir, base: main });
  assert.ok(src, "a pure rename must not vanish from the review");
  assert.equal(src!.files.length, 1);
  const f = src!.files[0]!;
  assert.equal(f.path, "new.txt");
  assert.equal(f.oldFile.name, "old.txt");
  assert.equal(f.newFile.name, "new.txt");
  assert.equal(f.hunks.length, 0); // no content change
  assert.equal(f.oldFile.contents, f.newFile.contents); // identical → the muted moved row in the UI
  assert.equal(src!.changes.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("staged mode: a staged git mv + edit renders as a merged rename", async () => {
  const { dir } = freshRepo(false);
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir }).toString();
  g(["mv", "old.txt", "new.txt"]);
  writeFileSync(path.join(dir, "new.txt"), "a\nB\nc\n");
  g(["add", "."]);
  const src = await buildDiffSource({ mode: "repo", root: dir, staged: true });
  assert.ok(src);
  assert.equal(src!.files.length, 1);
  const f = src!.files[0]!;
  assert.equal(f.path, "new.txt");
  assert.equal(f.oldFile.name, "old.txt");
  assert.equal(f.newFile.name, "new.txt");
  assert.equal(src!.changes.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── working-mode move pairing (issue 02) ─────────────────────────────────────
// A plain `mv` (no git mv) shows as a full deletion + a full untracked addition; git can't see
// the move. buildDiffSource pairs byte-identical halves into one rename-pure entry.

test("repo mode: a plain mv (no edit) pairs into one rename-pure entry", async () => {
  const { dir } = freshRepo(false);
  renameSync(path.join(dir, "old.txt"), path.join(dir, "new.txt")); // plain mv, not git mv
  const src = await buildDiffSource({ mode: "repo", root: dir });
  assert.ok(src);
  assert.equal(src!.files.length, 1); // merged, not delete + add
  const f = src!.files[0]!;
  assert.equal(f.path, "new.txt");
  assert.equal(f.oldPath, "old.txt");
  assert.equal(f.newPath, "new.txt");
  assert.equal(f.oldFile.name, "old.txt");
  assert.equal(f.newFile.name, "new.txt");
  assert.equal(f.oldFile.contents, f.newFile.contents); // identical → the muted moved row
  assert.equal(src!.changes.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("repo mode: two identical untracked copies of a deleted file → nothing paired (ambiguity)", async () => {
  const { dir } = freshRepo(false);
  rmSync(path.join(dir, "old.txt")); // delete the tracked file…
  writeFileSync(path.join(dir, "copy1.txt"), "a\nb\nc\n"); // …and two byte-identical untracked copies
  writeFileSync(path.join(dir, "copy2.txt"), "a\nb\nc\n");
  const src = await buildDiffSource({ mode: "repo", root: dir });
  assert.ok(src);
  assert.deepEqual(
    src!.files.map((f) => f.path).sort(),
    ["copy1.txt", "copy2.txt", "old.txt"], // deletion stays + two additions, none merged
  );
  assert.equal(
    src!.files.find((f) => f.path === "old.txt")!.newPath,
    undefined, // still a plain deletion, not a rename
  );
  rmSync(dir, { recursive: true, force: true });
});

test("repo mode: mv + edit is NOT paired — renders as delete + add (exact-content only)", async () => {
  const { dir } = freshRepo(false);
  rmSync(path.join(dir, "old.txt"));
  writeFileSync(path.join(dir, "new.txt"), "a\nB\nc\n"); // moved AND edited → not byte-identical
  const src = await buildDiffSource({ mode: "repo", root: dir });
  assert.ok(src);
  assert.deepEqual(src!.files.map((f) => f.path).sort(), ["new.txt", "old.txt"]);
  assert.equal(src!.files.find((f) => f.path === "old.txt")!.newPath, undefined); // deletion
  assert.equal(src!.files.find((f) => f.path === "new.txt")!.oldFile.contents, ""); // untracked add
  rmSync(dir, { recursive: true, force: true });
});

test("mode-only and same-path binary changes still produce no review entry", async () => {
  const { dir } = freshRepo(false);
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir }).toString();
  const shPath = path.join(dir, "s.sh");
  const binPath = path.join(dir, "img.bin");
  writeFileSync(shPath, "#!/bin/sh\necho hi\n");
  writeFileSync(binPath, Buffer.from([0, 1, 2, 0, 255]));
  g(["add", "."]);
  g(["commit", "-qm", "add binary + script"]);
  // A mode-only change on the script, and a byte change to the binary — both zero-hunk, same-path.
  execFileSync("chmod", ["755", shPath], { cwd: dir });
  writeFileSync(binPath, Buffer.from([0, 9, 9, 9, 255]));
  const src = await buildDiffSource({ mode: "repo", root: dir });
  assert.equal(src, null); // no text hunks and same-path → both drop; nothing else → null
  rmSync(dir, { recursive: true, force: true });
});
