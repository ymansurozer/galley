import { test } from "node:test";
import assert from "node:assert/strict";
import { diffAcceptRejectHunk, parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import type { ChangeState, GuideFile } from "../types.js";
import { changeStableKey } from "./decisions-derive.js";
import { foldedHunks, hunkAt, openedFor, shownFolds } from "./fold-derive.js";
import { replayPositions } from "./replay.js";
import { inStep, type Step } from "./steps.js";

// A 40-line file with five one-line replacements that @pierre parses as four hunks (its context
// lines around each change; changes 26 and 28 share a hunk, one context line apart):
//
//   hunk 0  lines 1-7    F1 at 3   Fees     (part 0)
//   hunk 1  lines 11-19  K1 at 15  Lockout  (part 1)
//   hunk 2  lines 22-32  F2 at 26  Fees, K2 at 28 Lockout — two parts in one hunk
//   hunk 3  lines 34-40  R1 at 38  Rest
const OLD = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
const EDITS: Record<number, string> = { 3: "F1", 15: "K1", 26: "F2", 28: "K2", 38: "R1" };
const NEW = OLD.map((l, i) => EDITS[i + 1] ?? l);
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
const PARTS: Record<string, number | undefined> = { F1: 0, K1: 1, F2: 0, K2: 1, R1: undefined };

function rawDiff(): FileDiffMetadata {
  const text = (lines: string[]) => lines.join("\n") + "\n";
  return parseDiffFromFile(
    { name: PATH, contents: text(OLD) },
    { name: PATH, contents: text(NEW) },
  );
}

// The file's blocks as the tab derives them, named by the new line they write, each with its part
// stamp and the given status.
function blocks(
  diff: FileDiffMetadata,
  status: Partial<Record<string, ChangeState["status"]>> = {},
): ChangeState[] {
  const out: ChangeState[] = [];
  diff.hunks.forEach((h, hunkIndex) =>
    h.hunkContent.forEach((part, changeIndex) => {
      if (part.type !== "change") return;
      const name = NEW[part.additionLineIndex]!;
      const stableKey = changeStableKey(part);
      out.push({
        id: `${PATH}:${stableKey}`,
        path: PATH,
        hunkIndex,
        changeIndex,
        stableKey,
        side: "additions",
        lineNumber: part.additionLineIndex + 1,
        title: name,
        status: status[name] ?? "pending",
        ...(PARTS[name] === undefined ? {} : { part: PARTS[name] }),
      });
    }),
  );
  return out;
}

// The hunks a view folds, through the same replay the desk renders (changes.ts replayDecisions).
function folds(part: Step["part"], status: Partial<Record<string, ChangeState["status"]>> = {}) {
  const raw = rawDiff();
  const changes = blocks(raw, status);
  const inView = (c: ChangeState) => inStep(GUIDE, part, c);
  let shown = raw;
  for (const d of replayPositions(raw, changes, inView))
    shown = diffAcceptRejectHunk(shown, d.hunkIndex, {
      type: d.status === "accepted" ? "accept" : "reject",
      changeIndex: d.changeIndex,
    });
  return foldedHunks(raw, shown, changes, inView);
}

test("the fixture parses as the four hunks drawn above", () => {
  assert.deepEqual(
    rawDiff().hunks.map((h) => [h.additionStart, h.additionCount]),
    [
      [1, 7],
      [11, 9],
      [22, 11],
      [34, 7],
    ],
  );
});

test("the whole-file view folds nothing", () => {
  assert.deepEqual(folds(undefined), []);
});

test("a part view folds every hunk holding none of its blocks", () => {
  assert.deepEqual(folds(0), [1, 3]);
  assert.deepEqual(folds(1), [0, 3]);
});

test("a Rest view folds every hunk the parts own", () => {
  assert.deepEqual(folds("rest"), [0, 1, 2]);
});

test("a hunk mixing two parts' blocks folds in neither part's view", () => {
  assert.ok(!folds(0).includes(2));
  assert.ok(!folds(1).includes(2));
});

test("a hunk keeps its rows when its only step block is decided, though it renders as context", () => {
  assert.deepEqual(folds(0, { F1: "accepted" }), [1, 3]);
  assert.deepEqual(folds(1, { K1: "rejected" }), [0, 3]);
});

test("another step's decided block folds with its hunk", () => {
  assert.deepEqual(folds(0, { K1: "rejected", R1: "accepted" }), [1, 3]);
});

test("hunkAt names the hunk whose rows hold a line on either side, and none between hunks", () => {
  const diff = rawDiff();
  assert.equal(hunkAt(diff, "additions", 1), 0);
  assert.equal(hunkAt(diff, "additions", 7), 0);
  assert.equal(hunkAt(diff, "deletions", 15), 1);
  assert.equal(hunkAt(diff, "additions", 31), 2);
  assert.equal(hunkAt(diff, "deletions", 40), 3);
  assert.equal(hunkAt(diff, "additions", 9), undefined);
  assert.equal(hunkAt(diff, "deletions", 20), undefined);
  assert.equal(hunkAt(diff, "additions", 41), undefined);
});

test("an open thread keeps its hunk unfolded only while it is open", () => {
  const diff = rawDiff();
  // Fees' view folds hunks 1 and 3; a thread on line 15 sits in hunk 1.
  const thread = [{ side: "additions" as const, line: 15 }];
  assert.deepEqual(shownFolds(diff, [1, 3], new Set(), thread), [3]);
  // Resolved: no open thread holds hunk 1, so it folds again.
  assert.deepEqual(shownFolds(diff, [1, 3], new Set(), []), [1, 3]);
  // A hunk the reviewer opened stays open with no thread in it.
  assert.deepEqual(shownFolds(diff, [1, 3], new Set([3]), []), [1]);
});

test("the reviewer's opened folds hold for their view and start over in another", () => {
  const opened = { view: "diff-a|guide-a|account.ts|0", hunks: new Set([1]) };
  assert.equal(openedFor(opened, "diff-a|guide-a|account.ts|0"), opened);
  // A reload that moved the diff, a guide swap, or another step is another view.
  for (const view of [
    "diff-b|guide-a|account.ts|0",
    "diff-a|guide-b|account.ts|0",
    "diff-a|guide-a|account.ts|1",
  ])
    assert.deepEqual(openedFor(opened, view), { view, hunks: new Set() });
});
