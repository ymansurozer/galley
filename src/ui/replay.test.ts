import { test } from "node:test";
import assert from "node:assert/strict";
import { diffAcceptRejectHunk, parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import type { ChangeState, GuideFile, ReviewState } from "../types.js";
import { changeStableKey } from "./decisions-derive.js";
import { buildLineMap, type DecidedPosition } from "./linemap.js";
import { blockAt, replayPositions } from "./replay.js";
import { reviewerSlice } from "./save.js";
import { inStep, type Step } from "./steps.js";

// One file whose four change blocks the guide splits two ways, one left to Rest. @pierre parses it
// as one hunk: context entries between the blocks, each block at its own content index.
//
//   raw old (deletions)          raw new (additions)
//   1  a                         1  a
//   2  b  ─┐ P  part 0           2  B1 ─┐ P (2 del → 3 add)
//   3  c  ─┘                     3  B2  │
//                                4  B3 ─┘
//   4  d                         5  d
//   5  e  ─┐ Q  part 1           —        (2 del → 0 add, pure deletion)
//   6  f  ─┘
//   7  g                         6  g
//   8  h                         7  h
//   —        R  part 0           8  X1 ─┐ R (0 del → 2 add, pure addition)
//                                9  X2 ─┘
//   9  i                         10 i
//   10 j  ─  S  Rest             11 J1 ─  S (1 del → 1 add)
//   11 k                         12 k
const OLD = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
const NEW = ["a", "B1", "B2", "B3", "d", "g", "h", "X1", "X2", "i", "J1", "k"];
const PATH = "account.ts";
const GUIDE: GuideFile[] = [
  {
    path: PATH,
    order: 0,
    category: "Billing",
    orientation: "",
    part: { title: "Fees", lines: [] },
  },
  {
    path: PATH,
    order: 1,
    category: "Auth",
    orientation: "",
    part: { title: "Lockout", lines: [] },
  },
];
const PARTS: Record<string, number | undefined> = { P: 0, Q: 1, R: 0, S: undefined };

function rawDiff(): FileDiffMetadata {
  const text = (lines: string[]) => lines.join("\n") + "\n";
  return parseDiffFromFile(
    { name: PATH, contents: text(OLD) },
    { name: PATH, contents: text(NEW) },
  );
}

// The file's blocks as the tab derives them (changes.ts deriveChanges), named P..S in document
// order, each with its part stamp and the given status.
function blocks(
  diff: FileDiffMetadata,
  status: Partial<Record<string, ChangeState["status"]>> = {},
): Record<string, ChangeState> {
  const out: Record<string, ChangeState> = {};
  const names = ["P", "Q", "R", "S"];
  diff.hunks.forEach((h, hunkIndex) =>
    h.hunkContent.forEach((part, changeIndex) => {
      if (part.type !== "change") return;
      const name = names[Object.keys(out).length]!;
      const side = part.additions > 0 ? "additions" : "deletions";
      const stableKey = changeStableKey(part);
      out[name] = {
        id: `${PATH}:${stableKey}`,
        path: PATH,
        hunkIndex,
        changeIndex,
        stableKey,
        side,
        lineNumber: (side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1,
        title: name,
        status: status[name] ?? "pending",
        ...(PARTS[name] === undefined ? {} : { part: PARTS[name] }),
      };
    }),
  );
  return out;
}

const view = (part: Step["part"]) => (c: ChangeState) => inStep(GUIDE, part, c);

// Replay the resolutions the way changes.ts does: the same list builds the map and resolves the
// diff, so the map can be checked against the lines @pierre actually renders.
function replay(diff: FileDiffMetadata, resolved: DecidedPosition[]) {
  let shown = diff;
  for (const d of resolved)
    shown = diffAcceptRejectHunk(shown, d.hunkIndex, {
      type: d.status === "accepted" ? "accept" : "reject",
      changeIndex: d.changeIndex,
    });
  return { shown, map: buildLineMap(diff, resolved) };
}

test("the fixture parses as the four blocks drawn above", () => {
  const b = blocks(rawDiff());
  assert.deepEqual(
    Object.values(b).map((c) => [c.changeIndex, c.side, c.lineNumber]),
    [
      [1, "additions", 2],
      [3, "deletions", 5],
      [5, "additions", 8],
      [7, "additions", 11],
    ],
  );
});

test("the whole-file view replays only real decisions", () => {
  const diff = rawDiff();
  const b = blocks(diff, { P: "rejected", R: "accepted" });
  assert.deepEqual(replayPositions(diff, Object.values(b), view(undefined)), [
    { hunkIndex: 0, changeIndex: 1, status: "rejected" },
    { hunkIndex: 0, changeIndex: 5, status: "accepted" },
  ]);
  assert.deepEqual(replayPositions(diff, Object.values(blocks(diff)), view(undefined)), []);
});

test("a part view replays every pending block outside the part as accepted", () => {
  const diff = rawDiff();
  // Fees (P, R) stays a diff; Lockout's Q and Rest's S render as their new code.
  assert.deepEqual(replayPositions(diff, Object.values(blocks(diff)), view(0)), [
    { hunkIndex: 0, changeIndex: 3, status: "accepted" },
    { hunkIndex: 0, changeIndex: 7, status: "accepted" },
  ]);
  // Rest shows only S; the parts' blocks render as their new code.
  assert.deepEqual(
    replayPositions(diff, Object.values(blocks(diff)), view("rest")).map((d) => d.changeIndex),
    [1, 3, 5],
  );
});

test("a decided block replays as its decision in every view, in or out of the step", () => {
  const diff = rawDiff();
  const b = blocks(diff, { P: "rejected", Q: "accepted" });
  // Lockout's view: P (Fees) was rejected, so it shows its old code; R (Fees) and S (Rest) are
  // pending outside the part; Q is Lockout's own, decided, so it resolves too.
  assert.deepEqual(replayPositions(diff, Object.values(b), view(1)), [
    { hunkIndex: 0, changeIndex: 1, status: "rejected" },
    { hunkIndex: 0, changeIndex: 3, status: "accepted" },
    { hunkIndex: 0, changeIndex: 5, status: "accepted" },
    { hunkIndex: 0, changeIndex: 7, status: "accepted" },
  ]);
});

test("the line map tracks a part view's display-only resolutions on both sides", () => {
  const diff = rawDiff();
  // Fees' view: Q (2 del → 0) and S (1 → 1) render accepted.
  const { shown, map } = replay(diff, replayPositions(diff, Object.values(blocks(diff)), view(0)));
  // Q's accept drops its two deleted lines from the old side: g (old 7) renders at 5, k at 9.
  assert.equal(map.toDisplay("deletions", 7), 5);
  assert.equal(map.toDisplay("deletions", 11), 9);
  assert.equal(map.fromDisplay("deletions", 5), 7);
  assert.equal(map.fromDisplay("deletions", 9), 11);
  // P's deleted lines are Fees' own, still a diff before the resolved block: unshifted.
  assert.equal(map.toDisplay("deletions", 2), 2);
  // An accept never moves the new side.
  assert.equal(map.toDisplay("additions", 8), 8);
  // Every line of the step's own blocks and of the context renders where the map puts it.
  for (const raw of [1, 2, 3, 4, 7, 8, 9, 11])
    assert.equal(shown.deletionLines[map.toDisplay("deletions", raw) - 1], OLD[raw - 1] + "\n");
  for (const raw of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12])
    assert.equal(shown.additionLines[map.toDisplay("additions", raw) - 1], NEW[raw - 1] + "\n");
});

test("the line map tracks real decisions mixed with display-only resolutions", () => {
  const diff = rawDiff();
  // Lockout's view after P was rejected: P shows its old code (the new side loses a line), R and
  // S render accepted (R's two added lines join the old side), Q stays Lockout's diff.
  const b = blocks(diff, { P: "rejected" });
  const { shown, map } = replay(diff, replayPositions(diff, Object.values(b), view(1)));
  assert.equal(map.toDisplay("additions", 5), 4); // d, below P's reject
  assert.equal(map.toDisplay("additions", 12), 11); // k
  assert.equal(map.fromDisplay("additions", 4), 5);
  assert.equal(map.toDisplay("deletions", 5), 5); // Q's own deleted e, unshifted by a reject
  assert.equal(map.toDisplay("deletions", 6), 6);
  assert.equal(map.toDisplay("deletions", 9), 11); // i, below R's accepted additions
  assert.equal(map.toDisplay("deletions", 11), 13); // k
  assert.equal(map.fromDisplay("deletions", 11), 9);
  assert.equal(map.fromDisplay("deletions", 13), 11);
  for (const raw of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11])
    assert.equal(shown.deletionLines[map.toDisplay("deletions", raw) - 1], OLD[raw - 1] + "\n");
  for (const raw of [1, 5, 6, 7, 8, 9, 10, 11, 12])
    assert.equal(shown.additionLines[map.toDisplay("additions", raw) - 1], NEW[raw - 1] + "\n");
});

test("every rendered row anchors to a raw line holding the code it shows, in either gutter", () => {
  const diff = rawDiff();
  const views: Array<[Step["part"], Partial<Record<string, ChangeState["status"]>>]> = [
    [0, {}],
    [1, { P: "rejected" }],
    [undefined, { P: "accepted", Q: "rejected", R: "rejected", S: "accepted" }],
  ];
  for (const [part, status] of views) {
    const { shown, map } = replay(
      diff,
      replayPositions(diff, Object.values(blocks(diff, status)), view(part)),
    );
    for (const side of ["additions", "deletions"] as const) {
      const rows = side === "additions" ? shown.additionLines : shown.deletionLines;
      rows.forEach((code, i) => {
        const at = map.anchorAt(side, i + 1);
        const file = at.side === "additions" ? NEW : OLD;
        assert.equal(file[at.line - 1] + "\n", code, `${String(part)} ${side} row ${i + 1}`);
      });
    }
  }
});

test("viewing a part records nothing: its other blocks stay pending in the saved slice", () => {
  const diff = rawDiff();
  const b = blocks(diff, { P: "rejected" });
  const state = {
    changes: Object.values(b),
    decisions: [{ key: b.P!.id, status: "rejected", path: PATH, lineNumber: 2, side: "additions" }],
    comments: [],
    reviewedFiles: [],
  } as unknown as ReviewState;
  replayPositions(diff, state.changes, view(1));
  assert.deepEqual(
    state.changes.map((c) => c.status),
    ["rejected", "pending", "pending", "pending"],
  );
  assert.deepEqual(
    reviewerSlice(state).decisions!.map((d) => d.key),
    [b.P!.id],
  );
});

test("blockAt finds the block covering a raw line on either side, old side of a replace included", () => {
  const diff = rawDiff();
  const b = blocks(diff);
  const at = (side: "additions" | "deletions", line: number) =>
    blockAt(diff, Object.values(b), side, line)?.title;
  assert.equal(at("deletions", 3), "P"); // c, P's old side
  assert.equal(at("additions", 4), "P");
  assert.equal(at("deletions", 6), "Q");
  assert.equal(at("additions", 9), "R");
  assert.equal(at("deletions", 10), "S");
  assert.equal(at("deletions", 4), undefined); // d, context
  assert.equal(at("additions", 10), undefined); // i, context
});
