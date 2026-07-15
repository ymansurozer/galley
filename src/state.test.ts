import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  anchorTextFor,
  buildReviewResult,
  computeApprovedFiles,
  deskLockPath,
  findLiveDesks,
  globalSettingsPath,
  mergeReviewerSave,
  mergeReviewState,
  reanchorComments,
  readGlobalSettings,
  resolveMovedFrom,
  resolveSkim,
  reviewDir,
  sanitizeSession,
  stablePort,
  writeGlobalSettings,
} from "./state.js";
import { changeBlocks, changeStableKeyFromBlock, parseUnifiedDiff } from "./git.js";
import type { ChangeState, Decision, Guide, ReviewComment, ReviewState } from "./types.js";

function file(path: string, contentHash = "FH") {
  return {
    path,
    hunks: [],
    oldFile: { name: path, contents: "" },
    newFile: { name: path, contents: "" },
    contentHash,
  };
}
function change(over: Partial<ChangeState> & { id: string; path: string }): ChangeState {
  return { hunkIndex: 0, side: "additions", lineNumber: 1, title: "", status: "pending", ...over };
}
function comment(over: Partial<ReviewComment> & { id: string; path: string }): ReviewComment {
  return {
    side: "additions",
    lineNumber: 1,
    body: "",
    createdAt: "t",
    updatedAt: "t",
    status: "open",
    ...over,
  };
}
function decision(over: Partial<Decision> & { key: string; path: string }): Decision {
  return { status: "accepted", lineNumber: 1, side: "additions", title: "", ...over };
}
function state(over: Partial<ReviewState>): ReviewState {
  return {
    id: "id",
    session: "s",
    root: "/r",
    repoHash: "h",
    mode: "repo",
    staged: false,
    head: null,
    baseDiffHash: "base",
    createdAt: "t",
    rawDiff: "",
    files: [],
    comments: [],
    changes: [],
    reviewedFiles: [],
    stagedFiles: [],
    ...over,
  };
}

test("mergeReviewState carries a prior decision when content is unchanged", () => {
  const base = state({
    baseDiffHash: "new",
    files: [file("a.ts")],
    changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "H" })],
  });
  const saved = state({
    changes: [
      change({
        id: "a.ts:k1",
        path: "a.ts",
        stableKey: "k1",
        status: "accepted",
        reviewedHash: "H",
      }),
    ],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "accepted");
  assert.equal(merged.changes[0]!.reviewedHash, "H");
  assert.equal(merged.baseDiffHash, "new"); // adopts the fresh diff hash
});

test("mergeReviewerSave replaces only the reviewer-owned fields, leaving server state intact", () => {
  const live = state({
    rawDiff: "SERVER DIFF",
    files: [file("a.ts")],
    changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1" })],
    baseDiffHash: "server-hash",
  });
  mergeReviewerSave(live, {
    decisions: [
      {
        key: "a.ts:k1",
        status: "accepted",
        path: "a.ts",
        lineNumber: 1,
        side: "additions",
        title: "t",
      },
    ],
    comments: [comment({ id: "c1", path: "a.ts" })],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "FH" },
    decisionFiles: ["a.ts"],
  });
  assert.deepEqual(live.reviewedFiles, ["a.ts"]);
  assert.deepEqual(live.reviewedFileHashes, { "a.ts": "FH" });
  assert.deepEqual(live.decisionFiles, ["a.ts"]);
  assert.equal(live.decisions![0]!.status, "accepted");
  assert.equal(live.comments[0]!.id, "c1");
  // Server-owned fields are untouched — the wire never carries them.
  assert.equal(live.rawDiff, "SERVER DIFF");
  assert.equal(live.baseDiffHash, "server-hash");
  assert.equal(live.changes.length, 1);
});

test("mergeReviewerSave ignores non-reviewer fields from a stale full-state body", () => {
  // A stale open tab may POST the whole old ReviewState; only the slice is adopted.
  const live = state({ rawDiff: "SERVER DIFF", baseDiffHash: "server-hash" });
  mergeReviewerSave(live, {
    reviewedFiles: ["a.ts"],
    rawDiff: "CLIENT-OWNED DIFF SHOULD BE IGNORED",
    baseDiffHash: "client-hash",
    files: [file("evil.ts")],
    id: "spoofed",
  });
  assert.deepEqual(live.reviewedFiles, ["a.ts"]);
  assert.equal(live.rawDiff, "SERVER DIFF");
  assert.equal(live.baseDiffHash, "server-hash");
  assert.equal(live.files.length, 0);
  assert.equal(live.id, "id");
});

test("mergeReviewerSave leaves a field untouched when the body omits it", () => {
  const live = state({ reviewedFiles: ["keep.ts"], comments: [comment({ id: "c0", path: "x" })] });
  mergeReviewerSave(live, { comments: [] }); // only comments present
  assert.deepEqual(live.reviewedFiles, ["keep.ts"]); // omitted → unchanged
  assert.deepEqual(live.comments, []); // present → replaced wholesale
});

test("mergeReviewerSave then mergeReviewState: a slim-saved decision survives a desk restart", () => {
  // Save via the slim wire, persist, reload: the decision must reconcile across restart.
  const saved = state({});
  mergeReviewerSave(saved, {
    decisions: [
      {
        key: "a.ts:k1",
        status: "accepted",
        reviewedHash: "H",
        path: "a.ts",
        lineNumber: 1,
        side: "additions",
        title: "t",
      },
    ],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "FH" },
  });
  const base = state({
    baseDiffHash: "reload",
    files: [file("a.ts", "FH")],
    changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "H" })],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "accepted");
  assert.deepEqual(merged.reviewedFiles, ["a.ts"]);
});

test("mergeReviewState resets a decision to pending when content changed (staleness)", () => {
  const base = state({
    files: [file("a.ts")],
    changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "H" })],
  });
  const saved = state({
    changes: [
      change({
        id: "a.ts:k1",
        path: "a.ts",
        stableKey: "k1",
        status: "accepted",
        reviewedHash: "OLD",
      }),
    ],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "pending");
});

test("mergeReviewState matches a saved decision by stableKey even if the id differs", () => {
  const base = state({
    files: [file("a.ts")],
    changes: [change({ id: "a.ts:NEWID", path: "a.ts", stableKey: "k1", contentHash: "H" })],
  });
  const saved = state({
    changes: [
      change({
        id: "a.ts:OLDID",
        path: "a.ts",
        stableKey: "k1",
        status: "rejected",
        reviewedHash: "H",
      }),
    ],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "rejected");
});

test("mergeReviewState retains comments on present files, keeps absent action comments as stale, drops absent notes", () => {
  const base = state({ files: [file("a.ts")] }); // b.ts is gone from the diff
  const saved = state({
    comments: [
      comment({ id: "c1", path: "a.ts" }),
      comment({ id: "c2", path: "b.ts", intent: "action" }),
      comment({ id: "c3", path: "b.ts", intent: "note" }),
    ],
  });
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
      change({
        id: "a.ts:k1",
        path: "a.ts",
        stableKey: "k1",
        status: "accepted",
        reviewedHash: "SAME",
      }),
      change({
        id: "a.ts:k2",
        path: "a.ts",
        stableKey: "k2",
        status: "accepted",
        reviewedHash: "WAS",
      }),
    ],
  });
  const merged = mergeReviewState(base, live);
  assert.equal(merged.baseDiffHash, "afterEdit");
  assert.equal(merged.changes.find((c) => c.stableKey === "k1")!.status, "accepted"); // unchanged → carried
  assert.equal(merged.changes.find((c) => c.stableKey === "k2")!.status, "pending"); // changed → re-review
  assert.equal(merged.comments.length, 1); // the agent comment survives
  assert.equal(merged.comments[0]!.id, "c1");
});

test("mergeReviewState keeps an explicit decision whose hunk left the diff (accepted→staged)", () => {
  // Accepting stages the hunk, so it disappears from the working-tree diff: the
  // rebuilt base has no change for it, yet the decision must survive.
  const base = state({ files: [file("a.ts")], changes: [] });
  const saved = state({
    files: [file("a.ts")],
    changes: [],
    decisions: [
      decision({
        key: "a.ts:k1",
        path: "a.ts",
        status: "accepted",
        reviewedHash: "H",
        lineNumber: 4,
        title: "1 removed · 5 added",
      }),
    ],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.decisions!.length, 1);
  assert.equal(merged.decisions![0]!.status, "accepted");
});

test("mergeReviewState drops an explicit decision that went stale (content changed, still visible)", () => {
  const base = state({
    files: [file("a.ts")],
    changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "NEW" })],
  });
  const saved = state({
    files: [file("a.ts")],
    changes: [],
    decisions: [
      decision({ key: "a.ts:k1", path: "a.ts", status: "accepted", reviewedHash: "OLD" }),
    ],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "pending"); // stale → re-review
  assert.equal(merged.decisions!.length, 0); // and the decision is removed
});

test("mergeReviewState drops a REJECTED decision whose hunk left the diff (rework honored the rejection)", () => {
  // The agent reworked the rejected block away: keeping the decision would leave an
  // invisible objection that blocks approval forever.
  const base = state({ files: [file("a.ts")], changes: [] });
  const saved = state({
    files: [file("a.ts")],
    changes: [],
    decisions: [
      decision({ key: "a.ts:k1", path: "a.ts", status: "rejected", reviewedHash: "H" }),
      decision({ key: "a.ts:k2", path: "a.ts", status: "accepted", reviewedHash: "H" }),
    ],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.decisions!.length, 1); // accepted-vanished keeps its staged-out semantics
  assert.equal(merged.decisions![0]!.status, "accepted");
});

test("mergeReviewState keeps a rejected decision whose hunk is still present and unchanged", () => {
  const base = state({
    files: [file("a.ts")],
    changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "H" })],
  });
  const saved = state({
    files: [file("a.ts")],
    changes: [],
    decisions: [decision({ key: "a.ts:k1", path: "a.ts", status: "rejected", reviewedHash: "H" })],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.decisions!.length, 1);
  assert.equal(merged.changes[0]!.status, "rejected");
});

test("mergeReviewState migrates a decision + open comment + sign-off across a rename reload (issue 01)", () => {
  // The reload that introduces a rename: base carries the file at its NEW path (with oldPath set);
  // everything the reviewer recorded is still keyed to the OLD path. Migration re-keys them.
  const renamed = {
    path: "new.ts",
    hunks: [],
    oldPath: "old.ts",
    newPath: "new.ts",
    oldFile: { name: "old.ts", contents: "x\n" },
    newFile: { name: "new.ts", contents: "x\n" },
    contentHash: "H",
  };
  const base = state({
    files: [renamed],
    changes: [change({ id: "new.ts:k1", path: "new.ts", stableKey: "k1", contentHash: "H" })],
  });
  const saved = state({
    decisions: [
      decision({ key: "old.ts:k1", path: "old.ts", status: "accepted", reviewedHash: "H" }),
    ],
    comments: [comment({ id: "c1", path: "old.ts", intent: "action", anchorText: "x" })],
    reviewedFiles: ["old.ts"],
    reviewedFileHashes: { "old.ts": "H" },
  });
  const merged = mergeReviewState(base, saved);
  // Decision re-keyed to the new path and carried forward (content unchanged).
  assert.equal(merged.changes[0]!.status, "accepted");
  assert.ok(merged.decisions!.some((d) => d.key === "new.ts:k1" && d.path === "new.ts"));
  // The open change-request comment moved to the new path and stays open (not dropped/stale).
  assert.equal(merged.comments.length, 1);
  assert.equal(merged.comments[0]!.path, "new.ts");
  assert.equal(merged.comments[0]!.status, "open");
  // A pure rename keeps its content hash, so the prior sign-off survives, re-keyed.
  assert.deepEqual(merged.reviewedFiles, ["new.ts"]);
  assert.equal(merged.reviewedFileHashes!["new.ts"], "H");
});

// ── resolveMovedFrom (issue 03) ──────────────────────────────────────────────
// A guide-declared move: a.ts (a full working-tree deletion) + b.ts (an untracked addition,
// edited so content differs) → one rename-changed entry at b.ts.
function movedFromFixture(): ReviewState {
  return state({
    mode: "repo",
    staged: false,
    files: [
      {
        path: "a.ts",
        hunks: [{ header: "", oldStart: 1, oldCount: 1, newStart: 0, newCount: 0, lines: [] }],
        oldPath: "a.ts",
        newPath: undefined, // full deletion: +++ /dev/null
        oldFile: { name: "a.ts", contents: "l1\nl2\nl3\n" },
        newFile: { name: "a.ts", contents: "" },
        contentHash: "DEL",
      },
      {
        path: "b.ts",
        hunks: [],
        oldPath: "b.ts",
        newPath: "b.ts", // untracked addition: no old side
        oldFile: { name: "b.ts", contents: "" },
        newFile: { name: "b.ts", contents: "l1\nEDITED\nl3\n" },
        contentHash: "ADD",
      },
    ],
    changes: [change({ id: "a.ts:d1", path: "a.ts", stableKey: "d1", side: "deletions" })],
  });
}
const movedGuide = (movedFrom = "a.ts"): Guide => ({
  overview: "o",
  files: [{ path: "b.ts", order: 0, category: "c", orientation: "moved+edited", movedFrom }],
});

test("resolveMovedFrom merges a declared move into one rename-changed entry (issue 03)", () => {
  const base = movedFromFixture();
  const r = resolveMovedFrom(base, movedGuide(), { strict: true });
  assert.ok(r.ok);
  assert.equal(base.files.length, 1);
  const m = base.files[0]!;
  assert.equal(m.path, "b.ts");
  assert.equal(m.oldPath, "a.ts");
  assert.equal(m.newPath, "b.ts");
  assert.equal(m.oldFile.contents, "l1\nl2\nl3\n"); // deletion's index side
  assert.equal(m.newFile.contents, "l1\nEDITED\nl3\n"); // untracked working side
  assert.equal(base.changes.length, 0); // the deletion's blocks are gone (UI derives new ones)
});

test("resolveMovedFrom: strict aborts when the move doesn't resolve; lenient drops it", () => {
  const strict = movedFromFixture();
  const bad = resolveMovedFrom(strict, movedGuide("nope.ts"), { strict: true });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /movedFrom "nope\.ts" did not resolve/);
  assert.equal(strict.files.length, 2); // untouched on abort

  const lenient = movedFromFixture();
  const dropped = resolveMovedFrom(lenient, movedGuide("nope.ts"), { strict: false });
  assert.ok(dropped.ok); // no error…
  assert.equal(lenient.files.length, 2); // …and the pair falls back to delete + add
});

test("resolveMovedFrom: movedFrom outside working repo mode is a strict error", () => {
  for (const over of [{ mode: "pr" as const }, { staged: true }, { mode: "file" as const }]) {
    const base = { ...movedFromFixture(), ...over };
    const r = resolveMovedFrom(base, movedGuide(), { strict: true });
    assert.equal(r.ok, false, JSON.stringify(over));
    if (!r.ok) assert.match(r.reason, /working repo mode/);
  }
});

test("mergeReviewState migrates a comment + staged-hunk key across a working-mode move pairing (issue 02)", () => {
  // A plain mv paired into a rename-pure entry on reload: the file arrives at new.txt with no change
  // blocks, and everything the reviewer left against old.txt migrates to new.txt (issue 01's path).
  const paired = {
    path: "new.txt",
    hunks: [],
    oldPath: "old.txt",
    newPath: "new.txt",
    oldFile: { name: "old.txt", contents: "x\n" },
    newFile: { name: "new.txt", contents: "x\n" },
    contentHash: "H",
  };
  const base = state({ files: [paired], changes: [] });
  const saved = state({
    comments: [comment({ id: "c1", path: "old.txt", intent: "action", anchorText: "x" })],
    stagedChangeKeys: ["old.txt:additions:1:0:1"],
  });
  const merged = mergeReviewState(base, saved);
  assert.equal(merged.comments.length, 1);
  assert.equal(merged.comments[0]!.path, "new.txt");
  assert.equal(merged.comments[0]!.status, "open");
  assert.deepEqual(merged.stagedChangeKeys, ["new.txt:additions:1:0:1"]);
});

// ── Re-anchoring ─────────────────────────────────────────────────────────────

function contentsFile(path: string, newContents: string, oldContents = newContents) {
  return {
    path,
    hunks: [],
    oldFile: { name: path, contents: oldContents },
    newFile: { name: path, contents: newContents },
    contentHash: "H",
  };
}

test("anchorTextFor reads the line from the right side's contents", () => {
  const files = [contentsFile("a.ts", "n1\nn2\nn3", "o1\no2")];
  assert.equal(anchorTextFor(files, "a.ts", "additions", 2), "n2");
  assert.equal(anchorTextFor(files, "a.ts", "deletions", 2), "o2");
  assert.equal(anchorTextFor(files, "a.ts", "additions", 9), undefined);
  assert.equal(anchorTextFor(files, "b.ts", "additions", 1), undefined);
});

test("reanchorComments keeps a comment whose line still matches its anchor text", () => {
  const files = [contentsFile("a.ts", "alpha\nbeta\ngamma")];
  const c = comment({ id: "c1", path: "a.ts", lineNumber: 2, anchorText: "beta" });
  reanchorComments([c], files);
  assert.equal(c.lineNumber, 2);
  assert.equal(c.unanchored, false);
});

test("reanchorComments moves a comment to the unique nearest matching line (endLine shifts too)", () => {
  // Two lines inserted above: "beta" moved from 2 to 4.
  const files = [contentsFile("a.ts", "x\nalpha\ny\nbeta\ngamma")];
  const c = comment({ id: "c1", path: "a.ts", lineNumber: 2, endLine: 3, anchorText: "beta" });
  reanchorComments([c], files);
  assert.equal(c.lineNumber, 4);
  assert.equal(c.endLine, 5);
  assert.equal(c.unanchored, false);
});

test("reanchorComments flags an ambiguous or vanished anchor as unanchored", () => {
  const files = [contentsFile("a.ts", "dup\nmid\ndup\nend")];
  const tie = comment({ id: "c1", path: "a.ts", lineNumber: 2, anchorText: "dup" }); // 1 and 3 equidistant
  const gone = comment({ id: "c2", path: "a.ts", lineNumber: 2, anchorText: "deleted line" });
  reanchorComments([tie, gone], files);
  assert.equal(tie.unanchored, true);
  assert.equal(tie.lineNumber, 2); // left where it was
  assert.equal(gone.unanchored, true);
});

test("reanchorComments best-effort re-anchors a lightly-edited line to the nearest similar one", () => {
  // The anchored line "const total = a + b;" was tweaked to "...a + b + c;" — same line, edited,
  // so its exact text is gone. It should stay put (near its old spot), not fall to the strip.
  const files = [
    contentsFile("a.ts", "function sum() {\n  const total = a + b + c;\n  return total;\n}"),
  ];
  const c = comment({
    id: "c1",
    path: "a.ts",
    lineNumber: 2,
    anchorText: "  const total = a + b;",
  });
  reanchorComments([c], files);
  assert.equal(c.unanchored, false);
  assert.equal(c.lineNumber, 2);
});

test("reanchorComments leaves a comment unanchored when no surviving line is similar", () => {
  const files = [contentsFile("a.ts", "wholly\ndifferent\ncontent\nhere")];
  const c = comment({ id: "c1", path: "a.ts", lineNumber: 2, anchorText: "const total = a + b;" });
  reanchorComments([c], files);
  assert.equal(c.unanchored, true);
});

test("reanchorComments skips resolved comments and flags legacy ones only when out of range", () => {
  const files = [contentsFile("a.ts", "one\ntwo")];
  const resolved = comment({
    id: "c1",
    path: "a.ts",
    lineNumber: 9,
    status: "resolved",
    anchorText: "gone",
  });
  const legacyIn = comment({ id: "c2", path: "a.ts", lineNumber: 2 }); // no anchorText
  const legacyOut = comment({ id: "c3", path: "a.ts", lineNumber: 7 });
  reanchorComments([resolved, legacyIn, legacyOut], files);
  assert.equal(resolved.unanchored, undefined); // untouched
  assert.equal(legacyIn.unanchored, false);
  assert.equal(legacyOut.unanchored, true);
});

test("buildReviewResult reads decisions, so a staged-out accepted hunk still appears in accepted[]", () => {
  const s = state({
    mode: "repo",
    changes: [], // the accepted hunk is gone from the working diff (staged)
    decisions: [
      decision({
        key: "a.ts:k1",
        path: "a.ts",
        status: "accepted",
        lineNumber: 4,
        side: "additions",
        title: "1 removed · 5 added",
      }),
    ],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0]!.path, "a.ts");
  assert.equal(r.accepted[0]!.lineNumber, 4);
});

test("buildReviewResult excludes questions from requestedChanges, keeps an action on the same line", () => {
  const s = state({
    comments: [
      comment({
        id: "q",
        path: "a.ts",
        lineNumber: 4,
        body: "why is this here?",
        intent: "question",
      }),
      comment({ id: "a", path: "a.ts", lineNumber: 4, body: "rename this", intent: "action" }),
    ],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.equal(r.requestedChanges.length, 1);
  assert.equal(r.requestedChanges[0]!.body, "rename this");
});

test("buildReviewResult.openQuestions lists unanswered questions and drops answered ones", () => {
  const s = state({
    session: "sess",
    mode: "repo",
    comments: [
      comment({
        id: "open",
        path: "a.ts",
        lineNumber: 4,
        body: "why here?",
        intent: "question",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      // Answered: a later agent reply lands in the same thread (same path/side/line).
      comment({
        id: "answered",
        path: "a.ts",
        lineNumber: 7,
        body: "and this?",
        intent: "question",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
      }),
      comment({
        id: "reply",
        path: "a.ts",
        lineNumber: 7,
        body: "because X",
        intent: "note",
        role: "agent",
        createdAt: "2026-01-01T00:01:00Z",
      }),
    ],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.equal(r.openQuestions.length, 1);
  assert.equal(r.openQuestions[0]!.body, "why here?");
  assert.equal(r.openQuestions[0]!.lineNumber, 4);
  // Same shape as an await question — mode/session threaded through.
  assert.equal(r.openQuestions[0]!.mode, "repo");
  assert.equal(r.openQuestions[0]!.session, "sess");
});

test("buildReviewResult carries mode/target/base", () => {
  const s = state({ mode: "pr", target: "feature-x", base: "abc123" });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.equal(r.mode, "pr");
  assert.equal(r.target, "feature-x");
  assert.equal(r.base, "abc123");
});

test("global settings: write→read round-trip; missing and corrupt files read as {}", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "galley-settings-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.deepEqual(await readGlobalSettings(), {}); // no file yet
    await writeGlobalSettings({ settings: { theme: "pierre-dark" }, diffStyle: "unified" });
    assert.deepEqual(await readGlobalSettings(), {
      settings: { theme: "pierre-dark" },
      diffStyle: "unified",
    });
    await fs.writeFile(globalSettingsPath(), "{not json", "utf8");
    assert.deepEqual(await readGlobalSettings(), {}); // corrupt → defaults
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("findLiveDesks sweeps locks whose pid is dead and keeps live ones", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "galley-locks-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const root = "/work/lock-sweep-repo";
  const writeLock = async (session: string, pid: number) =>
    fs.writeFile(
      deskLockPath(await reviewDir(root, session)),
      JSON.stringify({ pid, url: "http://127.0.0.1:1/", session, startedAt: "t" }) + "\n",
      "utf8",
    );
  try {
    // Our own pid is definitely alive; a crashed desk's pid is definitely dead.
    await writeLock("alive", process.pid);
    await writeLock("crashed", 2 ** 22 - 1); // beyond real pid ranges → kill(pid,0) throws
    const live = await findLiveDesks(root);
    assert.deepEqual(
      live.map((l) => l.session),
      ["alive"],
    );
    const staleLock = deskLockPath(await reviewDir(root, "crashed"));
    assert.equal(
      await fs.stat(staleLock).then(
        () => true,
        () => false,
      ),
      false,
      "stale lock swept",
    );
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("stablePort is deterministic per repo+session and stays in range", () => {
  const a = stablePort("/work/repo", "main");
  assert.equal(a, stablePort("/work/repo", "main")); // deterministic
  assert.ok(a >= 41000 && a < 51000);
  assert.notEqual(a, stablePort("/work/repo", "feature-x")); // session-sensitive
  assert.notEqual(a, stablePort("/other/repo", "main")); // repo-sensitive
  // The raw session name and its sanitized form land on the same port (deskSession sanitizes).
  assert.equal(stablePort("/work/repo", "feature/x"), stablePort("/work/repo", "feature-x"));
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
  const saved = state({
    files: [file("a.ts", "H")],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "H" },
  });
  const merged = mergeReviewState(base, saved);
  assert.deepEqual(merged.reviewedFiles, ["a.ts"]);
  assert.equal(merged.reviewedFileHashes!["a.ts"], "H");
});

test("mergeReviewState drops a finished file when its content hash changed (re-review)", () => {
  const base = state({ files: [file("a.ts", "NEW")] });
  const saved = state({
    files: [file("a.ts", "OLD")],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "OLD" },
  });
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
  const s = state({
    files: [file("a.ts", "H")],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "H" },
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(r.approvedFiles, ["a.ts"]);
});

test("buildReviewResult.approvedFiles excludes a signed-off file with a rejected hunk", () => {
  const s = state({
    files: [file("a.ts", "H")],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "H" },
    decisions: [decision({ key: "a.ts:k1", path: "a.ts", status: "rejected" })],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(r.approvedFiles, []);
});

test("buildReviewResult.approvedFiles excludes a signed-off file with an open action comment, keeps one with only a question", () => {
  const s = state({
    files: [file("a.ts", "H"), file("b.ts", "H")],
    reviewedFiles: ["a.ts", "b.ts"],
    reviewedFileHashes: { "a.ts": "H", "b.ts": "H" },
    comments: [
      comment({
        id: "c1",
        path: "a.ts",
        status: "open",
        role: "user",
        intent: "action",
        body: "fix",
      }),
      comment({
        id: "c2",
        path: "b.ts",
        status: "open",
        role: "user",
        intent: "question",
        body: "why?",
      }),
    ],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(r.approvedFiles, ["b.ts"]); // a.ts has an open change request; b.ts only a question
});

// ── resolveSkim: guide skimBlocks → ChangeState.skim stamping ────────────────
// A diff with two blocks: an imports run (new lines 3-5) and a core() rewrite (new lines 8-9).
const SKIM_DIFF = `diff --git a/app.ts b/app.ts
index fb29c7d..ac6feef 100644
--- a/app.ts
+++ b/app.ts
@@ -1,8 +1,12 @@
 import { a } from "./a";
 import { b } from "./b";
+import { c } from "./c";
+import { d } from "./d";
+import { e } from "./e";
 
 export function core() {
-  return a() + b();
+  const total = a() + b() + c();
+  return total * 2;
 }
 
 export function untouched() {
`;
// The same file after an agent edit: the imports are now unchanged context; only core() changed.
// The old skim span 3-5 no longer lands on any change block.
const SKIM_DIFF_REWRITTEN = `diff --git a/app.ts b/app.ts
index ac6feef..bbbbbbb 100644
--- a/app.ts
+++ b/app.ts
@@ -1,12 +1,12 @@
 import { a } from "./a";
 import { b } from "./b";
 import { c } from "./c";
 import { d } from "./d";
 import { e } from "./e";
 
 export function core() {
-  const total = a() + b() + c();
+  const total = a() + b() + c() + d();
   return total * 2;
 }
 
 export function untouched() {
`;

// Build ChangeState[] from a raw diff exactly as assembleDiff does, so stableKeys line up
// with what resolveSkim derives.
function changesFromDiff(rawDiff: string): ChangeState[] {
  const out: ChangeState[] = [];
  for (const f of parseUnifiedDiff(rawDiff)) {
    const p = f.newPath ?? f.oldPath ?? "unknown";
    f.hunks.forEach((h, hunkIndex) => {
      changeBlocks(h).forEach((block) => {
        const firstAdd = block.find((l) => l.kind === "add");
        const firstDelete = block.find((l) => l.kind === "delete");
        const side = firstAdd ? "additions" : ("deletions" as const);
        const lineNumber = firstAdd?.newLine ?? firstDelete?.oldLine ?? h.newStart;
        const stableKey = changeStableKeyFromBlock(block);
        out.push(
          change({ id: `${p}:${stableKey}`, path: p, hunkIndex, side, lineNumber, stableKey }),
        );
      });
    });
  }
  return out;
}

function guideWith(
  skimBlocks: Array<{ lines: [number, number]; reason?: string }>,
  path = "app.ts",
): Guide {
  return {
    overview: "o",
    files: [{ path, order: 0, category: "Changes", orientation: "s", skimBlocks }],
  };
}

test("resolveSkim stamps the change block a span resolves to", () => {
  const changes = changesFromDiff(SKIM_DIFF);
  const r = resolveSkim(SKIM_DIFF, changes, guideWith([{ lines: [3, 5], reason: "imports" }]), {
    strict: true,
  });
  assert.ok(r.ok);
  const imports = changes.find((c) => c.stableKey === "additions:3:0:3");
  const core = changes.find((c) => c.stableKey === "additions:8:1:2");
  assert.deepEqual(imports!.skim, { reason: "imports" });
  assert.equal(core!.skim, undefined); // only the targeted block is stamped
});

test("resolveSkim (strict) rejects a span that matches no change block, naming path + span", () => {
  const r = resolveSkim(SKIM_DIFF, changesFromDiff(SKIM_DIFF), guideWith([{ lines: [100, 101] }]), {
    strict: true,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /app\.ts/);
  assert.match(r.reason, /100/);
});

test("resolveSkim (strict) rejects a skimBlocks entry on a file absent from the diff", () => {
  const r = resolveSkim(
    SKIM_DIFF,
    changesFromDiff(SKIM_DIFF),
    guideWith([{ lines: [1, 2] }], "ghost.ts"),
    {
      strict: true,
    },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /ghost\.ts/);
});

test("resolveSkim (lenient) drops an unresolvable span instead of failing", () => {
  const changes = changesFromDiff(SKIM_DIFF);
  const r = resolveSkim(
    SKIM_DIFF,
    changes,
    guideWith([{ lines: [3, 5], reason: "imports" }, { lines: [100, 101] }]),
    { strict: false },
  );
  assert.ok(r.ok); // the [100,101] span silently drops
  assert.deepEqual(changes.find((c) => c.stableKey === "additions:3:0:3")!.skim, {
    reason: "imports",
  });
});

test("resolveSkim drops a stale skim after the block is rewritten (reload asymmetry)", () => {
  const guide = guideWith([{ lines: [3, 5], reason: "imports" }]);
  // Rewritten diff: the old span no longer resolves. Lenient reload drops it (no throw)...
  const changes = changesFromDiff(SKIM_DIFF_REWRITTEN);
  const lenient = resolveSkim(SKIM_DIFF_REWRITTEN, changes, guide, { strict: false });
  assert.ok(lenient.ok);
  assert.ok(changes.every((c) => c.skim === undefined)); // no block skimmed; core renders pending
  // ...but a NEW guide with that span would be rejected outright.
  assert.equal(
    resolveSkim(SKIM_DIFF_REWRITTEN, changesFromDiff(SKIM_DIFF_REWRITTEN), guide, { strict: true })
      .ok,
    false,
  );
});

test("resolveSkim clears prior stamps so re-resolution is idempotent", () => {
  const changes = changesFromDiff(SKIM_DIFF);
  resolveSkim(SKIM_DIFF, changes, guideWith([{ lines: [3, 5] }]), { strict: true });
  assert.ok(changes.find((c) => c.stableKey === "additions:3:0:3")!.skim);
  // Re-resolve with a guide targeting the OTHER block: the first stamp must be cleared.
  resolveSkim(SKIM_DIFF, changes, guideWith([{ lines: [8, 9] }]), { strict: true });
  assert.equal(changes.find((c) => c.stableKey === "additions:3:0:3")!.skim, undefined);
  assert.ok(changes.find((c) => c.stableKey === "additions:8:1:2")!.skim);
});

test("skim never changes approval derivations (display-only)", () => {
  // A skimmed block accepted like any other: it lands in accepted[] and the file approves.
  const s = state({
    files: [file("a.ts", "H")],
    changes: [
      change({
        id: "a.ts:k",
        path: "a.ts",
        stableKey: "k",
        status: "accepted",
        skim: { reason: "imports" },
      }),
    ],
    decisions: [decision({ key: "a.ts:k", path: "a.ts", status: "accepted" })],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "H" },
  });
  assert.deepEqual(computeApprovedFiles(s), ["a.ts"]);
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.equal(r.accepted.length, 1);
  assert.deepEqual(r.approvedFiles, ["a.ts"]);
});

test("the reviewer save slice never carries skim (changes are server-owned)", () => {
  const s = state({ changes: [change({ id: "a.ts:k", path: "a.ts", stableKey: "k" })] });
  // A stale tab POSTs a whole ReviewState, changes included; mergeReviewerSave must ignore them.
  mergeReviewerSave(s, {
    changes: [{ id: "a.ts:k", path: "a.ts", stableKey: "k", skim: { reason: "x" } }],
    comments: [],
  });
  assert.equal(s.changes[0]!.skim, undefined); // changes (hence skim) are not a reviewer-save key
  assert.deepEqual(s.comments, []); // comments ARE reviewer-owned, so they applied
});
