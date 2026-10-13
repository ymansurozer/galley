import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseDiffFromFile } from "@pierre/diffs";
import { buildReviewResult, buildReviewState, readFileContents } from "../state.js";
import type { ReviewState } from "../types.js";
import {
  captureFileReview,
  changeStableKey,
  clearFileReview,
  restoreFileReview,
  signOff,
} from "./decisions-derive.js";
import { deriveFlowIndex } from "./flow-index.js";

// The sidebar signs off files the reviewer never opened, so the decisions it records key off the
// SERVER's change blocks, while opening a file re-derives its blocks client-side (changes.ts). These
// tests run the real server builder over a real repo: one modified file with a replace, a pure
// deletion and a pure insertion; an added file; a deleted file; and a file under a change request.
async function withRepo(fn: (state: ReviewState) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "galley-signoff-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const g = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
  const write = (rel: string, text: string) => fs.writeFile(path.join(root, rel), text);
  try {
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.co"]);
    g(["config", "user.name", "tester"]);
    await write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    await write("c.ts", "gone\nbye\n");
    await write("d.ts", "alpha\nbeta\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
    await write("a.ts", "one\nTWO\nthree\nfour\nsix\nseven\neight\nnine\nextra\nten\n");
    await write("b.ts", "x\ny\n");
    await fs.rm(path.join(root, "c.ts"));
    await write("d.ts", "alpha\nBETA\n");
    const state = await buildReviewState(root, { session: "s" });
    assert.ok(state, "built a review state for the working diff");
    await fn(state);
  } finally {
    process.env.HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

const fileOf = (state: ReviewState, p: string) => state.files.find((f) => f.path === p)!;
const result = (state: ReviewState) =>
  buildReviewResult(state, { resultJson: "r.json", sessionDir: "d" });

test("a never-opened file's server block keys are the keys opening it derives client-side", async () => {
  await withRepo(async (state) => {
    // b.ts, the untracked add, is absent: the server carries no block for it at all (see below).
    const expected: Record<string, string[]> = {
      "a.ts": ["additions:2:1:1", "deletions:5:1:0", "additions:9:0:1"],
      "c.ts": ["deletions:1:2:0"],
      "d.ts": ["additions:2:1:1"],
    };
    for (const [p, keys] of Object.entries(expected)) {
      const server = state.changes.filter((c) => c.path === p).map((c) => c.stableKey);
      assert.deepEqual(server, keys, `${p}: server block keys`);
      // Exactly what render.ts does on open: parse the file's two sides, key each change part.
      const { oldContents, newContents } = await readFileContents(state, fileOf(state, p));
      const diff = parseDiffFromFile(
        { name: p, contents: oldContents },
        { name: p, contents: newContents },
      );
      const client = diff.hunks.flatMap((h) =>
        h.hunkContent.flatMap((part) => (part.type === "change" ? [changeStableKey(part)] : [])),
      );
      assert.deepEqual(client, keys, `${p}: client block keys`);
    }
  });
});

test("signing off a never-opened clean file approves it, with every block in accepted", async () => {
  await withRepo(async (state) => {
    signOff(state, fileOf(state, "a.ts"));
    // An untracked add has no server block, so its sign-off is the file verdict alone.
    signOff(state, fileOf(state, "b.ts"));
    assert.equal(deriveFlowIndex(state).reviewState("a.ts"), "approved");
    assert.equal(deriveFlowIndex(state).reviewState("b.ts"), "approved");
    assert.equal(deriveFlowIndex(state).reviewState("d.ts"), "pending", "other files untouched");
    const r = result(state);
    assert.deepEqual(r.approvedFiles, ["a.ts", "b.ts"]);
    assert.deepEqual(r.accepted, [
      { path: "a.ts", lineNumber: 2, side: "additions", title: "1 removed · 1 added" },
      { path: "a.ts", lineNumber: 5, side: "deletions", title: "1 removed · 0 added" },
      { path: "a.ts", lineNumber: 9, side: "additions", title: "0 removed · 1 added" },
    ]);
  });
});

test("signing off a file under an open change request marks it changes-requested, not approved", async () => {
  await withRepo(async (state) => {
    state.comments.push({
      id: "c1",
      path: "d.ts",
      side: "additions",
      lineNumber: 2,
      body: "rename this",
      createdAt: "t",
      updatedAt: "t",
      status: "open",
    });
    signOff(state, fileOf(state, "d.ts"));
    assert.equal(deriveFlowIndex(state).reviewState("d.ts"), "changes-requested");
    const r = result(state);
    assert.deepEqual(r.approvedFiles, []);
    assert.deepEqual(r.accepted, [
      { path: "d.ts", lineNumber: 2, side: "additions", title: "1 removed · 1 added" },
    ]);
  });
});

test("a cleared file review restores exactly: blocks, decisions, sign-off, hash and staging", async () => {
  await withRepo(async (state) => {
    signOff(state, fileOf(state, "a.ts"));
    signOff(state, fileOf(state, "b.ts"));
    state.stagedFiles = ["a.ts", "b.ts"];
    state.stagedChangeKeys = ["a.ts:additions:2:1:1", "b.ts:additions:1:0:2"];
    const slice = () =>
      structuredClone({
        changes: state.changes.map((c) => ({ id: c.id, status: c.status, h: c.reviewedHash })),
        decisions: [...(state.decisions ?? [])].sort((x, y) => x.key.localeCompare(y.key)),
        decisionFiles: [...(state.decisionFiles ?? [])].sort(),
        reviewedFiles: [...state.reviewedFiles].sort(),
        reviewedFileHashes: state.reviewedFileHashes,
        stagedFiles: [...state.stagedFiles].sort(),
        stagedChangeKeys: [...(state.stagedChangeKeys ?? [])].sort(),
      });
    const before = slice();

    const prior = captureFileReview(state, "a.ts");
    clearFileReview(state, "a.ts");
    const ix = deriveFlowIndex(state);
    assert.equal(ix.reviewState("a.ts"), "pending");
    assert.equal(ix.reviewState("b.ts"), "approved", "only the cleared file resets");
    assert.ok(!state.decisions?.some((d) => d.path === "a.ts"));
    assert.deepEqual(state.stagedFiles, ["b.ts"]);
    assert.deepEqual(state.stagedChangeKeys, ["b.ts:additions:1:0:2"]);
    assert.ok(state.changes.filter((c) => c.path === "a.ts").every((c) => c.status === "pending"));

    restoreFileReview(state, prior);
    assert.deepEqual(slice(), before);
    assert.deepEqual(result(state).approvedFiles.sort(), ["a.ts", "b.ts"]);
  });
});
