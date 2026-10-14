import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeComment, deriveFlowIndex, placeBlocks, stepWeight } from "./flow-index";
import type { ChangeState, ReviewComment } from "./types";

// flow-index is the bulk mirror of the per-path predicates (fileFullySkimmed/fileOutOfFlow in
// skim.ts, fileFinished/fileObjections/fileReviewState in changes.ts). Those read the live store,
// so parity is pinned here against hand-derived expectations over a fixture that exercises every
// classification the originals encode.

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
function file(path: string, over: Record<string, unknown> = {}) {
  return { path, hunks: [], contentHash: `H-${path}`, ...over } as never;
}

const state = {
  files: [
    file("plain.ts"), // in flow, pending
    file("guide-skim.ts"), // guide file-level skim → fully skimmed
    file("block-skim.ts"), // every block skim-stamped → fully skimmed
    file("part-skim.ts"), // one of two blocks skimmed → in flow
    file("pure-rename.ts", { renamePure: true, oldPath: "old.ts", newPath: "pure-rename.ts" }),
    file("approved.ts"), // finished, no objections → approved
    file("rejected.ts"), // finished + rejected hunk → changes-requested
    file("commented.ts"), // finished + open user change comment → changes-requested
    file("stale.ts"), // signed off but hash no longer matches → pending again
  ],
  changes: [
    change({ id: "c1", path: "plain.ts" }),
    change({ id: "c2", path: "block-skim.ts", skim: { reason: "gen" } as never }),
    change({ id: "c3", path: "block-skim.ts", skim: { reason: "gen" } as never }),
    change({ id: "c4", path: "part-skim.ts", skim: { reason: "gen" } as never }),
    change({ id: "c5", path: "part-skim.ts" }),
    change({ id: "c6", path: "rejected.ts" }),
  ],
  comments: [
    comment({ id: "m1", path: "commented.ts", intent: "action" }), // open user change → objection
    comment({ id: "m2", path: "plain.ts", intent: "question" }), // question → NOT an objection
    comment({ id: "m3", path: "approved.ts", role: "agent" }), // agent reply → NOT an objection
    comment({ id: "m4", path: "rejected.ts", status: "resolved", intent: "action" }), // resolved → not
  ],
  decisions: [
    {
      key: "rejected.ts:k",
      path: "rejected.ts",
      status: "rejected",
      lineNumber: 1,
      side: "additions",
      title: "",
    },
    {
      key: "plain.ts:k",
      path: "plain.ts",
      status: "accepted",
      lineNumber: 1,
      side: "additions",
      title: "",
    },
  ],
  reviewedFiles: ["approved.ts", "rejected.ts", "commented.ts", "stale.ts"],
  reviewedFileHashes: {
    "approved.ts": "H-approved.ts",
    "rejected.ts": "H-rejected.ts",
    "commented.ts": "H-commented.ts",
    "stale.ts": "OLD-HASH", // agent rewrote it since sign-off
  },
  guide: {
    overview: "o",
    files: [{ path: "guide-skim.ts", orientation: "x", skim: true }],
  },
} as never;

test("flow-index: skim/rename flow classification mirrors the per-path predicates", () => {
  const ix = deriveFlowIndex(state);
  assert.deepEqual([...ix.fullySkimmed].sort(), ["block-skim.ts", "guide-skim.ts"]);
  assert.deepEqual([...ix.outOfFlow].sort(), ["block-skim.ts", "guide-skim.ts", "pure-rename.ts"]);
  // Partial skim and plain files stay in flow.
  assert.ok(!ix.outOfFlow.has("part-skim.ts"));
  assert.ok(!ix.outOfFlow.has("plain.ts"));
});

test("flow-index: finished/reviewState mirror fileFinished/fileObjections/fileReviewState", () => {
  const ix = deriveFlowIndex(state);
  assert.equal(ix.reviewState("plain.ts"), "pending"); // never signed off
  assert.equal(ix.reviewState("approved.ts"), "approved"); // finished, agent comment ≠ objection
  assert.equal(ix.reviewState("rejected.ts"), "changes-requested"); // rejected decision
  assert.equal(ix.reviewState("commented.ts"), "changes-requested"); // open user change comment
  assert.equal(ix.reviewState("stale.ts"), "pending"); // hash mismatch voids the sign-off
  assert.equal(ix.finished("stale.ts"), false);
  assert.equal(ix.finished("approved.ts"), true);
  assert.equal(ix.finished("ghost.ts"), false); // not a file at all
});

test("flow-index: groups changes and comments by path; absent paths have no entry", () => {
  const ix = deriveFlowIndex(state);
  assert.equal(ix.changesByPath.get("block-skim.ts")?.length, 2);
  assert.equal(ix.commentsByPath.get("rejected.ts")?.length, 1);
  assert.equal(ix.changesByPath.get("approved.ts"), undefined);
});

test("flow-index: null state derives an empty index", () => {
  const ix = deriveFlowIndex(null);
  assert.equal(ix.outOfFlow.size, 0);
  assert.equal(ix.reviewState("anything"), "pending");
});

// ── Per-step state, comment attribution and progress weight ──────────────────
// s.ts, old lines 1..12. Hunk 1 replaces line 3 with two lines (block A, mixed) and adds a line
// after line 5 (block B); hunk 2 deletes line 10 (block C).
function hunk(oldStart: number, newStart: number, spec: string[]) {
  let oldLine = oldStart;
  let newLine = newStart;
  const lines = spec.map((s) => {
    const text = s.slice(1);
    if (s[0] === "+") return { kind: "add", text, newLine: newLine++ };
    if (s[0] === "-") return { kind: "delete", text, oldLine: oldLine++ };
    return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
  });
  return {
    oldStart,
    newStart,
    oldCount: spec.filter((s) => s[0] !== "+").length,
    newCount: spec.filter((s) => s[0] !== "-").length,
    lines,
  } as never;
}
const splitHunks = [
  hunk(1, 1, [" 1", " 2", "-3", "+3a", "+3b", " 4", " 5", "+5x", " 6"]),
  hunk(9, 11, [" 9", "-10", " 11", " 12"]),
];
const block = (stableKey: string, contentHash?: string) => {
  const [side, line] = stableKey.split(":");
  return change({
    id: `s.ts:${stableKey}`,
    path: "s.ts",
    stableKey,
    side: side as "additions" | "deletions",
    lineNumber: Number(line),
    contentHash,
  });
};
const A = block("additions:3:1:2", "hA");
const B = block("additions:7:0:1", "hB");
const C = block("deletions:10:1:0", "hC");
const part1 = { path: "s.ts", blocks: [A] };
const part2 = { path: "s.ts", blocks: [B, C] };
const whole = { path: "s.ts", blocks: null };
const splitState = (over: Record<string, unknown> = {}) =>
  ({
    files: [file("s.ts", { hunks: splitHunks })],
    changes: [A, B, C],
    comments: [],
    decisions: [],
    reviewedFiles: [],
    ...over,
  }) as never;
const rejected = (c: ChangeState) => ({
  key: c.id,
  path: c.path,
  status: "rejected",
  lineNumber: c.lineNumber,
  side: c.side,
  title: "",
});

test("attributeComment: the nearest block on the comment's side, a mixed block's old lines included", () => {
  const placed = placeBlocks([A, B, C], splitHunks);
  const at = (side: "additions" | "deletions", lineNumber: number) =>
    attributeComment({ side, lineNumber }, placed)?.id;
  assert.equal(at("additions", 4), A.id); // inside A
  assert.equal(at("additions", 5), A.id); // A ends at 4, B starts at 7
  assert.equal(at("additions", 6), B.id);
  assert.equal(at("additions", 13), C.id); // C sits after new line 11
  assert.equal(at("deletions", 3), A.id); // A's old line, which only the hunks give
  assert.equal(at("deletions", 7), B.id); // B sits after old line 5
  assert.equal(at("deletions", 10), C.id);
  // Without the hunks, A has no old side: its deleted line goes to the nearest block that has one.
  const keyed = placeBlocks([A, B, C], []);
  assert.equal(attributeComment({ side: "deletions", lineNumber: 3 }, keyed)?.id, C.id);
});

test("attributeComment: a tie goes to the earlier block", () => {
  const p = block("additions:3:0:1");
  const q = block("additions:7:0:1");
  const placed = placeBlocks(
    [p, q],
    [hunk(1, 1, [" 1", " 2", "+x", " 3", " 4", " 5", "+y", " 6"])],
  );
  assert.equal(attributeComment({ side: "additions", lineNumber: 5 }, placed)?.id, p.id);
  // On the old side they sit between lines: after old line 2 and after old line 5.
  assert.equal(attributeComment({ side: "deletions", lineNumber: 3 }, placed)?.id, p.id);
  assert.equal(attributeComment({ side: "deletions", lineNumber: 4 }, placed)?.id, p.id);
  assert.equal(attributeComment({ side: "deletions", lineNumber: 5 }, placed)?.id, q.id);
  assert.equal(attributeComment({ side: "additions", lineNumber: 1 }, []), undefined);
});

test("flow-index: a part is pending until each of its blocks is signed off on its current content", () => {
  let ix = deriveFlowIndex(splitState());
  assert.deepEqual([ix.stepState(part1), ix.stepState(part2)], ["pending", "pending"]);
  ix = deriveFlowIndex(splitState({ signedOffBlocks: { [A.id]: "hA", [B.id]: "hB" } }));
  assert.deepEqual([ix.stepState(part1), ix.stepState(part2)], ["approved", "pending"]);
  assert.equal(ix.stepFinished(part2), false);
  // Signed off on content the block no longer has.
  ix = deriveFlowIndex(splitState({ signedOffBlocks: { [A.id]: "old hA" } }));
  assert.equal(ix.stepState(part1), "pending");
  // The whole file stays on its own sign-off.
  assert.equal(ix.stepState(whole), "pending");
});

test("flow-index: a done part is changes-requested by its own rejected block or attributed request", () => {
  const signed = { [A.id]: "hA", [B.id]: "hB", [C.id]: "hC" };
  let ix = deriveFlowIndex(splitState({ signedOffBlocks: signed, decisions: [rejected(C)] }));
  assert.deepEqual([ix.stepState(part1), ix.stepState(part2)], ["approved", "changes-requested"]);
  // A request on A's deleted line counts against part 1 only; a question counts against nothing.
  ix = deriveFlowIndex(
    splitState({
      signedOffBlocks: signed,
      comments: [
        comment({ id: "m1", path: "s.ts", side: "deletions", lineNumber: 3, intent: "action" }),
        comment({ id: "m2", path: "s.ts", lineNumber: 7, intent: "question" }),
      ],
    }),
  );
  assert.deepEqual([ix.stepState(part1), ix.stepState(part2)], ["changes-requested", "approved"]);
  // Objections show before the part is done too, for its "Mark reviewed" label.
  ix = deriveFlowIndex(splitState({ decisions: [rejected(A)] }));
  assert.deepEqual([ix.stepObjections(part1), ix.stepObjections(part2)], [true, false]);
  assert.equal(ix.stepState(part1), "pending");
});

test("flow-index: a current file sign-off finishes every part of the file", () => {
  const ix = deriveFlowIndex(
    splitState({ reviewedFiles: ["s.ts"], reviewedFileHashes: { "s.ts": "H-s.ts" } }),
  );
  assert.deepEqual(
    [ix.stepState(part1), ix.stepState(part2), ix.stepState(whole)],
    ["approved", "approved", "approved"],
  );
});

test("stepWeight: a step's own changed lines, or 1 each by files", () => {
  assert.equal(stepWeight(part1, 9, false), 3); // A: one line removed, two added
  assert.equal(stepWeight(part2, 9, false), 2);
  assert.equal(stepWeight(whole, 9, false), 9);
  assert.equal(stepWeight({ blocks: null }, 0, false), 1);
  assert.equal(stepWeight({ blocks: [block("odd")] }, 9, false), 1);
  assert.deepEqual(
    [part1, part2, whole].map((s) => stepWeight(s, 9, true)),
    [1, 1, 1],
  );
});
