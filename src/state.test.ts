import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  anchorTextFor,
  appendAnnotationReply,
  baseDiffHashOf,
  buildDiffSource,
  buildReviewResult,
  buildReviewState,
  carryGuideStamps,
  computeApprovedFiles,
  deskLockPath,
  findLiveDesks,
  globalSettingsPath,
  hash,
  loadLatestReview,
  mergeReviewerSave,
  mergeReviewState,
  parsedDiffOf,
  persistReview,
  reanchorComments,
  readFileContents,
  readGlobalSettings,
  resolveMovedFrom,
  resolveGuide,
  resolveParts,
  resolveSkim,
  reviewDir,
  sanitizeSession,
  stablePort,
  stableUiPort,
  writeFileAtomic,
  writeGlobalSettings,
} from "./state.js";
import { changeBlocks, changeStableKeyFromBlock, gitStats, parseUnifiedDiff } from "./git.js";
import type {
  ChangeState,
  Decision,
  Guide,
  ReviewComment,
  ReviewFile,
  ReviewState,
  UiAnnotationRecord,
  UiElement,
} from "./types.js";

function file(path: string, contentHash = "FH") {
  return { path, hunks: [], contentHash, changeKind: "modified" as const };
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

test("mergeReviewState carries a prior decision when content is unchanged", async () => {
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
  const merged = await mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "accepted");
  assert.equal(merged.changes[0]!.reviewedHash, "H");
  assert.equal(merged.baseDiffHash, "new"); // adopts the fresh diff hash
});

test("mergeReviewerSave replaces only the reviewer-owned fields, leaving server state intact", async () => {
  const live = state({
    rawDiff: "SERVER DIFF",
    files: [file("a.ts")],
    changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1" })],
    baseDiffHash: "server-hash",
  });
  await mergeReviewerSave(live, {
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

test("mergeReviewerSave ignores non-reviewer fields from a stale full-state body", async () => {
  // A stale open tab may POST the whole old ReviewState; only the slice is adopted.
  const live = state({ rawDiff: "SERVER DIFF", baseDiffHash: "server-hash" });
  await mergeReviewerSave(live, {
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

test("mergeReviewerSave leaves a field untouched when the body omits it", async () => {
  const live = state({ reviewedFiles: ["keep.ts"], comments: [comment({ id: "c0", path: "x" })] });
  await mergeReviewerSave(live, { comments: [] }); // only comments present
  assert.deepEqual(live.reviewedFiles, ["keep.ts"]); // omitted → unchanged
  assert.deepEqual(live.comments, []); // present → replaced wholesale
});

test("mergeReviewerSave then mergeReviewState: a slim-saved decision survives a desk restart", async () => {
  // Save via the slim wire, persist, reload: the decision must reconcile across restart.
  const saved = state({});
  await mergeReviewerSave(saved, {
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
  const merged = await mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "accepted");
  assert.deepEqual(merged.reviewedFiles, ["a.ts"]);
});

test("mergeReviewState resets a decision to pending when content changed (staleness)", async () => {
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
  const merged = await mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "pending");
});

test("mergeReviewState matches a saved decision by stableKey even if the id differs", async () => {
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
  const merged = await mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "rejected");
});

test("mergeReviewState retains comments on present files, keeps absent action comments as stale, drops absent notes", async () => {
  const base = state({ files: [file("a.ts")] }); // b.ts is gone from the diff
  const saved = state({
    comments: [
      comment({ id: "c1", path: "a.ts" }),
      comment({ id: "c2", path: "b.ts", intent: "action" }),
      comment({ id: "c3", path: "b.ts", intent: "note" }),
    ],
  });
  const merged = await mergeReviewState(base, saved);
  const ids = merged.comments.map((c) => c.id).sort();
  assert.deepEqual(ids, ["c1", "c2"]);
  assert.equal(merged.comments.find((c) => c.id === "c1")!.status, "open");
  assert.equal(merged.comments.find((c) => c.id === "c2")!.status, "stale");
});

test("mergeReviewState (reload shape): folds a fresh diff into a live state — carry, stale, comments, hash", async () => {
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
  const merged = await mergeReviewState(base, live);
  assert.equal(merged.baseDiffHash, "afterEdit");
  assert.equal(merged.changes.find((c) => c.stableKey === "k1")!.status, "accepted"); // unchanged → carried
  assert.equal(merged.changes.find((c) => c.stableKey === "k2")!.status, "pending"); // changed → re-review
  assert.equal(merged.comments.length, 1); // the agent comment survives
  assert.equal(merged.comments[0]!.id, "c1");
});

test("mergeReviewState keeps an explicit decision whose hunk left the diff (accepted→staged)", async () => {
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
  const merged = await mergeReviewState(base, saved);
  assert.equal(merged.decisions!.length, 1);
  assert.equal(merged.decisions![0]!.status, "accepted");
});

test("mergeReviewState drops an explicit decision that went stale (content changed, still visible)", async () => {
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
  const merged = await mergeReviewState(base, saved);
  assert.equal(merged.changes[0]!.status, "pending"); // stale → re-review
  assert.equal(merged.decisions!.length, 0); // and the decision is removed
});

test("mergeReviewState drops a REJECTED decision whose hunk left the diff (rework honored the rejection)", async () => {
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
  const merged = await mergeReviewState(base, saved);
  assert.equal(merged.decisions!.length, 1); // accepted-vanished keeps its staged-out semantics
  assert.equal(merged.decisions![0]!.status, "accepted");
});

test("mergeReviewState keeps a rejected decision whose hunk is still present and unchanged", async () => {
  const base = state({
    files: [file("a.ts")],
    changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "H" })],
  });
  const saved = state({
    files: [file("a.ts")],
    changes: [],
    decisions: [decision({ key: "a.ts:k1", path: "a.ts", status: "rejected", reviewedHash: "H" })],
  });
  const merged = await mergeReviewState(base, saved);
  assert.equal(merged.decisions!.length, 1);
  assert.equal(merged.changes[0]!.status, "rejected");
});

test("mergeReviewState migrates a decision + open comment + sign-off across a rename reload (issue 01)", async () => {
  // The reload that introduces a rename: base carries the file at its NEW path (with oldPath set);
  // everything the reviewer recorded is still keyed to the OLD path. Migration re-keys them.
  const renamed = {
    path: "new.ts",
    hunks: [],
    oldPath: "old.ts",
    newPath: "new.ts",
    contentHash: "H",
    changeKind: "renamed" as const,
    renamePure: true,
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
    signedOffBlocks: { "old.ts:k1": "H" },
  });
  const merged = await mergeReviewState(base, saved);
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
  assert.deepEqual(merged.signedOffBlocks, { "new.ts:k1": "H" });
});

// ── Decisions across line shifts ─────────────────────────────────────────────
// A block's key embeds its first line, so an edit above it re-keys it. These run the reload path
// over a real repo: app.ts holds l1..l14 committed, and each test writes the working tree.
const committedLines = Array.from({ length: 14 }, (_, i) => `l${i + 1}`);
async function withShiftRepo(
  run: (
    edit: (lines: string[]) => Promise<ReviewState>,
    stage: (lines: string[]) => Promise<void>,
  ) => Promise<void>,
) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "galley-shift-")));
  const gitq = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  try {
    gitq("init", "-q");
    gitq("config", "user.email", "t@t.dev");
    gitq("config", "user.name", "t");
    await fs.writeFile(path.join(dir, "app.ts"), committedLines.join("\n") + "\n");
    gitq("add", "-A");
    gitq("commit", "-q", "-m", "init");
    const write = (lines: string[]) =>
      fs.writeFile(path.join(dir, "app.ts"), lines.join("\n") + "\n");
    await run(
      // Write the working tree and build the desk on it, as `galley reload` rebuilds.
      async (lines) => {
        await write(lines);
        return (await buildReviewState(dir, { session: "s" }))!;
      },
      // Put `lines` in the index, as accepting a block stages it out of the working-tree diff.
      async (lines) => {
        await write(lines);
        gitq("add", "app.ts");
      },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
// The committed lines with `edits` (1-based line → new text) applied.
const edited = (edits: Record<number, string>) =>
  committedLines.map((line, i) => edits[i + 1] ?? line);
// Two lines inserted after l1: everything below moves down by two.
const insertAbove = (lines: string[]) => [lines[0]!, "n1", "n2", ...lines.slice(1)];
// The decision the tab records on a block (decisions-derive.ts recordDecision).
const decide = (st: ReviewState, key: string, status: Decision["status"]): Decision => {
  const c = st.changes.find((ch) => `${ch.path}:${ch.stableKey}` === key);
  assert.ok(c, `block ${key} is in the diff`);
  return decision({
    key,
    path: c.path,
    status,
    reviewedHash: c.contentHash,
    lineNumber: c.lineNumber,
  });
};
const statusOf = (st: ReviewState, key: string) =>
  st.changes.find((c) => `${c.path}:${c.stableKey}` === key)?.status;
const decided = (st: ReviewState) =>
  (st.decisions ?? []).map((d) => [d.key, d.status, d.lineNumber]).sort();
// The same line added after l3 and after l8: two blocks with identical content.
const twinLines = () => {
  const lines = [...committedLines.slice(0, 3), "x", ...committedLines.slice(3, 8), "x"];
  return [...lines, ...committedLines.slice(8)];
};
// The sign-off entry the tab writes on a block (decisions-derive.ts signOffStep).
const signedOff = (st: ReviewState, ...keys: string[]) =>
  Object.fromEntries(
    keys.map((key) => {
      const c = st.changes.find((ch) => `${ch.path}:${ch.stableKey}` === key);
      assert.ok(c?.contentHash, `block ${key} is in the diff`);
      return [key, c.contentHash];
    }),
  );
// Every block of the diff signed off, and the file with them, as approving every part leaves it.
const allSignedOff = (st: ReviewState): ReviewState => ({
  ...st,
  signedOffBlocks: signedOff(st, ...st.changes.map((c) => `${c.path}:${c.stableKey}`)),
  reviewedFiles: ["app.ts"],
  reviewedFileHashes: { "app.ts": st.files[0]!.contentHash },
});
// app.ts split by a guide, its blocks stamped by hand as the guide's spans would have stamped
// them: `parts` maps a block's first line to its part.
const stampParts = (st: ReviewState, parts: Record<number, number>) => {
  for (const c of st.changes) {
    const part = parts[c.lineNumber];
    if (part !== undefined) c.part = part;
  }
  const count = Math.max(...Object.values(parts)) + 1;
  st.guide = {
    overview: "o",
    files: Array.from({ length: count }, (_, i) => ({
      path: "app.ts",
      order: i,
      category: `C${i}`,
      orientation: `Part ${i}`,
      part: { title: `Part ${i}`, lines: [1] },
    })),
  };
  return st;
};
// Each block's part by its first line, "rest" for a block no part claims.
const partsOf = (st: Pick<ReviewState, "changes">) =>
  Object.fromEntries(st.changes.map((c) => [c.lineNumber, c.part ?? "rest"]));

test("an accepted block keeps its decision, under its new key, when lines are inserted above it", async () => {
  await withShiftRepo(async (edit) => {
    const before = await edit(edited({ 8: "L8" }));
    const saved = { ...before, decisions: [decide(before, "app.ts:additions:8:1:1", "accepted")] };
    const merged = await mergeReviewState(await edit(insertAbove(edited({ 8: "L8" }))), saved);
    assert.equal(statusOf(merged, "app.ts:additions:10:1:1"), "accepted");
    assert.deepEqual(decided(merged), [["app.ts:additions:10:1:1", "accepted", 10]]);
    assert.equal(merged.decisions![0]!.reviewedHash, saved.decisions[0]!.reviewedHash);
  });
});

test("a rejected block keeps its decision, under its new key, when lines are inserted above it", async () => {
  await withShiftRepo(async (edit) => {
    const before = await edit(edited({ 8: "L8" }));
    const saved = { ...before, decisions: [decide(before, "app.ts:additions:8:1:1", "rejected")] };
    const merged = await mergeReviewState(await edit(insertAbove(edited({ 8: "L8" }))), saved);
    assert.equal(statusOf(merged, "app.ts:additions:10:1:1"), "rejected");
    assert.deepEqual(decided(merged), [["app.ts:additions:10:1:1", "rejected", 10]]);
  });
});

test("identical blocks shifted together keep their own decisions, paired in document order", async () => {
  await withShiftRepo(async (edit) => {
    const twins = twinLines();
    const before = await edit(twins);
    const first = before.changes.find((c) => c.stableKey === "additions:4:0:1")!;
    const second = before.changes.find((c) => c.stableKey === "additions:10:0:1")!;
    assert.equal(first.contentHash, second.contentHash, "the two blocks are identical");
    const saved = {
      ...before,
      // Saved second-first, so the pairing can't lean on the array's order.
      decisions: [
        decide(before, "app.ts:additions:10:0:1", "rejected"),
        decide(before, "app.ts:additions:4:0:1", "accepted"),
      ],
    };
    const merged = await mergeReviewState(await edit(insertAbove(twins)), saved);
    assert.equal(statusOf(merged, "app.ts:additions:6:0:1"), "accepted");
    assert.equal(statusOf(merged, "app.ts:additions:12:0:1"), "rejected");
    assert.deepEqual(decided(merged), [
      ["app.ts:additions:12:0:1", "rejected", 12],
      ["app.ts:additions:6:0:1", "accepted", 6],
    ]);
  });
});

test("an undecided twin left in place doesn't take the decision of an accepted twin staged out", async () => {
  await withShiftRepo(async (edit, stage) => {
    const before = await edit(twinLines());
    const accepted = decide(before, "app.ts:additions:4:0:1", "accepted");
    // Stage the first twin only: the working-tree diff keeps the second, at the same line.
    await stage([...committedLines.slice(0, 3), "x", ...committedLines.slice(3)]);
    const merged = await mergeReviewState(await edit(twinLines()), {
      ...before,
      decisions: [accepted],
    });
    assert.deepEqual(
      merged.changes.map((c) => [c.stableKey, c.status]),
      [["additions:10:0:1", "pending"]],
    );
    assert.deepEqual(decided(merged), [["app.ts:additions:4:0:1", "accepted", 4]]);
  });
});

test("an undecided twin left in place doesn't take the decision of a twin rewritten in place", async () => {
  await withShiftRepo(async (edit) => {
    const before = await edit(twinLines());
    const accepted = decide(before, "app.ts:additions:4:0:1", "accepted");
    const rewritten = twinLines();
    rewritten[3] = "y";
    const merged = await mergeReviewState(await edit(rewritten), {
      ...before,
      decisions: [accepted],
    });
    assert.equal(statusOf(merged, "app.ts:additions:4:0:1"), "pending");
    assert.equal(statusOf(merged, "app.ts:additions:10:0:1"), "pending");
    assert.deepEqual(decided(merged), []);
  });
});

test("a block shifted onto another decided block's old key keeps its own decision, and so does the other", async () => {
  await withShiftRepo(async (edit) => {
    // l5 and l7 change; two lines above move the l5 block to line 7, the old key of the l7 block.
    const pair = edited({ 5: "A", 7: "B" });
    const before = await edit(pair);
    const saved = {
      ...before,
      decisions: [
        decide(before, "app.ts:additions:5:1:1", "accepted"),
        decide(before, "app.ts:additions:7:1:1", "rejected"),
      ],
    };
    const merged = await mergeReviewState(await edit(insertAbove(pair)), saved);
    assert.equal(statusOf(merged, "app.ts:additions:7:1:1"), "accepted");
    assert.equal(statusOf(merged, "app.ts:additions:9:1:1"), "rejected");
    assert.deepEqual(decided(merged), [
      ["app.ts:additions:7:1:1", "accepted", 7],
      ["app.ts:additions:9:1:1", "rejected", 9],
    ]);
  });
});

test("a decided block that was shifted and rewritten comes back pending", async () => {
  await withShiftRepo(async (edit) => {
    const before = await edit(edited({ 8: "L8" }));
    const saved = { ...before, decisions: [decide(before, "app.ts:additions:8:1:1", "rejected")] };
    const merged = await mergeReviewState(
      await edit(insertAbove(edited({ 8: "L8 again" }))),
      saved,
    );
    assert.equal(statusOf(merged, "app.ts:additions:10:1:1"), "pending");
    assert.deepEqual(decided(merged), []);
  });
});

test("a block moved elsewhere in its file comes back pending and unsigned, and the file unapproved", async () => {
  await withShiftRepo(async (edit) => {
    // One added line, after l3 and then after l8, beside an unchanged edit at l12.
    const withAudit = (after: number) => {
      const lines = edited({ 12: "L12" });
      lines.splice(after, 0, "audit");
      return lines;
    };
    const before = stampParts(await edit(withAudit(3)), { 4: 0, 13: 1 });
    const saved = {
      ...allSignedOff(before),
      decisions: [
        decide(before, "app.ts:additions:4:0:1", "accepted"),
        decide(before, "app.ts:additions:13:1:1", "accepted"),
      ],
    };
    const merged = await mergeReviewState(await edit(withAudit(8)), saved);
    assert.equal(statusOf(merged, "app.ts:additions:9:0:1"), "pending");
    assert.equal(statusOf(merged, "app.ts:additions:13:1:1"), "accepted");
    assert.deepEqual(Object.keys(merged.signedOffBlocks ?? {}), ["app.ts:additions:13:1:1"]);
    assert.deepEqual(computeApprovedFiles(merged), []);
  });
});

test("a new line identical to an accepted block staged out of the diff comes back pending", async () => {
  await withShiftRepo(async (edit, stage) => {
    const round1 = edited({ 11: "L11" });
    round1.splice(3, 0, "x");
    const s1 = await edit(round1);
    const saved = { ...s1, decisions: [decide(s1, "app.ts:additions:4:0:1", "accepted")] };
    // Accepting the x block staged it: the index takes it, the working tree keeps both edits.
    const staged = [...committedLines];
    staged.splice(3, 0, "x");
    await stage(staged);
    const s2 = await mergeReviewState(await edit(round1), saved);
    assert.deepEqual(decided(s2), [["app.ts:additions:4:0:1", "accepted", 4]]);
    // Rounds later the agent adds the same line after l8.
    const round3 = [...round1];
    round3.splice(9, 0, "x");
    const s3 = await mergeReviewState(await edit(round3), s2);
    assert.equal(statusOf(s3, "app.ts:additions:10:0:1"), "pending");
    assert.deepEqual(decided(s3), [["app.ts:additions:4:0:1", "accepted", 4]]);
  });
});

// The committed lines with two lines added after l2: the top part, which approving stages.
const withTop = (lines: string[]) => [...lines.slice(0, 2), "n1", "n2", ...lines.slice(2)];

test("the parts below a part the desk staged keep their decisions and sign-offs across the agent's next edit", async () => {
  await withShiftRepo(async (edit, stage) => {
    const round1 = withTop(edited({ 10: "C", 12: "D" }));
    const before = stampParts(await edit(round1), { 3: 0, 12: 1, 14: 1 });
    const saved = {
      ...before,
      decisions: [
        decide(before, "app.ts:additions:3:0:2", "accepted"),
        decide(before, "app.ts:additions:12:1:1", "accepted"),
        decide(before, "app.ts:additions:14:1:1", "rejected"),
      ],
      signedOffBlocks: signedOff(
        before,
        "app.ts:additions:3:0:2",
        "app.ts:additions:12:1:1",
        "app.ts:additions:14:1:1",
      ),
      stagedChangeKeys: ["app.ts:additions:3:0:2"],
    };
    // Approving the top part staged it; then the agent adds a line after l6, above the lower part.
    await stage(withTop(committedLines));
    const round2 = [...round1];
    round2.splice(8, 0, "m1");
    const merged = await mergeReviewState(await edit(round2), saved);
    assert.equal(statusOf(merged, "app.ts:additions:13:1:1"), "accepted");
    assert.equal(statusOf(merged, "app.ts:additions:15:1:1"), "rejected");
    assert.deepEqual(Object.keys(merged.signedOffBlocks ?? {}).sort(), [
      "app.ts:additions:13:1:1",
      "app.ts:additions:15:1:1",
    ]);
    assert.deepEqual(partsOf(merged), { 9: "rest", 13: 1, 15: 1 });
  });
});

test("a deletion below a block the desk staged keeps its decision and sign-off, re-keyed by the stage", async () => {
  await withShiftRepo(async (edit, stage) => {
    // l12 deleted: a pure-deletion block keys on its old-side line, which the stage above moves.
    const round1 = withTop(committedLines.filter((l) => l !== "l12"));
    const before = await edit(round1);
    const saved = {
      ...before,
      decisions: [decide(before, "app.ts:deletions:12:1:0", "rejected")],
      signedOffBlocks: signedOff(before, "app.ts:deletions:12:1:0"),
      stagedChangeKeys: ["app.ts:additions:3:0:2"],
    };
    await stage(withTop(committedLines));
    const merged = await mergeReviewState(await edit(round1), saved);
    assert.equal(statusOf(merged, "app.ts:deletions:14:1:0"), "rejected");
    assert.deepEqual(Object.keys(merged.signedOffBlocks ?? {}), ["app.ts:deletions:14:1:0"]);
  });
});

test("a block the agent reverted above another doesn't count as staged", async () => {
  await withShiftRepo(async (edit) => {
    const before = await edit(withTop(edited({ 12: "D" })));
    const saved = { ...before, decisions: [decide(before, "app.ts:additions:14:1:1", "rejected")] };
    // The top block is reverted, not staged: the base is unchanged, and the l12 block moves up.
    const merged = await mergeReviewState(await edit(edited({ 12: "D" })), saved);
    assert.equal(statusOf(merged, "app.ts:additions:12:1:1"), "rejected");
  });
});

test("a new block identical to an accept staged out of the diff, at exactly its key, comes back pending", async () => {
  await withShiftRepo(async (edit, stage) => {
    const round1 = edited({ 11: "L11" });
    round1.splice(3, 0, "x");
    const s1 = await edit(round1);
    const saved = { ...s1, decisions: [decide(s1, "app.ts:additions:4:0:1", "accepted")] };
    const staged = [...committedLines];
    staged.splice(3, 0, "x");
    await stage(staged);
    const s2 = await mergeReviewState(await edit(round1), saved);
    // The agent drops l1 and adds a second x: against the index, a new "+x" at line 4.
    const round3 = round1.slice(1);
    round3.splice(3, 0, "x");
    const s3 = await mergeReviewState(await edit(round3), s2);
    assert.equal(statusOf(s3, "app.ts:additions:4:0:1"), "pending");
    // The staged-out accept is dropped rather than read as the new block's, in the tab and the
    // agent's result alike; the index already holds what it accepted.
    assert.deepEqual(decided(s3), []);
    const result = buildReviewResult(s3, { resultJson: "r.json", sessionDir: "d" });
    assert.deepEqual(result.accepted, []);
  });
});

test("a block below a hunk the user staged by hand keeps its verdicts though its base moved", async () => {
  await withShiftRepo(async (edit, stage) => {
    const round1 = withTop(edited({ 12: "D" }));
    const before = await edit(round1);
    const saved = {
      ...before,
      decisions: [decide(before, "app.ts:additions:14:1:1", "rejected")],
      signedOffBlocks: signedOff(before, "app.ts:additions:14:1:1"),
    };
    // Staged outside the desk, so not in stagedChangeKeys: the l12 block keeps its key and content.
    await stage(withTop(committedLines));
    const merged = await mergeReviewState(await edit(round1), saved);
    assert.equal(statusOf(merged, "app.ts:additions:14:1:1"), "rejected");
    assert.deepEqual(Object.keys(merged.signedOffBlocks ?? {}), ["app.ts:additions:14:1:1"]);
  });
});

test("a save from a tab still on the pre-reload diff lands on the reloaded blocks", async () => {
  await withShiftRepo(async (edit) => {
    // The tab accepts the l8 block and saves; then the agent edits above it and reloads.
    const live = await edit(edited({ 8: "L8", 11: "L11" }));
    const oldDiff = live.baseDiffHash;
    const accepted = decide(live, "app.ts:additions:8:1:1", "accepted");
    const rejected = decide(live, "app.ts:additions:11:1:1", "rejected");
    const seen = (baseDiffHash: string) => ({ token: null, reloadGeneration: 0, baseDiffHash });
    await mergeReviewerSave(live, { decisions: [accepted], seen: seen(oldDiff) });
    // The desk remembers the diff it reloads away from (server.ts, /api/reload).
    const prior = { baseDiffHash: live.baseDiffHash, changes: live.changes, files: live.files };
    Object.assign(
      live,
      await mergeReviewState(await edit(insertAbove(edited({ 8: "L8", 11: "L11" }))), live),
    );
    assert.deepEqual(decided(live), [["app.ts:additions:10:1:1", "accepted", 10]]);
    // Before the tab adopts the reloaded diff, the reviewer rejects the l11 block on the old one.
    await mergeReviewerSave(
      live,
      { decisions: [accepted, rejected], seen: seen(oldDiff) },
      undefined,
      prior,
    );
    assert.deepEqual(decided(live), [
      ["app.ts:additions:10:1:1", "accepted", 10],
      ["app.ts:additions:13:1:1", "rejected", 13],
    ]);
    assert.equal(statusOf(live, "app.ts:additions:10:1:1"), "accepted");
    assert.equal(statusOf(live, "app.ts:additions:13:1:1"), "rejected");
    // A save from further back than the desk remembers can't be placed: the desk keeps its own.
    await mergeReviewerSave(
      live,
      { decisions: [], seen: seen("two diffs back") },
      undefined,
      prior,
    );
    assert.equal(decided(live).length, 2);
    // Once the tab has adopted the reloaded diff, its save is taken as sent.
    const current = live.decisions!.filter((d) => d.status === "accepted");
    await mergeReviewerSave(live, { decisions: current, seen: seen(live.baseDiffHash) });
    assert.deepEqual(decided(live), [["app.ts:additions:10:1:1", "accepted", 10]]);
  });
});

test("a block sign-off survives a reload while its block is there with the content it was signed off on", async () => {
  await withShiftRepo(async (edit) => {
    const before = await edit(edited({ 5: "A", 8: "L8", 11: "L11" }));
    const saved = {
      ...before,
      signedOffBlocks: {
        ...signedOff(before, "app.ts:additions:5:1:1", "app.ts:additions:8:1:1"),
        "app.ts:additions:11:1:1": "another content",
        "gone.ts:additions:1:0:1": "h",
      },
    };
    const merged = await mergeReviewState(
      await edit(edited({ 5: "A", 8: "L8 again", 11: "L11" })),
      saved,
    );
    assert.deepEqual(Object.keys(merged.signedOffBlocks ?? {}), ["app.ts:additions:5:1:1"]);
  });
});

test("a block sign-off follows its block, under its new key, when lines are inserted above it", async () => {
  await withShiftRepo(async (edit) => {
    const before = await edit(edited({ 8: "L8", 11: "L11" }));
    const signed = signedOff(before, "app.ts:additions:8:1:1");
    const merged = await mergeReviewState(await edit(insertAbove(edited({ 8: "L8", 11: "L11" }))), {
      ...before,
      signedOffBlocks: signed,
    });
    assert.deepEqual(merged.signedOffBlocks, {
      "app.ts:additions:10:1:1": signed["app.ts:additions:8:1:1"],
    });
  });
});

test("a save from a tab still on the pre-reload diff carries its block sign-offs onto the reloaded blocks", async () => {
  await withShiftRepo(async (edit) => {
    const live = await edit(edited({ 8: "L8", 11: "L11" }));
    const oldDiff = live.baseDiffHash;
    const prior = { baseDiffHash: oldDiff, changes: live.changes, files: live.files };
    const signed = signedOff(live, "app.ts:additions:8:1:1", "app.ts:additions:11:1:1");
    Object.assign(
      live,
      await mergeReviewState(await edit(insertAbove(edited({ 8: "L8", 11: "L11" }))), live),
    );
    const seen = (baseDiffHash: string) => ({ token: null, reloadGeneration: 0, baseDiffHash });
    await mergeReviewerSave(
      live,
      { signedOffBlocks: signed, seen: seen(oldDiff) },
      undefined,
      prior,
    );
    assert.deepEqual(live.signedOffBlocks, {
      "app.ts:additions:10:1:1": signed["app.ts:additions:8:1:1"],
      "app.ts:additions:13:1:1": signed["app.ts:additions:11:1:1"],
    });
    // From further back than the desk remembers, the desk keeps its own.
    await mergeReviewerSave(
      live,
      { signedOffBlocks: {}, seen: seen("two diffs back") },
      undefined,
      prior,
    );
    assert.equal(Object.keys(live.signedOffBlocks ?? {}).length, 2);
  });
});

test("a save from a tab two diffs behind keeps the desk's file sign-offs along with its decisions", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "galley-stale-tab-")));
  const gitq = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  const write = (f: string, s: string) => fs.writeFile(path.join(dir, f), s);
  const build = async () => (await buildReviewState(dir, { session: "s" }))!;
  try {
    gitq("init", "-q");
    gitq("config", "user.email", "t@t.dev");
    gitq("config", "user.name", "t");
    await write("x.ts", "a\nb\nc\n");
    await write("y.ts", "1\n2\n3\n");
    gitq("add", "-A");
    gitq("commit", "-q", "-m", "init");
    await write("x.ts", "a\nBAD\nc\n");
    await write("y.ts", "1\n2a\n3\n");
    const d0 = await build();
    // The desk reloads twice on y.ts edits while the tab stays on d0.
    await write("y.ts", "1\n2b\n3\n");
    const d1 = await mergeReviewState(await build(), d0);
    await write("y.ts", "1\n2c\n3\n");
    const d2 = await mergeReviewState(await build(), d1);
    // On d0, the reviewer rejects x.ts's block and marks the file reviewed.
    await mergeReviewerSave(
      d2,
      {
        decisions: [decide(d0, "x.ts:additions:2:1:1", "rejected")],
        decisionFiles: ["x.ts"],
        reviewedFiles: ["x.ts"],
        reviewedFileHashes: { "x.ts": d0.files.find((f) => f.path === "x.ts")!.contentHash },
        seen: { token: null, reloadGeneration: 0, baseDiffHash: d0.baseDiffHash },
      },
      undefined,
      { baseDiffHash: d1.baseDiffHash, changes: d1.changes, files: d1.files },
    );
    assert.deepEqual(d2.decisions, []);
    assert.deepEqual(d2.reviewedFiles, []);
    assert.deepEqual(d2.reviewedFileHashes, {});
    assert.deepEqual(d2.decisionFiles, []);
    assert.deepEqual(computeApprovedFiles(d2), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a save from a tab on the pre-reload diff keeps the desk's re-anchored comments and re-anchors its new ones", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 8: "L8", 11: "L11" });
    const live = await edit(lines);
    const prior = { baseDiffHash: live.baseDiffHash, changes: live.changes, files: live.files };
    const seen = { token: null, reloadGeneration: 0, baseDiffHash: live.baseDiffHash };
    const onL8 = comment({
      id: "c1",
      path: "app.ts",
      lineNumber: 8,
      anchorText: "L8",
      body: "why?",
    });
    live.comments = [onL8];
    Object.assign(live, await mergeReviewState(await edit(insertAbove(lines)), live));
    assert.equal(live.comments[0]!.lineNumber, 10, "the reload re-anchored the thread");
    // The agent replies on the re-anchored thread before the tab has adopted the reloaded diff.
    live.comments.push(
      comment({ id: "r1", path: "app.ts", lineNumber: 10, anchorText: "L8", body: "because" }),
    );
    live.comments[1]!.role = "agent";
    // The tab, still on the old diff, edits the comment and adds one on the l11 line.
    const onL11 = comment({
      id: "c2",
      path: "app.ts",
      lineNumber: 11,
      anchorText: "L11",
      body: "and",
    });
    await mergeReviewerSave(
      live,
      { comments: [{ ...onL8, body: "why, really?" }, onL11], seen },
      undefined,
      prior,
    );
    assert.deepEqual(
      live.comments.map((c) => [c.id, c.lineNumber, c.body]),
      [
        ["c1", 10, "why, really?"],
        ["c2", 13, "and"],
        ["r1", 10, "because"],
      ],
    );
  });
});

test("a working-mode file's contents follow a stage that moved its old side", async () => {
  await withShiftRepo(async (edit, stage) => {
    const lines = edited({ 3: "A", 11: "L11" });
    const s1 = await edit(lines);
    const text = (l: string[]) => l.join("\n") + "\n";
    assert.equal((await readFileContents(s1, s1.files[0]!)).oldContents, text(committedLines));
    // Accepting the l3 block staged it; the working tree, and so the file's hash, is unchanged.
    await stage(edited({ 3: "A" }));
    const s2 = await edit(lines);
    assert.equal(s2.files[0]!.contentHash, s1.files[0]!.contentHash);
    const now = await readFileContents(s2, s2.files[0]!);
    assert.equal(now.oldContents, text(edited({ 3: "A" })));
    assert.equal(now.newContents, text(lines));
  });
});

// ── Parts across rounds ──────────────────────────────────────────────────────
// A carried-forward guide places blocks by content (stampParts, above).

test("blocks that only moved keep their part across a reload, and a Rest block stays Rest", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 3: "A", 5: "B", 10: "C", 12: "D" });
    const before = stampParts(await edit(lines), { 3: 0, 5: 0, 10: 1 });
    const merged = await mergeReviewState(await edit(insertAbove(lines)), before);
    // The inserted pair sits above part 0, outside its former lines: Rest.
    assert.deepEqual(partsOf(merged), { 2: "rest", 5: 0, 7: 0, 12: 1, 14: "rest" });
  });
});

test("an edit inside part 1 and lines inserted above part 2 leave part 2 signed off and part 1 pending", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 3: "A", 5: "B", 7: "C", 11: "D", 13: "E" });
    const before = allSignedOff(stampParts(await edit(lines), { 3: 0, 5: 0, 7: 0, 11: 1, 13: 1 }));
    // Part 1's middle block is rewritten, and two lines land after l9, above part 2.
    const next = edited({ 3: "A", 5: "B again", 7: "C", 11: "D", 13: "E" });
    next.splice(9, 0, "m1", "m2");
    const merged = await mergeReviewState(await edit(next), before);
    assert.deepEqual(partsOf(merged), { 3: 0, 5: 0, 7: 0, 10: "rest", 13: 1, 15: 1 });
    // Part 2's blocks moved to new keys with their sign-offs; part 1's rewritten block has none.
    assert.deepEqual(merged.signedOffBlocks, {
      "app.ts:additions:3:1:1": before.signedOffBlocks!["app.ts:additions:3:1:1"],
      "app.ts:additions:7:1:1": before.signedOffBlocks!["app.ts:additions:7:1:1"],
      "app.ts:additions:13:1:1": before.signedOffBlocks!["app.ts:additions:11:1:1"],
      "app.ts:additions:15:1:1": before.signedOffBlocks!["app.ts:additions:13:1:1"],
    });
    assert.deepEqual(merged.reviewedFiles, [], "the file is pending again");
  });
});

test("a block rewritten in place between two blocks of one part stays in that part", async () => {
  await withShiftRepo(async (edit) => {
    const before = stampParts(await edit(edited({ 3: "A", 5: "B", 7: "C" })), { 3: 0, 5: 0, 7: 0 });
    const merged = await mergeReviewState(await edit(edited({ 3: "A", 5: "B2", 7: "C" })), before);
    assert.deepEqual(partsOf(merged), { 3: 0, 5: 0, 7: 0 });
  });
});

test("a new block between a part-1 block and a part-2 block goes to Rest", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 3: "A", 5: "B", 10: "C", 12: "D" });
    const before = stampParts(await edit(lines), { 3: 0, 5: 0, 10: 1, 12: 1 });
    const merged = await mergeReviewState(
      await edit(edited({ 3: "A", 5: "B", 8: "new", 10: "C", 12: "D" })),
      before,
    );
    assert.deepEqual(partsOf(merged), { 3: 0, 5: 0, 8: "rest", 10: 1, 12: 1 });
  });
});

test("a part whose blocks are all gone after a reload claims no block", async () => {
  await withShiftRepo(async (edit) => {
    const before = stampParts(await edit(edited({ 3: "A", 5: "B", 10: "C", 12: "D" })), {
      3: 0,
      5: 0,
      10: 1,
      12: 1,
    });
    const merged = await mergeReviewState(await edit(edited({ 3: "A", 5: "B" })), before);
    assert.deepEqual(partsOf(merged), { 3: 0, 5: 0 });
  });
});

test("a file whose parts are all signed off stays approved when an edit only moves its blocks", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 8: "L8", 11: "L11" });
    const before = allSignedOff(stampParts(await edit(insertAbove(lines)), { 2: 0, 10: 0, 13: 1 }));
    // The inserted pair is reverted: the other two blocks move up, their content untouched.
    const merged = await mergeReviewState(await edit(lines), before);
    assert.notEqual(merged.files[0]!.contentHash, before.files[0]!.contentHash);
    assert.deepEqual(Object.keys(merged.signedOffBlocks ?? {}).sort(), [
      "app.ts:additions:11:1:1",
      "app.ts:additions:8:1:1",
    ]);
    assert.deepEqual(merged.reviewedFiles, ["app.ts"]);
    assert.deepEqual(merged.reviewedFileHashes, { "app.ts": merged.files[0]!.contentHash });
    assert.deepEqual(computeApprovedFiles(merged), ["app.ts"]);
  });
});

test("an unsplit file's approval lapses when the agent reverts one of its approved blocks", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 8: "L8", 11: "L11" });
    const before = allSignedOff(await edit(insertAbove(lines)));
    const merged = await mergeReviewState(await edit(lines), before);
    assert.equal(Object.keys(merged.signedOffBlocks ?? {}).length, 2, "its blocks stay signed off");
    assert.deepEqual(merged.reviewedFiles, []);
    assert.deepEqual(computeApprovedFiles(merged), []);
  });
});

test("a save from a tab still on the pre-reload diff keeps a file approved whose blocks only moved", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 8: "L8", 11: "L11" });
    const live = stampParts(await edit(insertAbove(lines)), { 2: 0, 10: 0, 13: 1 });
    const prior = { baseDiffHash: live.baseDiffHash, changes: live.changes, files: live.files };
    const signed = allSignedOff(live);
    Object.assign(live, await mergeReviewState(await edit(lines), live));
    await mergeReviewerSave(
      live,
      {
        signedOffBlocks: signed.signedOffBlocks,
        reviewedFiles: signed.reviewedFiles,
        reviewedFileHashes: signed.reviewedFileHashes,
        seen: { token: null, reloadGeneration: 0, baseDiffHash: prior.baseDiffHash },
      },
      undefined,
      prior,
    );
    assert.equal(Object.keys(live.signedOffBlocks ?? {}).length, 2);
    assert.deepEqual(live.reviewedFileHashes, { "app.ts": live.files[0]!.contentHash });
    assert.deepEqual(computeApprovedFiles(live), ["app.ts"]);
  });
});

test("a guide swap regroups the parts and keeps the sign-offs of blocks already signed off", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 3: "A", 5: "B", 10: "C" });
    const before = await edit(lines);
    const split = (...parts: Array<[string, number[]]>): Guide => ({
      overview: "o",
      files: parts.map(([title, at], i) => ({
        path: "app.ts",
        order: i,
        category: title,
        orientation: title,
        part: { title, lines: at },
      })),
    });
    assert.ok(resolveGuide(before, split(["One", [3, 5]], ["Two", [10]])).ok);
    const saved = {
      ...before,
      signedOffBlocks: signedOff(before, "app.ts:additions:3:1:1", "app.ts:additions:5:1:1"),
    };
    const after = await edit(lines);
    const merged = await mergeReviewState(after, saved);
    assert.ok(
      resolveGuide(merged, split(["Head", [3]], ["Tail", [5, 10]]), parsedDiffOf(after)).ok,
    );
    assert.deepEqual(partsOf(merged), { 3: 0, 5: 1, 10: 1 });
    assert.deepEqual(merged.signedOffBlocks, saved.signedOffBlocks);
  });
});

// The carry rule itself, on the edges of the position rule.
test("carryGuideStamps: at the file's start a block joins the part below only within that part's former lines", async () => {
  await withShiftRepo(async (edit) => {
    const before = stampParts(await edit(edited({ 3: "A", 5: "B" })), { 3: 0, 5: 0 });
    const after = await edit(edited({ 1: "new", 3: "A2", 5: "B" }));
    carryGuideStamps(after, before);
    assert.deepEqual(partsOf(after), { 1: "rest", 3: 0, 5: 0 });
  });
});

test("carryGuideStamps: at the file's end a block joins the part above only within that part's former lines", async () => {
  await withShiftRepo(async (edit) => {
    const before = stampParts(await edit(edited({ 10: "C", 12: "D" })), { 10: 1, 12: 1 });
    // l12 grows by a line past the part's last line; a new line is appended after l14.
    const grown = edited({ 10: "C", 12: "D2" });
    grown.splice(12, 0, "D3");
    const after = await edit([...grown, "appended"]);
    carryGuideStamps(after, before);
    assert.deepEqual(partsOf(after), { 10: 1, 12: 1, 16: "rest" });
  });
});

test("carryGuideStamps: a rewritten edge block stays in its part though another part borders it", async () => {
  await withShiftRepo(async (edit) => {
    const before = stampParts(await edit(edited({ 3: "A", 5: "B", 10: "C", 12: "D" })), {
      3: 0,
      5: 0,
      10: 1,
      12: 1,
    });
    const after = await edit(edited({ 3: "A", 5: "B2", 10: "C2", 12: "D" }));
    carryGuideStamps(after, before);
    assert.deepEqual(partsOf(after), { 3: 0, 5: 0, 10: 1, 12: 1 });
  });
});

test("carryGuideStamps: a part pushed down by an edit above keeps its rewritten last block", async () => {
  await withShiftRepo(async (edit) => {
    const before = stampParts(await edit(edited({ 3: "A", 10: "C", 12: "D" })), {
      3: 0,
      10: 1,
      12: 1,
    });
    const after = await edit(insertAbove(edited({ 3: "A", 10: "C", 12: "D2" })));
    carryGuideStamps(after, before);
    assert.deepEqual(partsOf(after), { 2: "rest", 5: 0, 12: 1, 14: 1 });
  });
});

test("carryGuideStamps: a block both bordering parts' former lines cover goes to Rest", async () => {
  await withShiftRepo(async (edit) => {
    // The parts interleave: part 0 spans lines 3-10, part 1 lines 6-13.
    const lines = edited({ 3: "A", 6: "B", 10: "C", 13: "D" });
    const before = stampParts(await edit(lines), { 3: 0, 6: 1, 10: 0, 13: 1 });
    const after = await edit(edited({ 3: "A", 6: "B", 8: "new", 10: "C", 13: "D" }));
    carryGuideStamps(after, before);
    assert.deepEqual(partsOf(after), { 3: 0, 6: 1, 8: "rest", 10: 0, 13: 1 });
  });
});

test("carryGuideStamps: identical blocks keep their own parts, each at its own place", async () => {
  await withShiftRepo(async (edit) => {
    const before = stampParts(await edit(twinLines()), { 4: 0, 10: 1 });
    const after = await edit(insertAbove(twinLines()));
    carryGuideStamps(after, before);
    assert.deepEqual(partsOf(after), { 2: "rest", 6: 0, 12: 1 });
  });
});

// ── Skims across rounds ──────────────────────────────────────────────────────
// app.ts's guide entry skimming the blocks the spans touch.
const skimGuide = (...spans: Array<[number, number]>): Guide => ({
  overview: "o",
  files: [
    {
      path: "app.ts",
      order: 0,
      category: "C",
      orientation: "o",
      skimBlocks: spans.map((lines) => ({ lines, reason: "churn" })),
    },
  ],
});
// Each block's skim by its first line.
const skimsOf = (st: Pick<ReviewState, "changes">) =>
  Object.fromEntries(st.changes.map((c) => [c.lineNumber, !!c.skim]));

test("a skimmed block stays skimmed, and no other block is, when lines are inserted above it", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 8: "A", 10: "C" });
    const before = await edit(lines);
    before.guide = skimGuide([10, 10]);
    assert.ok(resolveGuide(before, before.guide).ok);
    const merged = await mergeReviewState(await edit(insertAbove(lines)), before);
    assert.deepEqual(skimsOf(merged), { 2: false, 10: false, 12: true });
  });
});

test("a skimmed block rewritten in place comes back pending and not skimmed", async () => {
  await withShiftRepo(async (edit) => {
    const before = await edit(edited({ 8: "A", 10: "C" }));
    before.guide = skimGuide([10, 10]);
    assert.ok(resolveGuide(before, before.guide).ok);
    const saved = { ...before, decisions: [decide(before, "app.ts:additions:10:1:1", "accepted")] };
    const merged = await mergeReviewState(await edit(edited({ 8: "A", 10: "C2" })), saved);
    assert.deepEqual(skimsOf(merged), { 8: false, 10: false });
    assert.equal(statusOf(merged, "app.ts:additions:10:1:1"), "pending");
  });
});

test("a guide swap re-stamps skims strictly from the new spans", async () => {
  await withShiftRepo(async (edit) => {
    const lines = edited({ 8: "A", 10: "C" });
    const before = await edit(lines);
    before.guide = skimGuide([10, 10]);
    assert.ok(resolveGuide(before, before.guide).ok);
    const after = await edit(insertAbove(lines));
    const merged = await mergeReviewState(after, before);
    assert.ok(resolveGuide(merged, skimGuide([10, 10]), parsedDiffOf(after)).ok);
    assert.deepEqual(skimsOf(merged), { 2: false, 10: true, 12: false });
    assert.deepEqual(resolveGuide(merged, skimGuide([9, 9]), parsedDiffOf(after)), {
      ok: false,
      reason: 'guide skimBlocks span [9, 9] on "app.ts" matches no change in the diff',
    });
  });
});

test("a split file that becomes a git rename on a reload keeps its parts at its new path", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "galley-rename-parts-")));
  const gitq = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  try {
    gitq("init", "-q");
    gitq("config", "user.email", "t@t.dev");
    gitq("config", "user.name", "t");
    await fs.writeFile(path.join(dir, "app.ts"), committedLines.join("\n") + "\n");
    gitq("add", "-A");
    gitq("commit", "-q", "-m", "init");
    // A staged desk, so the rename below is one git detects (index vs HEAD).
    const stage = async (file: string, lines: string[]) => {
      await fs.writeFile(path.join(dir, file), lines.join("\n") + "\n");
      gitq("add", "-A");
      return (await buildReviewState(dir, { session: "s", staged: true }))!;
    };
    const before = stampParts(await stage("app.ts", edited({ 3: "A", 5: "B", 10: "C" })), {
      3: 0,
      5: 0,
      10: 1,
    });
    gitq("mv", "app.ts", "moved.ts");
    // The first block is rewritten too: it joins its part by that part's former lines.
    const after = await stage("moved.ts", edited({ 3: "A2", 5: "B", 10: "C" }));
    assert.equal(after.files[0]?.oldPath, "app.ts", "git sees a rename");
    const merged = await mergeReviewState(after, before);
    assert.deepEqual(
      merged.changes.map((c) => [c.path, c.lineNumber, c.part]),
      [
        ["moved.ts", 3, 0],
        ["moved.ts", 5, 0],
        ["moved.ts", 10, 1],
      ],
    );
    // The guide's entries follow the file, so its parts still name a file in the diff.
    assert.deepEqual(
      merged.guide?.files.map((g) => g.path),
      ["moved.ts", "moved.ts"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
        contentHash: "DEL",
        changeKind: "deleted" as const,
      },
      {
        path: "b.ts",
        hunks: [],
        oldPath: "b.ts",
        newPath: "b.ts", // untracked addition: no old side
        contentHash: "ADD",
        changeKind: "added" as const,
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
  assert.equal(m.changeKind, "renamed");
  assert.equal(m.renamePure, false); // moved AND edited — not a pure rename
  assert.equal(m.contentHash, "ADD"); // reuses the untracked add's new-side OID (no re-hash)
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

test("mergeReviewState migrates a comment + staged-hunk key across a working-mode move pairing (issue 02)", async () => {
  // A plain mv paired into a rename-pure entry on reload: the file arrives at new.txt with no change
  // blocks, and everything the reviewer left against old.txt migrates to new.txt (issue 01's path).
  const paired = {
    path: "new.txt",
    hunks: [],
    oldPath: "old.txt",
    newPath: "new.txt",
    contentHash: "H",
    changeKind: "renamed" as const,
    renamePure: true,
  };
  const base = state({ files: [paired], changes: [] });
  const saved = state({
    comments: [comment({ id: "c1", path: "old.txt", intent: "action", anchorText: "x" })],
    stagedChangeKeys: ["old.txt:additions:1:0:1"],
  });
  const merged = await mergeReviewState(base, saved);
  assert.equal(merged.comments.length, 1);
  assert.equal(merged.comments[0]!.path, "new.txt");
  assert.equal(merged.comments[0]!.status, "open");
  assert.deepEqual(merged.stagedChangeKeys, ["new.txt:additions:1:0:1"]);
});

// ── Re-anchoring ─────────────────────────────────────────────────────────────

// A lean file entry paired with the contents a resolver would return for it (the state embeds
// none — anchoring reads them on demand). `reanchor` wires those contents into reanchorComments.
function withContents(path: string, newContents: string, oldContents = newContents) {
  return {
    file: { path, hunks: [], contentHash: "H", changeKind: "modified" as const },
    contents: { oldContents, newContents },
  };
}
function reanchor(comments: ReviewComment[], entries: ReturnType<typeof withContents>[]) {
  const map = new Map(entries.map((e) => [e.file.path, e.contents]));
  return reanchorComments(
    comments,
    entries.map((e) => e.file),
    (p) => map.get(p),
  );
}

test("anchorTextFor reads the line from the right side's contents", () => {
  const c = { oldContents: "o1\no2", newContents: "n1\nn2\nn3" };
  assert.equal(anchorTextFor(c, "additions", 2), "n2");
  assert.equal(anchorTextFor(c, "deletions", 2), "o2");
  assert.equal(anchorTextFor(c, "additions", 9), undefined);
  assert.equal(anchorTextFor(undefined, "additions", 1), undefined); // file not resolved → no anchor
});

test("reanchorComments keeps a comment whose line still matches its anchor text", () => {
  const c = comment({ id: "c1", path: "a.ts", lineNumber: 2, anchorText: "beta" });
  reanchor([c], [withContents("a.ts", "alpha\nbeta\ngamma")]);
  assert.equal(c.lineNumber, 2);
  assert.equal(c.unanchored, false);
});

test("reanchorComments moves a comment to the unique nearest matching line (endLine shifts too)", () => {
  // Two lines inserted above: "beta" moved from 2 to 4.
  const c = comment({ id: "c1", path: "a.ts", lineNumber: 2, endLine: 3, anchorText: "beta" });
  reanchor([c], [withContents("a.ts", "x\nalpha\ny\nbeta\ngamma")]);
  assert.equal(c.lineNumber, 4);
  assert.equal(c.endLine, 5);
  assert.equal(c.unanchored, false);
});

test("reanchorComments flags an ambiguous or vanished anchor as unanchored", () => {
  const tie = comment({ id: "c1", path: "a.ts", lineNumber: 2, anchorText: "dup" }); // 1 and 3 equidistant
  const gone = comment({ id: "c2", path: "a.ts", lineNumber: 2, anchorText: "deleted line" });
  reanchor([tie, gone], [withContents("a.ts", "dup\nmid\ndup\nend")]);
  assert.equal(tie.unanchored, true);
  assert.equal(tie.lineNumber, 2); // left where it was
  assert.equal(gone.unanchored, true);
});

test("reanchorComments best-effort re-anchors a lightly-edited line to the nearest similar one", () => {
  // The anchored line "const total = a + b;" was tweaked to "...a + b + c;" — same line, edited,
  // so its exact text is gone. It should stay put (near its old spot), not fall to the strip.
  const c = comment({
    id: "c1",
    path: "a.ts",
    lineNumber: 2,
    anchorText: "  const total = a + b;",
  });
  reanchor(
    [c],
    [withContents("a.ts", "function sum() {\n  const total = a + b + c;\n  return total;\n}")],
  );
  assert.equal(c.unanchored, false);
  assert.equal(c.lineNumber, 2);
});

test("reanchorComments leaves a comment unanchored when no surviving line is similar", () => {
  const c = comment({ id: "c1", path: "a.ts", lineNumber: 2, anchorText: "const total = a + b;" });
  reanchor([c], [withContents("a.ts", "wholly\ndifferent\ncontent\nhere")]);
  assert.equal(c.unanchored, true);
});

test("reanchorComments skips resolved comments and flags legacy ones only when out of range", () => {
  const resolved = comment({
    id: "c1",
    path: "a.ts",
    lineNumber: 9,
    status: "resolved",
    anchorText: "gone",
  });
  const legacyIn = comment({ id: "c2", path: "a.ts", lineNumber: 2 }); // no anchorText
  const legacyOut = comment({ id: "c3", path: "a.ts", lineNumber: 7 });
  reanchor([resolved, legacyIn, legacyOut], [withContents("a.ts", "one\ntwo")]);
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

test("buildReviewResult excludes questions from codeChangeRequests, keeps an action on the same line", () => {
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
  assert.equal(r.codeChangeRequests.length, 1);
  assert.equal(r.codeChangeRequests[0]!.body, "rename this");
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
  // Same shape as an await question — lane-tagged, mode/session threaded through.
  assert.deepEqual(r.openQuestions, [
    {
      lane: "code",
      path: "a.ts",
      lineNumber: 4,
      side: "additions",
      body: "why here?",
      mode: "repo",
      session: "sess",
    },
  ]);
});

test("a change request turned into a question counts as asked at the turn: earlier agent replies don't answer it", () => {
  const thread = (line: number, askedAt: string, reply: string) => [
    comment({
      id: `q${line}`,
      path: "a.ts",
      lineNumber: line,
      body: `rename ${line}`,
      intent: "question",
      role: "user",
      createdAt: "2026-01-01T00:00:00Z",
      askedAt,
    }),
    comment({
      id: `r${line}`,
      path: "a.ts",
      lineNumber: line,
      body: "done",
      intent: "note",
      role: "agent",
      createdAt: reply,
    }),
  ];
  const s = state({
    comments: [
      // Replied to at 00:01 as a change request, turned into a question at 00:05.
      ...thread(4, "2026-01-01T00:05:00Z", "2026-01-01T00:01:00Z"),
      // Turned at 00:05 and answered afresh at 00:06.
      ...thread(7, "2026-01-01T00:05:00Z", "2026-01-01T00:06:00Z"),
    ],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(
    r.openQuestions.map((q) => q.body),
    ["rename 4"],
  );
  assert.deepEqual(r.codeChangeRequests, []);
});

test("buildReviewResult carries mode/target/base", () => {
  const s = state({ mode: "pr", target: "feature-x", base: "abc123" });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.equal(r.mode, "pr");
  assert.equal(r.target, "feature-x");
  assert.equal(r.base, "abc123");
});

test("buildDiffSource stamps oversized on a large-diff file, not on ordinary ones (issue 05)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "galley-oversized-"));
  const gitq = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  try {
    gitq("init", "-q");
    gitq("config", "user.email", "t@t.dev");
    gitq("config", "user.name", "t");
    // Commit a 6000-line file + a small one, then rewrite both in the working tree. The full
    // rewrite of the big file clears the >5000-changed-line threshold; the small edit does not.
    const lines = (tag: string) =>
      Array.from({ length: 6000 }, (_, i) => `${tag} line ${i}`).join("\n") + "\n";
    await fs.writeFile(path.join(dir, "big.txt"), lines("orig"));
    await fs.writeFile(path.join(dir, "small.txt"), "a\nb\nc\n");
    gitq("add", "-A");
    gitq("commit", "-q", "-m", "init");
    await fs.writeFile(path.join(dir, "big.txt"), lines("edited"));
    await fs.writeFile(path.join(dir, "small.txt"), "a\nB\nc\n");

    const source = await buildDiffSource({ mode: "repo", root: dir });
    assert.ok(source, "diff source built");
    const big = source!.files.find((f) => f.path === "big.txt");
    const small = source!.files.find((f) => f.path === "small.txt");
    assert.equal(big?.oversized, true, "the >5000-changed-line file is stamped oversized");
    assert.ok(!small?.oversized, "an ordinary one-line change is not oversized");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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

test("mergeReviewState keeps a finished file when its content hash is unchanged", async () => {
  const base = state({ files: [file("a.ts", "H")] });
  const saved = state({
    files: [file("a.ts", "H")],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "H" },
  });
  const merged = await mergeReviewState(base, saved);
  assert.deepEqual(merged.reviewedFiles, ["a.ts"]);
  assert.equal(merged.reviewedFileHashes!["a.ts"], "H");
});

test("mergeReviewState drops a finished file when its content hash changed (re-review)", async () => {
  const base = state({ files: [file("a.ts", "NEW")] });
  const saved = state({
    files: [file("a.ts", "OLD")],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "OLD" },
  });
  const merged = await mergeReviewState(base, saved);
  assert.deepEqual(merged.reviewedFiles, []);
  assert.deepEqual(merged.reviewedFileHashes, {});
});

test("mergeReviewState drops a finished file with no recorded hash (old viewed-era session)", async () => {
  const base = state({ files: [file("a.ts", "H")] });
  const saved = state({ files: [file("a.ts", "H")], reviewedFiles: ["a.ts"] }); // no reviewedFileHashes
  const merged = await mergeReviewState(base, saved);
  assert.deepEqual(merged.reviewedFiles, []);
});

test("mergeReviewState (blob-OID migration): a pre-OID review loads — comments + unchanged-block decisions survive, file approval resets once", async () => {
  // A review persisted before file-level keys became git blob OIDs: the file's contentHash is
  // the old 16-char sha slice ("OLDSHA16"), and reviewedFileHashes matches THAT. On the first
  // reload with OID keys, the fresh file entry carries a 40-hex blob OID, so the file hash no
  // longer matches — file approval resets. Block-level hashing is UNCHANGED (a diff block has no
  // blob OID), so a saved decision on an unchanged block still matches and carries forward.
  const base = state({
    files: [file("a.ts", "0123456789abcdef0123456789abcdef01234567")], // fresh: blob OID
    changes: [change({ id: "a.ts:k1", path: "a.ts", stableKey: "k1", contentHash: "BLOCKHASH" })],
  });
  const saved = state({
    files: [file("a.ts", "OLDSHA16")], // old-format 16-char slice
    comments: [comment({ id: "c1", path: "a.ts", intent: "action", body: "fix this" })],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "OLDSHA16" }, // old-format → won't match the OID
    decisions: [
      decision({ key: "a.ts:k1", path: "a.ts", status: "accepted", reviewedHash: "BLOCKHASH" }),
    ],
  });
  const merged = await mergeReviewState(base, saved);
  // Comments carry over.
  assert.equal(merged.comments.length, 1);
  assert.equal(merged.comments[0]!.id, "c1");
  // File approval / reviewed-file marks reset (the file-level key format changed).
  assert.deepEqual(merged.reviewedFiles, []);
  assert.deepEqual(merged.reviewedFileHashes, {});
  // An unchanged-content block decision survives (block hashing is unchanged).
  assert.equal(merged.changes[0]!.status, "accepted");
  assert.ok(merged.decisions!.some((d) => d.key === "a.ts:k1"));
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
  const r = resolveSkim(SKIM_DIFF, changes, guideWith([{ lines: [3, 5], reason: "imports" }]));
  assert.ok(r.ok);
  const imports = changes.find((c) => c.stableKey === "additions:3:0:3");
  const core = changes.find((c) => c.stableKey === "additions:8:1:2");
  assert.deepEqual(imports!.skim, { reason: "imports" });
  assert.equal(core!.skim, undefined); // only the targeted block is stamped
});

test("resolveSkim rejects a span that matches no change block, naming path + span", () => {
  const r = resolveSkim(SKIM_DIFF, changesFromDiff(SKIM_DIFF), guideWith([{ lines: [100, 101] }]));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /app\.ts/);
  assert.match(r.reason, /100/);
  // A span the diff once held but a rewrite left on unchanged lines is rejected the same way.
  const stale = resolveSkim(
    SKIM_DIFF_REWRITTEN,
    changesFromDiff(SKIM_DIFF_REWRITTEN),
    guideWith([{ lines: [3, 5], reason: "imports" }]),
  );
  assert.equal(stale.ok, false);
});

test("resolveSkim rejects a skimBlocks entry on a file absent from the diff", () => {
  const r = resolveSkim(
    SKIM_DIFF,
    changesFromDiff(SKIM_DIFF),
    guideWith([{ lines: [1, 2] }], "ghost.ts"),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /ghost\.ts/);
});

test("resolveSkim clears prior stamps so re-resolution is idempotent", () => {
  const changes = changesFromDiff(SKIM_DIFF);
  resolveSkim(SKIM_DIFF, changes, guideWith([{ lines: [3, 5] }]));
  assert.ok(changes.find((c) => c.stableKey === "additions:3:0:3")!.skim);
  // Re-resolve with a guide targeting the OTHER block: the first stamp must be cleared.
  resolveSkim(SKIM_DIFF, changes, guideWith([{ lines: [8, 9] }]));
  assert.equal(changes.find((c) => c.stableKey === "additions:3:0:3")!.skim, undefined);
  assert.ok(changes.find((c) => c.stableKey === "additions:8:1:2")!.skim);
});

test("reload parses the unified diff exactly once, shared across build + skim (issue 06)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "galley-parse-once-"));
  const gitq = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  try {
    gitq("init", "-q");
    gitq("config", "user.email", "t@t.dev");
    gitq("config", "user.name", "t");
    // Commit app.ts, then add an imports run + rewrite core() in the working tree — a diff whose
    // new-side lines 3-5 (the added imports) a guide skimBlocks span [3,5] resolves to.
    const OLD = [
      `import { a } from "./a";`,
      `import { b } from "./b";`,
      ``,
      `export function core() {`,
      `  return a() + b();`,
      `}`,
      ``,
    ].join("\n");
    const NEW = [
      `import { a } from "./a";`,
      `import { b } from "./b";`,
      `import { c } from "./c";`,
      `import { d } from "./d";`,
      `import { e } from "./e";`,
      ``,
      `export function core() {`,
      `  const total = a() + b() + c();`,
      `  return total * 2;`,
      `}`,
      ``,
    ].join("\n");
    await fs.writeFile(path.join(dir, "app.ts"), OLD);
    gitq("add", "-A");
    gitq("commit", "-q", "-m", "init");
    await fs.writeFile(path.join(dir, "app.ts"), NEW);

    // Mirror the reload flow: build (parses once, seeds the memo) → merge → skim resolution
    // handed the memoized parse via parsedDiffOf(base) instead of re-parsing rawDiff.
    gitStats.parses = 0;
    const base = await buildReviewState(dir, { session: "s" });
    assert.ok(base, "state built");
    const merged = await mergeReviewState(base!, null);
    merged.guide = guideWith([{ lines: [3, 5], reason: "imports" }]);
    const skim = resolveSkim(merged.rawDiff, merged.changes, merged.guide, parsedDiffOf(base!));
    assert.ok(skim.ok, "skim resolved");
    assert.equal(gitStats.parses, 1, "diff parsed exactly once across build + skim resolution");
    assert.ok(
      merged.changes.some((c) => c.skim),
      "the imports block was stamped skim — the shared parse actually drove resolution",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── resolveParts: guide parts → ChangeState.part stamping ────────────────────
// SKIM_DIFF's two blocks: the imports run (new lines 3-5) and the core() rewrite (new lines 8-9).
const IMPORTS = "additions:3:0:3";
const CORE = "additions:8:1:2";

function partsGuide(
  ...parts: Array<[title: string, lines: Array<[number, number] | number>]>
): Guide {
  return {
    overview: "o",
    files: parts.map(([title, lines], i) => ({
      path: "app.ts",
      order: i,
      category: `C${i}`,
      orientation: title,
      part: { title, lines },
    })),
  };
}
const partOf = (changes: ChangeState[], stableKey: string) =>
  changes.find((c) => c.stableKey === stableKey)!.part;
// SKIM_DIFF as the resolvers see a review: its raw diff, change blocks and files.
const skimDiff = (
  changes = changesFromDiff(SKIM_DIFF),
  files: Array<Pick<ReviewFile, "path" | "changeKind">> = [
    { path: "app.ts", changeKind: "modified" },
  ],
) => ({ rawDiff: SKIM_DIFF, changes, files });

test("resolveParts stamps each block with the index of the guide entry whose part claims it", () => {
  const changes = changesFromDiff(SKIM_DIFF);
  const r = resolveParts(skimDiff(changes), partsGuide(["Imports", [[3, 5]]], ["Core", [9]]));
  assert.deepEqual(r, { ok: true });
  assert.equal(partOf(changes, IMPORTS), 0);
  assert.equal(partOf(changes, CORE), 1);
});

test("resolveParts leaves a block no part claims unstamped (the file's Rest)", () => {
  const changes = changesFromDiff(SKIM_DIFF);
  assert.ok(resolveParts(skimDiff(changes), partsGuide(["Imports", [4]])).ok);
  assert.equal(partOf(changes, IMPORTS), 0);
  assert.equal(partOf(changes, CORE), undefined);
});

test("resolveParts rejects a span that matches no block, naming path, part title and span", () => {
  const r = resolveParts(skimDiff(), partsGuide(["Imports", [[3, 5]]], ["Core", [[100, 104]]]));
  assert.deepEqual(r, {
    ok: false,
    reason: 'guide part "Core" on "app.ts": span [100, 104] matches no change in the diff',
  });
  const single = resolveParts(skimDiff(), partsGuide(["Core", [1]]));
  assert.deepEqual(single, {
    ok: false,
    reason: 'guide part "Core" on "app.ts": line 1 matches no change in the diff',
  });
});

test("resolveParts rejects a part on a file absent from the diff", () => {
  const guide = partsGuide(["Ghost", [3]]);
  guide.files[0]!.path = "ghost.ts";
  const r = resolveParts(skimDiff(), guide);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /"Ghost" on "ghost\.ts"/);
});

test("resolveParts rejects two parts claiming one block, naming both and the block's lines", () => {
  const r = resolveParts(skimDiff(), partsGuide(["Imports", [[3, 5]]], ["Core", [5, [8, 9]]]));
  assert.deepEqual(r, {
    ok: false,
    reason: 'guide parts "Imports" and "Core" on "app.ts" both claim the change at lines 3-5',
  });
});

test("resolveParts clears prior stamps so re-resolution follows the new guide", () => {
  const changes = changesFromDiff(SKIM_DIFF);
  resolveParts(skimDiff(changes), partsGuide(["Imports", [3]], ["Core", [8]]));
  resolveParts(skimDiff(changes), partsGuide(["Core", [8]]));
  assert.equal(partOf(changes, IMPORTS), undefined);
  assert.equal(partOf(changes, CORE), 0);
});

test("resolveGuide resolves skims and parts together and fails on either", () => {
  const guide = partsGuide(["Imports", [[3, 5]]], ["Core", [8]]);
  guide.files[0]!.skimBlocks = [{ lines: [3, 5], reason: "imports" }];
  const changes = changesFromDiff(SKIM_DIFF);
  assert.deepEqual(resolveGuide(skimDiff(changes), guide), { ok: true });
  assert.deepEqual(changes.find((c) => c.stableKey === IMPORTS)!.skim, { reason: "imports" });
  assert.equal(partOf(changes, CORE), 1);
  guide.files[1]!.part!.lines = [100];
  const bad = resolveGuide(skimDiff(), guide);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /"Core" on "app\.ts": line 100/);
});

test("resolveParts says a new untracked file can't be split, naming path and part", () => {
  // An untracked add is one whole-file entry with no section in the raw diff.
  const guide = partsGuide(["Scaffold", [[1, 5]]]);
  guide.files[0]!.path = "new.ts";
  const files = [
    { path: "app.ts", changeKind: "modified" as const },
    { path: "new.ts", changeKind: "added" as const },
  ];
  assert.deepEqual(resolveParts(skimDiff(undefined, files), guide), {
    ok: false,
    reason:
      'guide part "Scaffold" on "new.ts": "new.ts" is a new untracked file — one whole-file change, it can\'t be split into parts',
  });
});

test("resolveGuide rejects a part's skimBlocks span that reaches another part's block", () => {
  const guide = partsGuide(["Imports", [[3, 5]]], ["Core", [8]]);
  guide.files[0]!.skimBlocks = [{ lines: [8, 8], reason: "churn" }];
  assert.deepEqual(resolveGuide(skimDiff(), guide), {
    ok: false,
    reason:
      'guide part "Imports" on "app.ts": skimBlocks span [8, 8] reaches the change at lines 8-9, which part "Core" claims',
  });
});

test("resolveGuide lets a part skim its own blocks and unclaimed ones", () => {
  const guide = partsGuide(["Core", [8]]);
  guide.files[0]!.skimBlocks = [{ lines: [3, 9] }];
  const changes = changesFromDiff(SKIM_DIFF);
  assert.deepEqual(resolveGuide(skimDiff(changes), guide), { ok: true });
  assert.ok(changes.find((c) => c.stableKey === CORE)!.skim, "its own block");
  assert.ok(changes.find((c) => c.stableKey === IMPORTS)!.skim, "a Rest block");
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

test("the reviewer save slice never carries skim (changes are server-owned)", async () => {
  const s = state({ changes: [change({ id: "a.ts:k", path: "a.ts", stableKey: "k" })] });
  // A stale tab POSTs a whole ReviewState, changes included; mergeReviewerSave must ignore them.
  await mergeReviewerSave(s, {
    changes: [{ id: "a.ts:k", path: "a.ts", stableKey: "k", skim: { reason: "x" } }],
    comments: [],
  });
  assert.equal(s.changes[0]!.skim, undefined); // changes (hence skim) are not a reviewer-save key
  assert.deepEqual(s.comments, []); // comments ARE reviewer-owned, so they applied
});

// ── Lean persistence (issue 04) ──────────────────────────────────────────────

test("writeFileAtomic writes the content and leaves no temp file behind", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "galley-atomic-"));
  try {
    const target = path.join(dir, "review.json");
    await writeFileAtomic(target, '{"ok":true}\n');
    assert.equal(await fs.readFile(target, "utf8"), '{"ok":true}\n');
    // Overwrite (the reviewer saved again) — the target updates and no *.tmp is stranded.
    await writeFileAtomic(target, '{"ok":false}\n');
    assert.equal(await fs.readFile(target, "utf8"), '{"ok":false}\n');
    const leftovers = (await fs.readdir(dir)).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no temp file left after the rename");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("persistReview writes a lean review — no file contents on disk", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "galley-persist-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const s = state({ root: home, files: [file("a.ts", "H")] });
    const written = await persistReview(s);
    const raw = await fs.readFile(written, "utf8");
    assert.equal(raw.includes('"oldFile"'), false);
    assert.equal(raw.includes('"newFile"'), false);
    assert.equal(raw.includes('"contents"'), false);
    const parsed = JSON.parse(raw) as ReviewState;
    assert.equal("oldFile" in parsed.files[0]!, false);
    assert.equal("newFile" in parsed.files[0]!, false);
    assert.equal(parsed.files[0]!.contentHash, "H"); // the OID key stays
  } finally {
    process.env.HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("mergeReviewState carries the UI target across reload/restart (the rebuilt base has none)", async () => {
  const base = state({ files: [file("a.ts")] });
  const saved = state({ files: [file("a.ts")], ui: { target: "http://localhost:3000/app" } });
  const merged = await mergeReviewState(base, saved);
  assert.deepEqual(merged.ui, { target: "http://localhost:3000/app" });
});

test("stableUiPort is deterministic, in range, and distinct from the desk's stablePort", () => {
  const a = stableUiPort("/work/repo", "main");
  assert.equal(a, stableUiPort("/work/repo", "main"));
  assert.ok(a >= 41000 && a < 51000);
  assert.notEqual(a, stablePort("/work/repo", "main"), "the UI salt moves it off the desk port");
  assert.notEqual(a, stableUiPort("/work/repo", "feature-x"));
  assert.equal(stableUiPort("/work/repo", "feature/x"), stableUiPort("/work/repo", "feature-x"));
});

test("buildReviewState on a clean tree: null by default, an empty state with allowEmpty (UI-only desk)", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "galley-clean-")));
  const gitq = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  try {
    gitq("init", "-q");
    gitq("config", "user.email", "t@t.co");
    gitq("config", "user.name", "t");
    await fs.writeFile(path.join(dir, "a.txt"), "one\n");
    gitq("add", "-A");
    gitq("commit", "-q", "-m", "init");
    assert.equal(await buildReviewState(dir, { session: "s" }), null);
    const empty = await buildReviewState(dir, { session: "s", allowEmpty: true });
    assert.ok(empty, "an empty state is built");
    assert.equal(empty!.root, dir);
    assert.deepEqual(empty!.files, []);
    assert.deepEqual(empty!.changes, []);
    assert.equal(empty!.rawDiff, "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── baseDiffHash: the review files outside the raw diff ─────────────────────────────────────────
const MODIFIED_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 5626abf..a9c5f5b 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1 +1 @@",
  "-one",
  "+ONE",
  "",
].join("\n");
// git -M at 100% similarity: a zero-hunk section the parse keeps — still a file the raw diff names.
const PURE_RENAME_DIFF = [
  "diff --git a/old.ts b/new.ts",
  "similarity index 100%",
  "rename from old.ts",
  "rename to new.ts",
  "",
].join("\n");

test("baseDiffHashOf is exactly the raw diff's hash when the raw diff names every review file", () => {
  const rawDiff = MODIFIED_DIFF + PURE_RENAME_DIFF;
  const files = [file("a.ts"), { ...file("new.ts"), oldPath: "old.ts", newPath: "new.ts" }];
  const parsedDiff = parseUnifiedDiff(rawDiff);
  assert.equal(baseDiffHashOf({ rawDiff, parsedDiff, files }), hash(rawDiff));
  assert.equal(baseDiffHashOf({ rawDiff: "", parsedDiff: [], files: [] }), hash(""));
});

test("baseDiffHashOf folds in each file the raw diff doesn't name, by path and content, in any order", () => {
  const rawDiff = MODIFIED_DIFF;
  const parsedDiff = parseUnifiedDiff(rawDiff);
  const of = (...files: ReturnType<typeof file>[]) =>
    baseDiffHashOf({ rawDiff, parsedDiff, files });
  const withUntracked = of(file("a.ts"), file("z.ts", "Z1"), file("b.ts", "B1"));
  assert.notEqual(withUntracked, hash(rawDiff), "an untracked add moves the hash");
  assert.equal(of(file("b.ts", "B1"), file("z.ts", "Z1"), file("a.ts")), withUntracked);
  assert.notEqual(of(file("a.ts"), file("z.ts", "Z2"), file("b.ts", "B1")), withUntracked);
  assert.notEqual(of(file("a.ts"), file("y.ts", "Z1"), file("b.ts", "B1")), withUntracked);
  // A file-mode desk on a new file: no raw diff at all, just the one whole file.
  const fileDesk = (contentHash: string) =>
    baseDiffHashOf({ rawDiff: "", parsedDiff: [], files: [file("plan.md", contentHash)] });
  assert.notEqual(fileDesk("P1"), hash(""));
  assert.notEqual(fileDesk("P1"), fileDesk("P2"));
});

// A committed a.txt in a fresh repo; buildReviewState persists nothing, so the tree holds only
// what each test writes.
async function withHashRepo(run: (dir: string) => Promise<void>) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "galley-basehash-")));
  const gitq = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  try {
    gitq("init", "-q");
    gitq("config", "user.email", "t@t.co");
    gitq("config", "user.name", "t");
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
    gitq("add", "-A");
    gitq("commit", "-q", "-m", "init");
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const buildRepoDesk = async (dir: string) =>
  (await buildReviewState(dir, { session: "s", allowEmpty: true }))!;

test("a repo desk without untracked files hashes exactly its raw diff; the same tree hashes the same", async () => {
  await withHashRepo(async (dir) => {
    await fs.writeFile(path.join(dir, "a.txt"), "one\nTWO\n");
    const st = await buildRepoDesk(dir);
    assert.ok(st.rawDiff.includes("+TWO"));
    assert.equal(st.baseDiffHash, hash(st.rawDiff));
    await fs.writeFile(path.join(dir, "n1.txt"), "n1\n");
    await fs.writeFile(path.join(dir, "n2.txt"), "n2\n");
    const once = await buildRepoDesk(dir);
    assert.equal((await buildRepoDesk(dir)).baseDiffHash, once.baseDiffHash);
  });
});

test("adding or editing only an untracked file moves a repo desk's baseDiffHash", async () => {
  await withHashRepo(async (dir) => {
    await fs.writeFile(path.join(dir, "a.txt"), "one\nTWO\n");
    const before = await buildRepoDesk(dir);
    await fs.writeFile(path.join(dir, "new.txt"), "first\n");
    const added = await buildRepoDesk(dir);
    assert.equal(added.rawDiff, before.rawDiff, "git diff doesn't see the untracked file");
    assert.ok(added.files.some((f) => f.path === "new.txt"));
    assert.notEqual(added.baseDiffHash, before.baseDiffHash);
    await fs.writeFile(path.join(dir, "new.txt"), "second\n");
    const edited = await buildRepoDesk(dir);
    assert.equal(edited.rawDiff, added.rawDiff);
    assert.notEqual(edited.baseDiffHash, added.baseDiffHash);
  });
});

test("a plain mv moves a repo desk's baseDiffHash, even when it leaves the raw diff as it was", async () => {
  await withHashRepo(async (dir) => {
    const clean = await buildRepoDesk(dir);
    await fs.rename(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
    const moved = await buildRepoDesk(dir);
    assert.ok(moved.files.some((f) => f.path === "b.txt" && f.renamePure));
    assert.notEqual(moved.baseDiffHash, clean.baseDiffHash);
    // Moved on again: the raw diff still only deletes a.txt; the paired rename's new path moved.
    await fs.rename(path.join(dir, "b.txt"), path.join(dir, "c.txt"));
    const movedAgain = await buildRepoDesk(dir);
    assert.ok(movedAgain.files.some((f) => f.path === "c.txt" && f.renamePure));
    assert.equal(movedAgain.rawDiff, moved.rawDiff);
    assert.notEqual(movedAgain.baseDiffHash, moved.baseDiffHash);
  });
});

test("a file desk on an untracked file moves its baseDiffHash on every edit", async () => {
  await withHashRepo(async (dir) => {
    const plan = path.join(dir, "plan.md");
    const build = async () =>
      (await buildReviewState(dir, { mode: "file", path: plan, session: "s" }))!;
    await fs.writeFile(plan, "# Plan\n");
    const first = await build();
    await fs.writeFile(plan, "# Plan\n\n- step 1\n");
    const edited = await build();
    assert.equal(edited.rawDiff, "");
    assert.notEqual(edited.baseDiffHash, first.baseDiffHash);
  });
});

// ── UI annotations ──────────────────────────────────────────────────────────────────────────────
function uiElement(over: Partial<UiElement> = {}): UiElement {
  return {
    selector: 'button[data-testid="upload"]',
    tag: "button",
    text: "Upload",
    role: "button",
    name: "Upload",
    rect: { x: 10, y: 20, width: 90, height: 32 },
    ...over,
  };
}
function annotation(over: Partial<UiAnnotationRecord> & { id: string }): UiAnnotationRecord {
  return {
    number: 1,
    intent: "change",
    status: "open",
    placement: "placed",
    page: {
      url: "http://localhost:3000/app/files?tab=all",
      route: "/app/files?tab=all",
      title: "Files",
      viewport: { width: 1440, height: 900, dpr: 2 },
    },
    target: { kind: "element", elements: [uiElement()] },
    comments: [
      {
        id: `${over.id}-m1`,
        role: "user",
        intent: "action",
        body: "Make Upload the primary button",
        createdAt: "2026-10-13T10:00:00.000Z",
        updatedAt: "2026-10-13T10:00:00.000Z",
      },
    ],
    ...over,
  };
}

test("buildReviewResult sends open UI change requests as uiAnnotations, with the UI target", () => {
  const replied = annotation({ id: "a2", number: 2 });
  replied.comments.push({
    id: "a2-m2",
    role: "user",
    intent: "action",
    body: "and make it blue",
    createdAt: "2026-10-13T10:05:00.000Z",
    updatedAt: "2026-10-13T10:05:00.000Z",
  });
  const s = state({
    ui: { target: "http://localhost:3000/sign-in" },
    annotations: [annotation({ id: "a1" }), replied, annotation({ id: "a3", status: "resolved" })],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.equal(r.uiTarget, "http://localhost:3000/sign-in");
  assert.deepEqual(
    r.uiAnnotations.map((a) => a.id),
    ["a1", "a2"],
    "the resolved annotation is not sent",
  );
  assert.deepEqual(r.uiAnnotations[0], {
    id: "a1",
    number: 1,
    body: "Make Upload the primary button",
    status: "open",
    placement: "placed",
    page: {
      url: "http://localhost:3000/app/files?tab=all",
      route: "/app/files?tab=all",
      title: "Files",
      viewport: { width: 1440, height: 900, dpr: 2 },
    },
    target: { kind: "element", elements: [uiElement()] },
    thread: [],
  });
  assert.deepEqual(r.uiAnnotations[1]!.thread, [
    { role: "user", body: "and make it blue", at: "2026-10-13T10:05:00.000Z" },
  ]);
  assert.ok(!("requestedChanges" in r), "the old field name is gone");
});

test("buildReviewResult makes source files inside the repo repo-relative and leaves out any other", () => {
  const sourced = (file: string) =>
    uiElement({ source: { file, line: 20, column: 7, component: "files", via: "vue-tracer" } });
  const s = state({
    root: "/home/dev/shop",
    ui: { target: "http://localhost:3000/" },
    annotations: [
      annotation({
        id: "a1",
        target: {
          kind: "element",
          elements: [
            sourced("/home/dev/shop/apps/web/app/pages/files.vue"),
            sourced("/home/dev/other/Panel.vue"),
            sourced("/home/dev/shop-old/Panel.vue"),
            sourced("/home/dev/shop/../other/Panel.vue"),
            sourced("app/pages/files.vue"),
            sourced("./app/../app/pages/files.vue"),
            sourced("../../../etc/passwd"),
            uiElement(),
          ],
        },
      }),
    ],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(
    r.uiAnnotations[0]!.target.elements.map((el) => el.source?.file),
    [
      "apps/web/app/pages/files.vue",
      undefined,
      undefined,
      undefined,
      "app/pages/files.vue",
      "app/pages/files.vue",
      undefined,
      undefined,
    ],
  );
  assert.deepEqual(r.uiAnnotations[0]!.target.elements[0]!.source, {
    file: "apps/web/app/pages/files.vue",
    line: 20,
    column: 7,
    component: "files",
    via: "vue-tracer",
  });
  // A page can name any path, and the agent opens what it's handed: outside the repo, only what
  // doesn't point at a file stays.
  assert.deepEqual(r.uiAnnotations[0]!.target.elements[1]!.source, {
    component: "files",
    via: "vue-tracer",
  });
  const vendored = buildReviewResult(
    state({
      root: "/home/dev/shop",
      ui: { target: "http://localhost:3000/" },
      annotations: [
        annotation({
          id: "a2",
          target: {
            kind: "element",
            elements: [
              uiElement({ source: { file: "/opt/ui/Btn.vue", vendor: true, via: "vue-file" } }),
            ],
          },
        }),
      ],
    }),
    { resultJson: "r.json", sessionDir: "d" },
  );
  assert.deepEqual(vendored.uiAnnotations[0]!.target.elements[0]!.source, {
    vendor: true,
    via: "vue-file",
  });
  assert.equal(
    s.annotations![0]!.target.elements[0]!.source!.file,
    "/home/dev/shop/apps/web/app/pages/files.vue",
    "the stored annotation keeps the path the page gave",
  );
});

test("buildReviewResult makes Windows source paths repo-relative under a Windows root", () => {
  const sourced = (file: string) => uiElement({ source: { file, via: "vue-file" } });
  const files = [
    "C:/proj/src/a.vue",
    String.raw`C:\proj\src\a.vue`,
    "c:/proj/src/a.vue",
    "D:/proj/src/a.vue",
    String.raw`C:\proj-old\a.vue`,
  ];
  const s = state({
    root: String.raw`C:\proj`,
    ui: { target: "http://localhost:3000/" },
    annotations: [
      annotation({ id: "a1", target: { kind: "element", elements: files.map(sourced) } }),
    ],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(
    r.uiAnnotations[0]!.target.elements.map((el) => el.source?.file),
    ["src/a.vue", "src/a.vue", "src/a.vue", undefined, undefined],
  );
});

test("buildReviewResult on a UI-only desk sends empty code fields alongside the annotations", () => {
  const s = state({
    ui: { target: "http://localhost:3000/" },
    annotations: [annotation({ id: "a1" })],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(r.codeChangeRequests, []);
  assert.deepEqual(r.accepted, []);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.approvedFiles, []);
  assert.deepEqual(r.stagedFiles, []);
  assert.deepEqual(r.openQuestions, []);
  assert.equal(r.uiAnnotations.length, 1);
});

test("buildReviewResult gives an annotation's stored screenshots as absolute paths that exist", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "galley-shots-"));
  try {
    const dir = path.join(sessionDir, "ui-shots");
    await fs.mkdir(dir);
    for (const kind of ["crop", "viewport"])
      await fs.writeFile(path.join(dir, `a1-${kind}.png`), "png");
    const s = state({
      ui: UI,
      annotations: [annotation({ id: "a1", screenshots: true }), annotation({ id: "a2" })],
    });
    const r = buildReviewResult(s, { resultJson: path.join(sessionDir, "r.json"), sessionDir });
    const shots = r.uiAnnotations[0]!.screenshots!;
    assert.deepEqual(shots, {
      crop: path.join(sessionDir, "ui-shots", "a1-crop.png"),
      viewport: path.join(sessionDir, "ui-shots", "a1-viewport.png"),
      exact: false,
    });
    for (const file of [shots.crop, shots.viewport]) {
      assert.ok(path.isAbsolute(file), file);
      await fs.access(file);
    }
    assert.ok(!("screenshots" in r.uiAnnotations[1]!), "no screenshots without a stored pair");
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("buildReviewResult leaves out screenshots whose files are gone from disk", async () => {
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "galley-shots-"));
  try {
    const dir = path.join(sessionDir, "ui-shots");
    await fs.mkdir(dir);
    // a1 lost its viewport image; a2 lost both (ui-shots/ emptied by hand). Both are still marked.
    await fs.writeFile(path.join(dir, "a1-crop.png"), "png");
    const s = state({
      ui: UI,
      annotations: [
        annotation({ id: "a1", screenshots: true }),
        annotation({ id: "a2", screenshots: true }),
      ],
    });
    const r = buildReviewResult(s, { resultJson: path.join(sessionDir, "r.json"), sessionDir });
    assert.deepEqual(
      r.uiAnnotations.map((a) => "screenshots" in a),
      [false, false],
    );
  } finally {
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test("mergeReviewerSave keeps the server's screenshot mark by id and never takes the tab's", async () => {
  const live = state({
    ui: UI,
    annotations: [annotation({ id: "a1", screenshots: true }), annotation({ id: "a2" })],
  });
  // The tab's copies: a1 without the mark (a tab that never saw it), a2 claiming one.
  await mergeReviewerSave(live, {
    annotations: [annotation({ id: "a1" }), annotation({ id: "a2", screenshots: true })],
  });
  assert.deepEqual(
    live.annotations!.map((a) => [a.id, a.screenshots]),
    [
      ["a1", true],
      ["a2", undefined],
    ],
  );
});

test("buildReviewResult without a UI lane sends no uiTarget and an empty uiAnnotations", () => {
  const r = buildReviewResult(state({}), { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(r.uiAnnotations, []);
  assert.equal(r.uiTarget, undefined);
});

test("mergeReviewState carries annotations and their number mark across a reload and a restart", async () => {
  const saved = state({ annotations: [annotation({ id: "a1" })], lastAnnotationNumber: 4 });
  const merged = await mergeReviewState(state({ baseDiffHash: "new" }), saved);
  assert.deepEqual(merged.annotations, [annotation({ id: "a1", placement: "unvisited" })]);
  assert.equal(merged.lastAnnotationNumber, 4);
});

test("a reload or a restart leaves every annotation unvisited until its page loads again", async () => {
  const saved = state({
    annotations: [
      annotation({ id: "placed" }),
      annotation({ id: "unplaced", placement: "unplaced" }),
      annotation({ id: "resolved", status: "resolved" }),
      annotation({ id: "page", target: { kind: "page" } }),
    ],
  });
  const merged = await mergeReviewState(state({ baseDiffHash: "new" }), saved);
  assert.deepEqual(
    merged.annotations!.map((a) => [a.id, a.placement]),
    [
      ["placed", "unvisited"],
      ["unplaced", "unvisited"],
      ["resolved", "unvisited"],
      ["page", "unvisited"],
    ],
  );
  assert.equal(saved.annotations![0]!.placement, "placed", "the saved review isn't touched");
});

test("a reviewer save stamped before the desk's latest reload keeps the desk's placements", async () => {
  const desk = { token: "t2", reloadGeneration: 3 };
  const live = () =>
    state({ ui: UI, annotations: [annotation({ id: "a1", placement: "unvisited" })] });
  const sent = [
    annotation({ id: "a1", placement: "placed" }),
    annotation({ id: "a2", number: 2, placement: "placed" }),
  ];
  const placements = (s: ReviewState) => s.annotations!.map((a) => [a.id, a.placement]);
  for (const seen of [
    { token: "t2", reloadGeneration: 2 },
    { token: "t1", reloadGeneration: 3 },
  ]) {
    const s = live();
    await mergeReviewerSave(s, { annotations: sent, seen }, desk);
    assert.deepEqual(
      placements(s),
      [
        ["a1", "unvisited"],
        ["a2", "placed"],
      ],
      "the stored one keeps the desk's; a new one takes the tab's",
    );
  }
  const current = live();
  await mergeReviewerSave(current, { annotations: sent, seen: desk }, desk);
  assert.deepEqual(placements(current), [
    ["a1", "placed"],
    ["a2", "placed"],
  ]);
});

test("each annotation's placement persists through a reviewer save and the saved review", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "galley-placement-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const live = state({ root: home, ui: UI, annotations: [annotation({ id: "a1" })] });
    await mergeReviewerSave(live, {
      annotations: [
        annotation({ id: "a1", placement: "unplaced" }),
        annotation({ id: "a2", number: 2 }),
        annotation({ id: "a3", number: 3, placement: "unvisited" }),
      ],
    });
    await persistReview(live);
    const saved = await loadLatestReview(home, "s");
    assert.deepEqual(
      saved!.annotations!.map((a) => [a.id, a.placement]),
      [
        ["a1", "unplaced"],
        ["a2", "placed"],
        ["a3", "unvisited"],
      ],
    );
  } finally {
    process.env.HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

// The desk's app, which every saved page.url is rebuilt on.
const UI = { target: "http://localhost:3000/sign-in?as=reviewer" };

test("mergeReviewerSave stores well-formed annotations as sent", async () => {
  const live = state({ ui: UI });
  await mergeReviewerSave(live, { annotations: [annotation({ id: "a1" })] });
  assert.deepEqual(live.annotations, [annotation({ id: "a1" })]);
});

test("a UI change request turned into a question is saved with its asked time, asked, and no longer sent", async () => {
  const live = state({ ui: UI });
  const a = annotation({ id: "a1" });
  a.comments.push({
    id: "a1-r1",
    role: "agent",
    intent: "note",
    body: "Done",
    createdAt: "2026-10-13T10:01:00.000Z",
    updatedAt: "2026-10-13T10:01:00.000Z",
  });
  const asked = {
    ...a,
    intent: "question" as const,
    comments: [
      { ...a.comments[0]!, intent: "question" as const, askedAt: "2026-10-13T10:05:00.000Z" },
      a.comments[1]!,
    ],
  };
  await mergeReviewerSave(live, { annotations: [asked] });
  assert.equal(live.annotations![0]!.comments[0]!.askedAt, "2026-10-13T10:05:00.000Z");
  const r = buildReviewResult(live, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(r.uiAnnotations, []);
  assert.deepEqual(
    r.openQuestions.map((q) => q.lane === "ui" && q.annotationId),
    ["a1"],
    "the reply from before the turn doesn't answer it",
  );
  // Turned back, it's a change request again.
  await mergeReviewerSave(live, { annotations: [a] });
  const back = buildReviewResult(live, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(
    back.uiAnnotations.map((x) => x.id),
    ["a1"],
  );
  assert.deepEqual(back.openQuestions, []);
});

test("mergeReviewerSave truncates oversized page data to the caps", async () => {
  const live = state({ ui: UI });
  const attrs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`data-k${i}`, "v"]));
  await mergeReviewerSave(live, {
    annotations: [
      annotation({
        id: "a1",
        page: {
          url: `http://localhost:3000/${"u".repeat(3000)}`,
          route: `/${"r".repeat(3000)}`,
          title: "T".repeat(400),
          viewport: { width: 1440, height: 900, dpr: 2 },
        },
        target: {
          kind: "element",
          elements: [
            uiElement({
              text: "x".repeat(1000),
              name: "n".repeat(500),
              role: "r".repeat(500),
              landmark: "l".repeat(500),
              heading: "h".repeat(500),
              outline: "<div>".repeat(1000),
              attrs: { ...attrs, href: "h".repeat(900) },
            }),
          ],
        },
      }),
    ],
  });
  const a = live.annotations![0]!;
  const el = a.target.elements[0]!;
  assert.equal(a.page.url.length, 2048);
  assert.equal(a.page.route.length, 2048);
  assert.equal(a.page.title!.length, 300);
  assert.equal(el.text!.length, 300);
  assert.ok(el.text!.endsWith("…"), "a cut string says so");
  assert.equal(el.name!.length, 200);
  assert.equal(el.role!.length, 200);
  assert.equal(el.landmark!.length, 200);
  assert.equal(el.heading!.length, 200);
  assert.equal(el.outline!.length, 2048);
  assert.equal(Object.keys(el.attrs!).length, 12);
  assert.ok(Object.values(el.attrs!).every((v) => v.length <= 200));
});

test("mergeReviewerSave drops malformed annotations and elements, keeping the rest", async () => {
  const live = state({ ui: UI });
  const good = annotation({ id: "good" });
  const element = (over: Record<string, unknown>) => ({ kind: "element", elements: [over] });
  await mergeReviewerSave(live, {
    annotations: [
      good,
      "not an object",
      { ...annotation({ id: "no-target" }), target: undefined },
      {
        ...annotation({ id: "abs-route" }),
        page: { ...good.page, route: "https://evil.example/" },
      },
      {
        ...annotation({ id: "long-sel" }),
        target: element(uiElement({ selector: "x".repeat(600) })),
      },
      { ...annotation({ id: "bad-rect" }), target: element({ ...uiElement(), rect: { x: "1" } }) },
      { ...annotation({ id: "bad-tag" }), target: element(uiElement({ tag: "<script>" })) },
      { ...annotation({ id: "bad-status" }), status: "deleted" },
      { ...annotation({ id: "bad-placement" }), placement: "lost" },
      { ...annotation({ id: "no-body" }), comments: [] },
      { ...annotation({ id: "bad-vp" }), page: { ...good.page, viewport: { width: -1 } } },
      annotation({ id: 'q"x' }), // ids end up in attributes: word characters only
      {
        ...annotation({ id: "odd-message-id" }),
        comments: [{ ...good.comments[0]!, id: 'm" onclick="x' }],
      },
      {
        ...annotation({ id: "odd-attrs" }),
        target: element(uiElement({ attrs: { "on click": "x" } })),
      },
      annotation({ id: "good" }), // a duplicate id
      annotation({
        id: "many",
        target: { kind: "element", elements: Array.from({ length: 17 }, () => uiElement()) },
      }),
    ],
  });
  assert.deepEqual(
    live.annotations!.map((a) => a.id),
    ["good", "odd-attrs", "many"],
  );
  assert.deepEqual(live.annotations![1]!.target.elements[0]!.attrs, {}, "odd attr names dropped");
  assert.equal(live.annotations![2]!.target.elements.length, 16, "elements capped at 16");
});

test("mergeReviewerSave keeps an element's source within the caps and drops a malformed one", async () => {
  const live = state({ ui: UI });
  const source = {
    file: "/home/dev/shop/apps/web/app/pages/files.vue",
    line: 20,
    column: 7,
    component: "files",
    vendor: true,
    via: "vue-tracer",
  } as const;
  const withSource = (id: string, s: unknown) =>
    annotation({
      id,
      target: { kind: "element", elements: [{ ...uiElement(), source: s } as UiElement] },
    });
  await mergeReviewerSave(live, {
    annotations: [
      withSource("ok", source),
      withSource("long-name", { ...source, component: "c".repeat(500) }),
      withSource("long-file", { ...source, file: "f".repeat(1025) }),
      withSource("bad-via", { ...source, via: "guess" }),
      withSource("bad-line", { ...source, line: -1 }),
      withSource("control", { ...source, file: "a.vue\u0000" }),
    ],
  });
  const sources = live.annotations!.map((a) => a.target.elements[0]!.source);
  assert.deepEqual(sources[0], source);
  assert.equal(sources[1]!.component!.length, 200);
  assert.deepEqual(sources.slice(2), [undefined, undefined, undefined, undefined]);
  assert.equal(live.annotations!.length, 6, "a bad source drops only the source");
});

test("mergeReviewerSave ignores an annotations field that isn't an array", async () => {
  const live = state({ annotations: [annotation({ id: "a1" })] });
  await mergeReviewerSave(live, { annotations: "nope" });
  assert.equal(live.annotations!.length, 1);
});

test("mergeReviewerSave rebuilds page.url on the UI target's origin and drops a route that leaves it", async () => {
  const live = state({ ui: UI });
  const page = (route: string, url = `http://localhost:3000${route}`) => ({
    ...annotation({ id: "x" }).page,
    route,
    url,
  });
  await mergeReviewerSave(live, {
    annotations: [
      { ...annotation({ id: "lying-url" }), page: page("/app", "http://evil.example/app") },
      // The URL parser reads a backslash as a slash: this route is `//evil.example/x`.
      { ...annotation({ id: "backslash" }), page: page(String.raw`/\evil.example/x`) },
      { ...annotation({ id: "control" }), page: page("/app\nx") },
      // A backslash after the path is query data, not a slash.
      { ...annotation({ id: "query" }), page: page(String.raw`/search?q=a\b`) },
    ],
  });
  assert.deepEqual(
    live.annotations!.map((a) => [a.id, a.page.url]),
    [
      ["lying-url", "http://localhost:3000/app"],
      ["query", String.raw`http://localhost:3000/search?q=a\b`],
    ],
  );
  const noApp = state({});
  await mergeReviewerSave(noApp, { annotations: [annotation({ id: "a1" })] });
  assert.deepEqual(noApp.annotations, [], "without a UI target there is no origin to check");
});

test("mergeReviewerSave never lowers the annotation number mark", async () => {
  const live = state({ ui: UI, lastAnnotationNumber: 5 });
  // A stale tab posts an older mark: the mark stays.
  await mergeReviewerSave(live, {
    annotations: [annotation({ id: "a1", number: 2 })],
    lastAnnotationNumber: 3,
  });
  assert.equal(live.lastAnnotationNumber, 5);
  // A number in use above the mark raises it, whatever the save says.
  await mergeReviewerSave(live, { annotations: [annotation({ id: "a7", number: 7 })] });
  assert.equal(live.lastAnnotationNumber, 7);
  await mergeReviewerSave(live, { lastAnnotationNumber: "9" });
  assert.equal(live.lastAnnotationNumber, 7, "a mark that isn't a whole number is ignored");
});

// A UI question: an annotation whose opening message asks rather than requests.
function question(over: Partial<UiAnnotationRecord> & { id: string }): UiAnnotationRecord {
  return annotation({
    intent: "question",
    comments: [
      {
        id: `${over.id}-m1`,
        role: "user",
        intent: "question",
        body: "Why is Upload grey?",
        createdAt: "2026-10-13T10:00:00.000Z",
        updatedAt: "2026-10-13T10:00:00.000Z",
      },
    ],
    ...over,
  });
}
const agentReply = (id: string, at: string) => ({
  id,
  role: "agent" as const,
  intent: "note" as const,
  body: "Because it's disabled until a file is picked.",
  createdAt: at,
  updatedAt: at,
});

test("buildReviewResult.openQuestions carries unanswered UI questions, lane-tagged; answered and resolved ones stay out", () => {
  const answered = question({ id: "q2", number: 2 });
  answered.comments.push(agentReply("q2-r", "2026-10-13T10:01:00.000Z"));
  // A question asked in a change request's thread is a question too.
  const change = annotation({ id: "c3", number: 3 });
  change.comments.push({
    id: "c3-m2",
    role: "user",
    intent: "question",
    body: "Or should it be a link?",
    createdAt: "2026-10-13T10:02:00.000Z",
    updatedAt: "2026-10-13T10:02:00.000Z",
  });
  const s = state({
    session: "sess",
    ui: UI,
    annotations: [
      question({ id: "q1", number: 1 }),
      answered,
      change,
      question({ id: "q4", number: 4, status: "resolved" }),
    ],
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(r.openQuestions, [
    {
      lane: "ui",
      annotationId: "q1",
      number: 1,
      route: "/app/files?tab=all",
      body: "Why is Upload grey?",
      target: 'button · "Upload"',
      mode: "repo",
      session: "sess",
    },
    {
      lane: "ui",
      annotationId: "c3",
      number: 3,
      route: "/app/files?tab=all",
      body: "Or should it be a link?",
      target: 'button · "Upload"',
      mode: "repo",
      session: "sess",
    },
  ]);
  assert.deepEqual(
    r.uiAnnotations.map((a) => a.id),
    ["c3"],
    "questions are never sent as change requests",
  );
});

test("a UI question whose thread requests a change is sent in uiAnnotations, as the code lane sends that request", () => {
  const requested = question({ id: "q1" });
  requested.comments.push(agentReply("q1-r", "2026-10-13T10:01:00.000Z"), {
    id: "q1-m3",
    role: "user",
    intent: "action",
    body: "Then hide it for a week after dismissal",
    createdAt: "2026-10-13T10:02:00.000Z",
    updatedAt: "2026-10-13T10:02:00.000Z",
  });
  const resolved = structuredClone({ ...requested, id: "q2", number: 2 });
  resolved.status = "resolved";
  const onlyAnswered = question({ id: "q3", number: 3 });
  onlyAnswered.comments.push(agentReply("q3-r", "2026-10-13T10:01:00.000Z"));
  const s = state({ ui: UI, annotations: [requested, resolved, onlyAnswered] });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(
    r.uiAnnotations.map((a) => [a.id, a.body, a.thread.map((m) => [m.role, m.body])]),
    [
      [
        "q1",
        "Why is Upload grey?",
        [
          ["agent", "Because it's disabled until a file is picked."],
          ["user", "Then hide it for a week after dismissal"],
        ],
      ],
    ],
  );
});

test("a UI question's target names the element, how many more were picked, and its source", () => {
  const s = state({
    root: "/home/dev/shop",
    ui: UI,
    annotations: [
      question({
        id: "q1",
        target: {
          kind: "element",
          elements: [
            uiElement({ role: undefined, name: undefined, tag: "td", text: "x".repeat(120) }),
            uiElement({ source: { file: "/etc/passwd", line: 1, via: "vue-tracer" } }),
            uiElement({
              source: {
                file: "/home/dev/shop/apps/web/app/pages/files.vue",
                line: 20,
                via: "vue-tracer",
              },
            }),
          ],
        },
      }),
    ],
  });
  const [q] = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" }).openQuestions;
  assert.equal(
    q!.lane === "ui" && q!.target,
    `td · "${"x".repeat(79)}…" · +2 more · apps/web/app/pages/files.vue:20`,
  );
});

// ── Target kinds ────────────────────────────────────────────────────────────────────────────────
const SRC = {
  file: "/home/dev/shop/apps/web/app/pages/files.vue",
  line: 84,
  via: "vue-tracer",
} as const;
const REGION = { x: 10, y: 20, width: 320, height: 180 };
const KINDS: Record<string, UiAnnotationRecord["target"]> = {
  element: { kind: "element", elements: [uiElement(), uiElement({ selector: "#cancel" })] },
  region: { kind: "region", rect: REGION, elements: [uiElement({ source: SRC })] },
  bare: { kind: "region", rect: REGION, elements: [] },
  text: {
    kind: "text",
    quote: "Date recieved",
    element: uiElement({ selector: "#received", tag: "th", role: "columnheader", source: SRC }),
  },
  page: { kind: "page" },
};

test("every target kind is stored as saved and sent with its source files repo-relative", async () => {
  const live = state({ root: "/home/dev/shop", ui: UI });
  const sent = Object.entries(KINDS).map(([id, target]) => annotation({ id, target }));
  await mergeReviewerSave(live, { annotations: structuredClone(sent) });
  assert.deepEqual(live.annotations, sent);
  const r = buildReviewResult(live, { resultJson: "r.json", sessionDir: "d" });
  const repoSource = { ...SRC, file: "apps/web/app/pages/files.vue" };
  assert.deepEqual(
    r.uiAnnotations.map((a) => a.target),
    [
      KINDS.element,
      { kind: "region", rect: REGION, elements: [uiElement({ source: repoSource })] },
      KINDS.bare,
      {
        kind: "text",
        quote: "Date recieved",
        element: uiElement({
          selector: "#received",
          tag: "th",
          role: "columnheader",
          source: repoSource,
        }),
      },
      { kind: "page" },
    ],
  );
});

test("mergeReviewerSave drops a malformed target of any kind and caps a quote and a region's elements", async () => {
  const live = state({ ui: UI });
  const bad: Array<[string, unknown]> = [
    ["no-rect", { kind: "region", elements: [] }],
    ["flat-rect", { kind: "region", rect: { ...REGION, height: 0 }, elements: [] }],
    ["odd-rect", { kind: "region", rect: { ...REGION, x: "10" }, elements: [] }],
    ["no-quote", { kind: "text", element: uiElement() }],
    ["blank-quote", { kind: "text", quote: "  ", element: uiElement() }],
    ["odd-quote", { kind: "text", quote: ["Due"], element: uiElement() }],
    ["no-holder", { kind: "text", quote: "Due" }],
    ["bad-holder", { kind: "text", quote: "Due", element: uiElement({ tag: "<b>" }) }],
    ["no-elements", { kind: "element", elements: [uiElement({ selector: "" })] }],
    ["canvas", { kind: "canvas", rect: REGION }],
    ["no-kind", { rect: REGION, elements: [] }],
  ];
  await mergeReviewerSave(live, {
    annotations: [
      ...bad.map(([id, target]) => ({ ...annotation({ id }), target })),
      annotation({
        id: "long",
        target: { kind: "text", quote: "q".repeat(900), element: uiElement() },
      }),
      annotation({
        id: "crowded",
        target: {
          kind: "region",
          rect: REGION,
          elements: [uiElement({ tag: "<b>" }), ...Array.from({ length: 20 }, () => uiElement())],
        },
      }),
      { ...annotation({ id: "page" }), target: { kind: "page", elements: [uiElement()] } },
    ],
  });
  assert.deepEqual(
    live.annotations!.map((a) => a.id),
    ["long", "crowded", "page"],
  );
  const [long, crowded, page] = live.annotations!;
  assert.ok(long!.target.kind === "text");
  assert.equal(long!.target.quote.length, 500);
  assert.ok(long!.target.quote.endsWith("…"));
  assert.ok(crowded!.target.kind === "region");
  assert.equal(crowded!.target.elements.length, 16, "a bad element dropped, the rest capped");
  assert.deepEqual(page!.target, { kind: "page" }, "a page target carries nothing else");
});

test("a UI question's target summary says what kind of thing it points at", () => {
  const s = state({
    root: "/home/dev/shop",
    ui: UI,
    annotations: Object.entries(KINDS).map(([id, target], i) =>
      question({ id, number: i + 1, target }),
    ),
  });
  const r = buildReviewResult(s, { resultJson: "r.json", sessionDir: "d" });
  assert.deepEqual(
    r.openQuestions.map((q) => q.lane === "ui" && [q.annotationId, q.target]),
    [
      ["element", 'button · "Upload" · +1 more'],
      ["region", 'region 320×180 · button · "Upload" · apps/web/app/pages/files.vue:84'],
      ["bare", "region 320×180"],
      ["text", 'text "Date recieved" in columnheader · apps/web/app/pages/files.vue:84'],
      ["page", "the whole page"],
    ],
  );
});

test("mergeReviewerSave keeps agent replies a save from a tab that hasn't seen them leaves out", async () => {
  const replied = question({ id: "q1" });
  replied.comments.push(agentReply("r1", "2026-10-13T10:01:00.000Z"));
  const gone = question({ id: "q2", number: 2 });
  gone.comments.push(agentReply("r2", "2026-10-13T10:01:00.000Z"));
  const live = state({ ui: UI, annotations: [replied, gone] });
  // The tab's copy: q1 without the agent's reply but with a new message of the reviewer's, and q2
  // deleted.
  const tabCopy = question({ id: "q1" });
  tabCopy.comments.push({
    id: "m2",
    role: "user",
    intent: "action",
    body: "Make it blue as well",
    createdAt: "2026-10-13T10:02:00.000Z",
    updatedAt: "2026-10-13T10:02:00.000Z",
  });
  await mergeReviewerSave(live, { annotations: [tabCopy] });
  assert.deepEqual(
    live.annotations!.map((a) => [a.id, a.intent, a.comments.map((m) => m.id)]),
    [["q1", "question", ["q1-m1", "m2", "r1"]]],
  );
  // A tab that has the reply saves it once.
  await mergeReviewerSave(live, { annotations: structuredClone(live.annotations) });
  assert.deepEqual(
    live.annotations![0]!.comments.map((m) => m.id),
    ["q1-m1", "m2", "r1"],
  );
});

test("appendAnnotationReply adds the agent's reply to the saved review's annotation, and refuses an unknown id", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "galley-reply-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await persistReview(state({ root: home, ui: UI, annotations: [question({ id: "q1" })] }));
    const reply = await appendAnnotationReply(
      home,
      "s",
      "q1",
      "It's disabled until a file is picked.",
    );
    assert.equal(reply?.role, "agent");
    const saved = await loadLatestReview(home, "s");
    assert.deepEqual(
      saved!.annotations![0]!.comments.map((m) => [m.role, m.body]),
      [
        ["user", "Why is Upload grey?"],
        ["agent", "It's disabled until a file is picked."],
      ],
    );
    assert.equal(await appendAnnotationReply(home, "s", "nope", "hello"), null);
  } finally {
    process.env.HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

// ── The project the desk names (header + tab title) ──────────────────────────

// A scratch repo at <tmp>/<name> on branch main with one committed file. The folder name is the
// point: it's what the desk is expected to show.
async function scratchRepo(name: string) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "galley-project-"));
  const dir = path.join(parent, name);
  await fs.mkdir(dir);
  const gitq = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  gitq("init", "-q", "-b", "main");
  gitq("config", "user.email", "t@t.dev");
  gitq("config", "user.name", "t");
  await fs.writeFile(path.join(dir, "a.txt"), "a\n");
  gitq("add", "-A");
  gitq("commit", "-q", "-m", "init");
  return { parent, dir, gitq };
}

test("a desk in a linked worktree names the main worktree's folder, not the worktree's", async () => {
  const { parent, dir, gitq } = await scratchRepo("acme");
  try {
    const wt = path.join(parent, "acme-wt");
    gitq("worktree", "add", "-q", wt, "-b", "feature");
    await fs.writeFile(path.join(wt, "a.txt"), "A\n");
    const s = await buildReviewState(wt, { session: "s" });
    assert.equal(path.basename(s!.root), "acme-wt");
    assert.equal(s!.project, "acme");
    assert.equal(s!.branch, "feature");
    // File mode inside the worktree resolves the same project.
    const f = await buildReviewState(wt, { mode: "file", path: "a.txt", session: "s" });
    assert.equal(f!.project, "acme");
    // The main worktree names itself.
    await fs.writeFile(path.join(dir, "a.txt"), "B\n");
    const main = await buildReviewState(dir, { session: "s" });
    assert.equal(main!.project, "acme");
    assert.equal(main!.branch, "main");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a detached HEAD carries no branch", async () => {
  const { parent, dir, gitq } = await scratchRepo("acme");
  try {
    gitq("checkout", "-q", "--detach");
    await fs.writeFile(path.join(dir, "a.txt"), "A\n");
    const s = await buildReviewState(dir, { session: "s" });
    assert.equal(s!.project, "acme");
    assert.equal(s!.branch, undefined);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("galley file on a file outside any repo names the file's folder", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "galley-project-"));
  try {
    const notes = path.join(parent, "notes");
    await fs.mkdir(notes);
    await fs.writeFile(path.join(notes, "todo.md"), "# todo\n");
    const s = await buildReviewState(notes, { mode: "file", path: "todo.md", session: "s" });
    assert.equal(s!.project, "notes");
    assert.equal(s!.branch, undefined);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("a review saved before the project name loads, and gains it on reload", async () => {
  const { parent, dir } = await scratchRepo("acme");
  const oldHome = process.env.HOME;
  process.env.HOME = parent;
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "A\n");
    const built = await buildReviewState(dir, { session: "s" });
    const { project: _project, branch: _branch, ...older } = built!;
    await persistReview(older);
    const saved = await loadLatestReview(built!.root, "s");
    assert.ok(saved, "the older review loads");
    assert.equal(saved!.project, undefined);
    const merged = await mergeReviewState((await buildReviewState(dir, { session: "s" }))!, saved);
    assert.equal(merged.project, "acme");
    assert.equal(merged.branch, "main");
  } finally {
    process.env.HOME = oldHome;
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("mergeReviewState takes the project and branch from the rebuild, never the saved review", async () => {
  const merged = await mergeReviewState(
    state({ project: "acme" }),
    state({ project: "acme-old", branch: "gone" }),
  );
  assert.equal(merged.project, "acme");
  assert.equal(merged.branch, undefined);
});
