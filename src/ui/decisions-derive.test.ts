import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { diffAcceptRejectHunk, parseDiffFromFile } from "@pierre/diffs";
import {
  buildReviewResult,
  buildReviewState,
  mergeReviewerSave,
  readFileContents,
} from "../state.js";
import type { ChangeState, ReviewState } from "../types.js";
import {
  acceptSignedOffBlocks,
  captureFileReview,
  changeSpan,
  changeStableKey,
  clearFileReview,
  pendingChangeAt,
  recordDecision,
  restoreFileReview,
  signOff,
  signOffStep,
} from "./decisions-derive.js";
import { deriveFlowIndex } from "./flow-index.js";
import { reviewerSlice } from "./save.js";

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

test("a cleared file review restores exactly, leaving re-staging to the caller", async () => {
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
    // What to re-stage rides on the capture; the records wait for the index to take it.
    assert.equal(prior.staged, true);
    assert.deepEqual(prior.stagedChangeKeys, ["a.ts:additions:2:1:1"]);
    assert.deepEqual(state.stagedFiles, ["b.ts"]);
    assert.deepEqual(state.stagedChangeKeys, ["b.ts:additions:1:0:2"]);
  });
});

test("an untracked file signed off unopened accepts its block once opening derives it", async () => {
  await withRepo(async (state) => {
    const b = fileOf(state, "b.ts");
    signOff(state, b);
    assert.deepEqual(result(state).accepted, [], "no server block to accept at sign-off");
    // What opening it derives (changes.ts deriveChanges): one undecided block, with no server
    // contentHash to carry over.
    state.changes.push({
      id: "b.ts:additions:1:0:2",
      path: "b.ts",
      hunkIndex: 0,
      changeIndex: 0,
      stableKey: "additions:1:0:2",
      side: "additions",
      lineNumber: 1,
      endLine: 2,
      title: "0 removed · 2 added",
      status: "pending",
    });
    assert.equal(acceptSignedOffBlocks(state, b), true);
    assert.equal(state.changes.find((c) => c.path === "b.ts")?.status, "accepted");
    assert.deepEqual(result(state).accepted, [
      { path: "b.ts", lineNumber: 1, side: "additions", title: "0 removed · 2 added" },
    ]);
    assert.deepEqual(result(state).approvedFiles, ["b.ts"]);
    assert.equal(acceptSignedOffBlocks(state, b), false, "nothing left to accept");
  });
});

test("blocks of a file not signed off, or signed off against older content, stay pending", async () => {
  await withRepo(async (state) => {
    assert.equal(acceptSignedOffBlocks(state, fileOf(state, "a.ts")), false, "never signed off");
    const d = fileOf(state, "d.ts");
    signOff(state, d);
    state.reviewedFileHashes!["d.ts"] = "older-content";
    state.changes.find((c) => c.path === "d.ts")!.status = "pending";
    assert.equal(acceptSignedOffBlocks(state, d), false);
    assert.equal(state.changes.find((c) => c.path === "d.ts")?.status, "pending");
    assert.ok(state.changes.filter((c) => c.path === "a.ts").every((c) => c.status === "pending"));
  });
});

// The change under the cursor, in a file with an insertion, a replace and a deletion:
//   old: one two three four five six seven eight
//   new: one new-a new-b two three FOUR five six eight
// so in display lines the insertion is additions 2–3, the replace additions 6 / deletions 4, and
// the deletion deletions 7.
function cursorFile() {
  const diff = parseDiffFromFile(
    { name: "f.ts", contents: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n" },
    { name: "f.ts", contents: "one\nnew-a\nnew-b\ntwo\nthree\nFOUR\nfive\nsix\neight\n" },
  );
  const changes: ChangeState[] = [];
  diff.hunks.forEach((h, hunkIndex) =>
    h.hunkContent.forEach((part, changeIndex) => {
      if (part.type !== "change") return;
      changes.push({
        id: changeStableKey(part),
        path: "f.ts",
        hunkIndex,
        changeIndex,
        side: part.additions ? "additions" : "deletions",
        lineNumber: (part.additions ? part.additionLineIndex : part.deletionLineIndex) + 1,
        title: "",
        status: "pending",
      });
    }),
  );
  return { diff, changes };
}

test("a change's span covers its rows on each side it has rows on", () => {
  const { diff, changes } = cursorFile();
  assert.deepEqual(
    changes.map((c) => changeSpan(c, diff)),
    [
      { additions: [2, 3], deletions: null },
      { additions: [6, 6], deletions: [4, 4] },
      { additions: null, deletions: [7, 7] },
    ],
  );
});

test("the change under the cursor answers from any of its rows, a replace's deleted line too", () => {
  const { diff, changes } = cursorFile();
  const [insert, replace, remove] = changes;
  assert.equal(pendingChangeAt(changes, diff, "additions", 3), insert);
  assert.equal(pendingChangeAt(changes, diff, "additions", 6), replace);
  assert.equal(pendingChangeAt(changes, diff, "deletions", 4), replace, "its removed line");
  assert.equal(pendingChangeAt(changes, diff, "deletions", 7), remove);
  // The same numbers on the other side are other lines: additions 7 is "five", deletions 3 "three".
  assert.equal(pendingChangeAt(changes, diff, "additions", 7), null);
  assert.equal(pendingChangeAt(changes, diff, "deletions", 3), null);
});

test("a decided change folds away: it no longer answers, and the rows after it renumber", () => {
  const { diff, changes } = cursorFile();
  const [insert, replace] = changes;
  // Undo the insertion, as replayDecisions would: its two added lines leave the new side.
  insert.status = "rejected";
  const rendered = diffAcceptRejectHunk(diff, insert.hunkIndex, {
    type: "reject",
    changeIndex: insert.changeIndex,
  });
  assert.equal(pendingChangeAt(changes, rendered, "additions", 2), null, "the undone insertion");
  assert.deepEqual(changeSpan(replace, rendered), { additions: [4, 4], deletions: [4, 4] });
  assert.equal(pendingChangeAt(changes, rendered, "additions", 4), replace);
  assert.equal(pendingChangeAt(changes, rendered, "additions", 6), null);
});

test("a change not yet re-derived against the diff answers on its own side's line range", () => {
  const { diff, changes } = cursorFile();
  const [insert, replace] = changes;
  // As adopted from a poll: the server's blocks carry no change index until the next render.
  delete insert.changeIndex;
  delete replace.changeIndex;
  Object.assign(replace, { displayLineNumber: 6, displayEndLine: 6 });
  insert.endLine = 3;
  assert.deepEqual(changeSpan(insert, diff), { additions: [2, 3], deletions: null });
  assert.equal(pendingChangeAt(changes, diff, "additions", 3), insert, "its raw range");
  assert.equal(pendingChangeAt(changes, diff, "additions", 6), replace, "its display anchors");
  assert.equal(pendingChangeAt(changes, diff, "deletions", 4), null, "only its own side");
});

// a.ts split in two: part 1 is its first block, part 2 the other two.
const parts = (state: ReviewState) => {
  const blocks = state.changes.filter((c) => c.path === "a.ts");
  return [blocks.slice(0, 1), blocks.slice(1)] as const;
};
// What `galley await` hands the agent once the tab's save lands on the desk.
const delivered = async (desk: ReviewState, tab: ReviewState) => {
  await mergeReviewerSave(desk, reviewerSlice(tab));
  return result(desk).approvedFiles;
};

test("approving every part of a split file signs the file off, and await reports it approved", async () => {
  await withRepo(async (state) => {
    const desk = structuredClone(state);
    const a = fileOf(state, "a.ts");
    const [part1, part2] = parts(state);
    signOffStep(state, a, part1);
    let ix = deriveFlowIndex(state);
    assert.deepEqual(
      [
        ix.stepState({ path: "a.ts", blocks: part1 }),
        ix.stepState({ path: "a.ts", blocks: part2 }),
      ],
      ["approved", "pending"],
    );
    assert.equal(ix.reviewState("a.ts"), "pending", "a part alone doesn't sign the file off");
    assert.deepEqual(await delivered(desk, state), []);
    signOffStep(state, a, part2);
    ix = deriveFlowIndex(state);
    assert.equal(ix.reviewState("a.ts"), "approved");
    assert.deepEqual(await delivered(desk, state), ["a.ts"]);
  });
});

test("a split file with one part changes-requested is signed off but not approved", async () => {
  await withRepo(async (state) => {
    const desk = structuredClone(state);
    const a = fileOf(state, "a.ts");
    const [part1, part2] = parts(state);
    const rejected = part2[1]!;
    rejected.status = "rejected";
    rejected.reviewedHash = rejected.contentHash;
    recordDecision(state, rejected, "rejected");
    signOffStep(state, a, part1);
    signOffStep(state, a, part2);
    const ix = deriveFlowIndex(state);
    assert.deepEqual(
      [
        ix.stepState({ path: "a.ts", blocks: part1 }),
        ix.stepState({ path: "a.ts", blocks: part2 }),
      ],
      ["approved", "changes-requested"],
    );
    assert.equal(ix.reviewState("a.ts"), "changes-requested");
    assert.equal(rejected.status, "rejected", "a part's sign-off keeps its rejected block");
    assert.deepEqual(await delivered(desk, state), []);
  });
});

test("resetting a part clears its blocks and the file's sign-off, and restores exactly", async () => {
  await withRepo(async (state) => {
    const a = fileOf(state, "a.ts");
    const [part1, part2] = parts(state);
    signOffStep(state, a, part1);
    signOffStep(state, a, part2);
    state.stagedFiles = ["a.ts"];
    state.stagedChangeKeys = part2.map((c) => c.id);
    const slice = () =>
      structuredClone({
        changes: state.changes.map((c) => ({ id: c.id, status: c.status, h: c.reviewedHash })),
        decisions: [...(state.decisions ?? [])].sort((x, y) => x.key.localeCompare(y.key)),
        signedOffBlocks: state.signedOffBlocks,
        decisionFiles: [...(state.decisionFiles ?? [])].sort(),
        reviewedFiles: [...state.reviewedFiles].sort(),
        reviewedFileHashes: state.reviewedFileHashes,
      });
    const before = slice();

    const prior = captureFileReview(state, "a.ts", part2);
    clearFileReview(state, "a.ts", part2);
    const ix = deriveFlowIndex(state);
    assert.deepEqual(
      [
        ix.stepState({ path: "a.ts", blocks: part1 }),
        ix.stepState({ path: "a.ts", blocks: part2 }),
      ],
      ["approved", "pending"],
    );
    assert.equal(ix.reviewState("a.ts"), "pending");
    assert.deepEqual(
      state.decisions?.map((d) => d.key),
      part1.map((c) => c.id),
    );
    assert.ok(part2.every((c) => c.status === "pending"));
    assert.deepEqual(state.decisionFiles, ["a.ts"], "part 1's decision keeps the file decided");
    assert.deepEqual(state.stagedChangeKeys, []);
    assert.deepEqual(state.stagedFiles, ["a.ts"], "the file's staging record is the file's");
    assert.deepEqual(
      prior.stagedChangeKeys,
      part2.map((c) => c.id),
    );
    assert.equal(prior.staged, false);

    restoreFileReview(state, prior);
    assert.deepEqual(slice(), before);
    assert.equal(deriveFlowIndex(state).reviewState("a.ts"), "approved");
  });
});

test("a whole-file sign-off signs off every block, and the file's Reset clears them", async () => {
  await withRepo(async (state) => {
    const [part1, part2] = parts(state);
    signOff(state, fileOf(state, "a.ts"));
    assert.ok([...part1, ...part2].every((c) => state.signedOffBlocks?.[c.id] === c.contentHash));
    clearFileReview(state, "a.ts");
    assert.deepEqual(state.signedOffBlocks, {});
    assert.equal(deriveFlowIndex(state).stepState({ path: "a.ts", blocks: part1 }), "pending");
  });
});

test("the last in-flow part's sign-off signs off a fully skimmed part too, and the file", async () => {
  await withRepo(async (state) => {
    const desk = structuredClone(state);
    const a = fileOf(state, "a.ts");
    // Part 2 is fully skimmed: out of the flow, never put to the reviewer.
    const [part1, part2] = parts(state);
    signOffStep(state, a, part1, part2);
    assert.ok(part2.every((c) => c.status === "accepted" && state.signedOffBlocks?.[c.id]));
    const ix = deriveFlowIndex(state);
    assert.equal(ix.stepState({ path: "a.ts", blocks: part2 }), "approved");
    assert.equal(ix.reviewState("a.ts"), "approved");
    assert.deepEqual(await delivered(desk, state), ["a.ts"]);
  });
});

test("a split file with every part skimmed signs off only the part approved", async () => {
  await withRepo(async (state) => {
    const a = fileOf(state, "a.ts");
    const [part1, part2] = parts(state);
    signOffStep(state, a, part1, [...part1, ...part2]);
    assert.ok(part2.every((c) => c.status === "pending" && !state.signedOffBlocks?.[c.id]));
    assert.equal(deriveFlowIndex(state).reviewState("a.ts"), "pending");
    // Once its last block is signed off, the file is too.
    signOffStep(state, a, part2, [...part1, ...part2]);
    assert.equal(deriveFlowIndex(state).reviewState("a.ts"), "approved");
  });
});
