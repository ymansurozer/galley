import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewResult, buildReviewSummary, mergeReviewState, sanitizeSession } from "./state.js";
import type { ChangeState, Decision, ReviewComment, ReviewState } from "./types.js";

function file(path: string, contentHash = "FH") {
  return { path, hunks: [], oldFile: { name: path, contents: "" }, newFile: { name: path, contents: "" }, contentHash };
}
function change(over: Partial<ChangeState> & { id: string; path: string }): ChangeState {
  return { hunkIndex: 0, side: "additions", lineNumber: 1, title: "", status: "pending", ...over };
}
function comment(over: Partial<ReviewComment> & { id: string; path: string }): ReviewComment {
  return { side: "additions", lineNumber: 1, body: "", createdAt: "t", updatedAt: "t", status: "open", ...over };
}
function decision(over: Partial<Decision> & { key: string; path: string }): Decision {
  return { status: "accepted", lineNumber: 1, side: "additions", title: "", ...over };
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

test("mergeReviewState keeps an explicit decision whose hunk left the diff (accepted→staged)", () => {
  // Accepting stages the hunk, so it disappears from the working-tree diff: the
  // rebuilt base has no change for it, yet the decision must survive.
  const base = state({ files: [file("a.ts")], changes: [] });
  const saved = state({
    files: [file("a.ts")], changes: [],
    decisions: [decision({ key: "a.ts:k1", path: "a.ts", status: "accepted", reviewedHash: "H", lineNumber: 4, title: "1 removed · 5 added" })],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.decisions!.length, 1);
  assert.equal(merged.decisions![0]!.status, "accepted");
});

test("mergeReviewState drops an explicit decision that went stale (content changed, still visible)", () => {
  const base = state({ files: [file("a.ts")], changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "NEW" })] });
  const saved = state({
    files: [file("a.ts")], changes: [],
    decisions: [decision({ key: "a.ts:k1", path: "a.ts", status: "accepted", reviewedHash: "OLD" })],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "pending"); // stale → re-review
  assert.equal(merged.decisions!.length, 0);          // and the decision is removed
});

test("buildReviewResult reads decisions, so a staged-out accepted hunk still appears in accepted[]", () => {
  const s = state({
    mode: "repo", changes: [], // the accepted hunk is gone from the working diff (staged)
    decisions: [decision({ key: "a.ts:k1", path: "a.ts", status: "accepted", lineNumber: 4, side: "additions", title: "1 removed · 5 added" })],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", summaryMd: "s.md", sessionDir: "d" });
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0]!.path, "a.ts");
  assert.equal(r.accepted[0]!.lineNumber, 4);
});

test("buildReviewResult excludes questions from requestedChanges, keeps an action on the same line", () => {
  const s = state({ comments: [
    comment({ id: "q", path: "a.ts", lineNumber: 4, body: "why is this here?", intent: "question" }),
    comment({ id: "a", path: "a.ts", lineNumber: 4, body: "rename this", intent: "action" }),
  ] });
  const r = buildReviewResult(s, { resultJson: "r.json", summaryMd: "s.md", sessionDir: "d" });
  assert.equal(r.requestedChanges.length, 1);
  assert.equal(r.requestedChanges[0]!.body, "rename this");
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

test("mergeReviewState keeps a finished file when its content hash is unchanged", () => {
  const base = state({ files: [file("a.ts", "H")] });
  const saved = state({ files: [file("a.ts", "H")], reviewedFiles: ["a.ts"], reviewedFileHashes: { "a.ts": "H" } });
  const merged = mergeReviewState(base, saved);
  assert.deepEqual(merged.reviewedFiles, ["a.ts"]);
  assert.equal(merged.reviewedFileHashes!["a.ts"], "H");
});

test("mergeReviewState drops a finished file when its content hash changed (re-review)", () => {
  const base = state({ files: [file("a.ts", "NEW")] });
  const saved = state({ files: [file("a.ts", "OLD")], reviewedFiles: ["a.ts"], reviewedFileHashes: { "a.ts": "OLD" } });
  const merged = mergeReviewState(base, saved);
  assert.deepEqual(merged.reviewedFiles, []);
  assert.deepEqual(merged.reviewedFileHashes, {});
});

test("mergeReviewState drops a finished file with no recorded hash (old viewed-era session)", () => {
  const base = state({ files: [file("a.ts", "H")] });
  const saved = state({ files: [file("a.ts", "H")], reviewedFiles: ["a.ts"] }); // no reviewedFileHashes
  const merged = mergeReviewState(base, saved);
  assert.deepEqual(merged.reviewedFiles, []);
});

test("buildReviewResult.approvedFiles includes a clean signed-off file", () => {
  const s = state({ files: [file("a.ts", "H")], reviewedFiles: ["a.ts"], reviewedFileHashes: { "a.ts": "H" } });
  const r = buildReviewResult(s, { resultJson: "r.json", summaryMd: "s.md", sessionDir: "d" });
  assert.deepEqual(r.approvedFiles, ["a.ts"]);
});

test("buildReviewResult.approvedFiles excludes a signed-off file with a rejected hunk", () => {
  const s = state({
    files: [file("a.ts", "H")], reviewedFiles: ["a.ts"], reviewedFileHashes: { "a.ts": "H" },
    decisions: [decision({ key: "a.ts:k1", path: "a.ts", status: "rejected" })],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", summaryMd: "s.md", sessionDir: "d" });
  assert.deepEqual(r.approvedFiles, []);
});

test("buildReviewResult.approvedFiles excludes a signed-off file with an open action comment, keeps one with only a question", () => {
  const s = state({
    files: [file("a.ts", "H"), file("b.ts", "H")],
    reviewedFiles: ["a.ts", "b.ts"], reviewedFileHashes: { "a.ts": "H", "b.ts": "H" },
    comments: [
      comment({ id: "c1", path: "a.ts", status: "open", role: "user", intent: "action", body: "fix" }),
      comment({ id: "c2", path: "b.ts", status: "open", role: "user", intent: "question", body: "why?" }),
    ],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", summaryMd: "s.md", sessionDir: "d" });
  assert.deepEqual(r.approvedFiles, ["b.ts"]); // a.ts has an open change request; b.ts only a question
});
