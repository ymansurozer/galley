import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewResult, buildReviewSummary, mergeReviewState, sanitizeSession } from "./state.js";
import type { ChangeState, ReviewComment, ReviewState } from "./types.js";

function file(path: string) {
  return { path, hunks: [], oldFile: { name: path, contents: "" }, newFile: { name: path, contents: "" } };
}
function change(over: Partial<ChangeState> & { id: string; path: string }): ChangeState {
  return { hunkIndex: 0, side: "additions", lineNumber: 1, title: "", status: "pending", ...over };
}
function comment(over: Partial<ReviewComment> & { id: string; path: string }): ReviewComment {
  return { side: "additions", lineNumber: 1, body: "", createdAt: "t", updatedAt: "t", status: "open", ...over };
}
function state(over: Partial<ReviewState>): ReviewState {
  return {
    id: "id", session: "s", root: "/r", repoHash: "h", mode: "repo", staged: false, head: null,
    baseDiffHash: "base", createdAt: "t", rawDiff: "", files: [], comments: [],
    changes: [], reviewedFiles: [], stagedFiles: [], ...over,
  };
}

test("mergeReviewState carries a prior decision when content is unchanged", () => {
  const base = state({ baseDiffHash: "new", files: [file("a.ts")], changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "H" })] });
  const saved = state({ changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", status: "accepted", reviewedHash: "H" })] });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "accepted");
  assert.equal(merged.changes[0]!.reviewedHash, "H");
  assert.equal(merged.baseDiffHash, "new"); // adopts the fresh diff hash
});

test("mergeReviewState resets a decision to pending when content changed (staleness)", () => {
  const base = state({ files: [file("a.ts")], changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "H" })] });
  const saved = state({ changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", status: "accepted", reviewedHash: "OLD" })] });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "pending");
});

test("mergeReviewState matches a saved decision by stableKey even if the id differs", () => {
  const base = state({ files: [file("a.ts")], changes: [change({ id: "a.ts:NEWID", path: "a.ts", stableKey: "k1", contentHash: "H" })] });
  const saved = state({ changes: [change({ id: "a.ts:OLDID", path: "a.ts", stableKey: "k1", status: "rejected", reviewedHash: "H" })] });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "rejected");
});

test("mergeReviewState retains comments on present files, keeps absent action comments as stale, drops absent notes", () => {
  const base = state({ files: [file("a.ts")] }); // b.ts is gone from the diff
  const saved = state({ comments: [
    comment({ id: "c1", path: "a.ts" }),
    comment({ id: "c2", path: "b.ts", intent: "action" }),
    comment({ id: "c3", path: "b.ts", intent: "note" }),
  ] });
  const merged = mergeReviewState(base, saved);
  const ids = merged.comments.map((c) => c.id).sort();
  assert.deepEqual(ids, ["c1", "c2"]);
  assert.equal(merged.comments.find((c) => c.id === "c1")!.status, "open");
  assert.equal(merged.comments.find((c) => c.id === "c2")!.status, "stale");
});

test("mergeReviewState (reload shape): folds a fresh diff into a live state — carry, stale, comments, hash", () => {
  // Simulates POST /api/reload: base = fresh diff, saved = live in-memory state.
  const base = state({
    baseDiffHash: "afterEdit",
    files: [file("a.ts")],
    changes: [
      change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "SAME" }),
      change({ id: "a.ts:k2", path: "a.ts", stableKey: "k2", contentHash: "CHANGED" }),
    ],
  });
  const live = state({
    baseDiffHash: "beforeEdit",
    comments: [comment({ id: "c1", path: "a.ts", role: "agent", intent: "note" })],
    changes: [
      change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", status: "accepted", reviewedHash: "SAME" }),
      change({ id: "a.ts:k2", path: "a.ts", stableKey: "k2", status: "accepted", reviewedHash: "WAS" }),
    ],
  });
  const merged = mergeReviewState(base, live);
  assert.equal(merged.baseDiffHash, "afterEdit");
  assert.equal(merged.changes.find((c) => c.stableKey === "k1")!.status, "accepted"); // unchanged → carried
  assert.equal(merged.changes.find((c) => c.stableKey === "k2")!.status, "pending");  // changed → re-review
  assert.equal(merged.comments.length, 1); // the agent comment survives
  assert.equal(merged.comments[0]!.id, "c1");
});

test("buildReviewResult carries mode/target/base", () => {
  const s = state({ mode: "pr", target: "feature-x", base: "abc123" });
  const r = buildReviewResult(s, { resultJson: "r.json", summaryMd: "s.md", sessionDir: "d" });
  assert.equal(r.mode, "pr");
  assert.equal(r.target, "feature-x");
  assert.equal(r.base, "abc123");
});

test("buildReviewSummary uses PR wording and omits staged files in pr mode", () => {
  const s = state({
    mode: "pr", target: "feature-x", stagedFiles: ["a.ts"],
    changes: [
      change({ id: "1", path: "a.ts", status: "accepted", stageable: false }),
      change({ id: "2", path: "b.ts", status: "rejected", stageable: false }),
    ],
  });
  const md = buildReviewSummary(s);
  assert.match(md, /PR\/branch `feature-x`/);
  assert.match(md, /## Approved hunks/);
  assert.match(md, /## Hunks needing changes/);
  assert.doesNotMatch(md, /Staged files/);
  assert.doesNotMatch(md, /Accepted line changes/);
});

test("buildReviewSummary keeps repo wording in repo mode", () => {
  const s = state({ mode: "repo", changes: [change({ id: "1", path: "a.ts", status: "accepted" })] });
  assert.match(buildReviewSummary(s), /## Accepted line changes/);
});

test("sanitizeSession normalizes branch names and falls back", () => {
  assert.equal(sanitizeSession("feature/x"), "feature-x");
  assert.equal(sanitizeSession("--weird--"), "weird");
  assert.equal(sanitizeSession("ok.name_1"), "ok.name_1");
  assert.equal(sanitizeSession(""), "review");
  assert.equal(sanitizeSession("///"), "review");
});
