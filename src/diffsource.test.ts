import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
