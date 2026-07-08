import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  anchorTextFor,
  buildReviewResult,
  globalSettingsPath,
  mergeReviewerSave,
  mergeReviewState,
  reanchorComments,
  readGlobalSettings,
  sanitizeSession,
  stablePort,
  writeGlobalSettings,
} from "./state.js";
import type { ChangeState, Decision, ReviewComment, ReviewState } from "./types.js";

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
