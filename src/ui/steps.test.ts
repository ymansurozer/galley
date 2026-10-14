import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangeState, GuideFile } from "../types.js";
import { nextUnreviewed, wrapNextTarget, wrapPrevTarget } from "./seek.js";
import {
  adjacentStep,
  anchorStep,
  carryStep,
  planSteps,
  slotOutOfFlow,
  stepEntry,
  stepKey,
  stepOrder,
  stepPlan,
  type Step,
} from "./steps.js";

// A review whose guide splits account.ts into two parts in different categories, with a third
// account.ts block no part claims. b.ts and u.ts are unlisted.
//   files:  0 a.ts · 1 account.ts · 2 b.ts · 3 u.ts
//   guide:  0 account.ts "Fees" · 1 a.ts · 2 account.ts "Lockout"
const FILES = [{ path: "a.ts" }, { path: "account.ts" }, { path: "b.ts" }, { path: "u.ts" }];

function part(title: string, category: string): GuideFile {
  return {
    path: "account.ts",
    order: 0,
    category,
    orientation: `about ${title}`,
    part: { title, lines: [1] },
  };
}
const GUIDE: GuideFile[] = [
  part("Fees", "Billing"),
  { path: "a.ts", order: 1, category: "Core", orientation: "about a" },
  part("Lockout", "Auth"),
];

function block(key: string, partIndex?: number, skim = false): ChangeState {
  return {
    id: `account.ts:${key}`,
    path: "account.ts",
    hunkIndex: 0,
    side: "additions",
    lineNumber: 1,
    title: "",
    stableKey: key,
    status: "pending",
    ...(partIndex === undefined ? {} : { part: partIndex }),
    ...(skim ? { skim: {} } : {}),
  };
}
const changesOf =
  (blocks: ChangeState[]) =>
  (path: string): ChangeState[] =>
    path === "account.ts" ? blocks : [];
const SPLIT = [block("fees", 0), block("lockout", 2), block("loose")];

const keys = (steps: Step[]) => steps.map(stepKey);
const plan = (blocks = SPLIT, guide = GUIDE) => stepPlan(guide, FILES, changesOf(blocks));

test("stepPlan lists one step per part in guide order, then Other: unlisted files and Rest", () => {
  const p = plan();
  assert.deepEqual(keys(p.listed.map((s) => s.step)), ["1:0", "0", "1:2"]);
  assert.deepEqual(keys(p.other.map((s) => s.step)), ["1:rest", "2", "3"]);
  // Each part step covers only its own blocks; Rest covers the unclaimed one.
  assert.deepEqual(
    p.listed.map((s) => s.blocks?.map((c) => c.stableKey) ?? null),
    [["fees"], null, ["lockout"]],
  );
  assert.deepEqual(
    p.other[0]!.blocks!.map((c) => c.stableKey),
    ["loose"],
  );
});

test("stepPlan has no Rest step when the parts claim every block", () => {
  const p = plan([block("fees", 0), block("lockout", 2)]);
  assert.deepEqual(keys(p.other.map((s) => s.step)), ["2", "3"]);
});

test("stepPlan drops a part with no blocks, and lists a split file with no step left whole", () => {
  // Lenient re-resolution left Lockout with nothing: it has no step.
  const gone = plan([block("fees", 0), block("loose")]);
  assert.deepEqual(keys(gone.listed.map((s) => s.step)), ["1:0", "0"]);
  // No blocks at all: the file can't vanish from navigation, so it steps whole in Other.
  const empty = plan([]);
  assert.deepEqual(keys(empty.other.map((s) => s.step)), ["1", "2", "3"]);
});

test("stepPlan counts a block stamped for another file's entry as unclaimed", () => {
  // A stale stamp (index 1 is a.ts's entry) must not hide the block from every step.
  const p = plan([block("fees", 0), block("lockout", 2), block("stale", 1)]);
  assert.deepEqual(
    p.other[0]!.blocks!.map((c) => c.stableKey),
    ["stale"],
  );
});

test("next/prev from a part walk the guide's steps, through both parts of the split file", () => {
  const p = plan();
  const none = () => false;
  const order = stepOrder(p, { fileIndex: 1, part: 0 });
  assert.deepEqual(keys(order), ["1:0", "0", "1:2"]);
  assert.equal(stepKey(adjacentStep(order, { fileIndex: 1, part: 0 }, 1, none)!), "0");
  assert.equal(stepKey(adjacentStep(order, { fileIndex: 0 }, 1, none)!), "1:2");
  assert.equal(adjacentStep(order, { fileIndex: 1, part: 2 }, 1, none), null); // caller wraps
  assert.equal(adjacentStep(order, { fileIndex: 1, part: 0 }, -1, none), null); // → Overview
});

test("next/prev from a Rest step or an unlisted file walk the file array, expanded to steps", () => {
  const p = plan();
  const order = stepOrder(p, { fileIndex: 1, part: "rest" });
  assert.deepEqual(keys(order), ["0", "1:0", "1:2", "1:rest", "2", "3"]);
  assert.equal(stepKey(adjacentStep(order, { fileIndex: 1, part: "rest" }, 1, () => false)!), "2");
  assert.equal(stepKey(adjacentStep(order, { fileIndex: 2 }, -1, () => false)!), "1:rest");
});

test("stepping skips steps out of the band — a fully skimmed part is passed over", () => {
  const skimmedFees = [block("fees", 0, true), block("lockout", 2), block("loose")];
  const p = plan(skimmedFees);
  const slots = [...p.listed, ...p.other];
  const out = (s: Step) =>
    slotOutOfFlow(slots.find((x) => stepKey(x.step) === stepKey(s))!, () => false);
  assert.equal(out({ fileIndex: 1, part: 0 }), true, "the all-skimmed part left the flow");
  assert.equal(out({ fileIndex: 1, part: 2 }), false, "its sibling part didn't");
  const order = stepOrder(p, { fileIndex: 0 });
  assert.equal(adjacentStep(order, { fileIndex: 0 }, -1, out), null, "nothing in-band before a.ts");
});

test("a split file opened whole steps as if from its first step", () => {
  const p = plan();
  const slots = [...p.listed, ...p.other];
  assert.deepEqual(anchorStep(slots, { fileIndex: 1 }), { fileIndex: 1, part: 0 });
  // Unsplit files and part steps are their own anchor.
  assert.deepEqual(anchorStep(slots, { fileIndex: 0 }), { fileIndex: 0 });
  assert.deepEqual(anchorStep(slots, { fileIndex: 1, part: 2 }), { fileIndex: 1, part: 2 });
});

test("seeks walk every in-flow step in walkthrough order, wrapping through parts and Rest", () => {
  const p = plan([block("fees", 0, true), block("lockout", 2), block("loose")]);
  const nav = planSteps(p, (s) => !slotOutOfFlow(s, () => false)).map(stepKey);
  assert.deepEqual(nav, ["0", "1:2", "1:rest", "2", "3"], "the skimmed Fees part left the seeks");
  const finished = (done: string[]) => (k: string) => done.includes(k);
  // Approve-advance from Lockout lands on the next unreviewed step: Rest.
  assert.equal(nextUnreviewed(nav, "1:2", finished(["0", "1:2"])), "1:rest");
  // From the last step it wraps to the first unreviewed one.
  assert.equal(nextUnreviewed(nav, "3", finished(["0", "1:rest", "2", "3"])), "1:2");
  assert.equal(wrapNextTarget(nav, finished(["0"])), "1:2");
  assert.equal(wrapPrevTarget(nav, finished(["2", "3"])), "1:rest");
  // The change-request walk keeps skimmed steps.
  assert.deepEqual(planSteps(p, () => true).map(stepKey), ["1:0", "0", "1:2", "1:rest", "2", "3"]);
});

test("stepEntry gives a part its own entry, and no entry to Rest or a split file opened whole", () => {
  assert.equal(stepEntry(GUIDE, "account.ts", 2), GUIDE[2]);
  assert.equal(stepEntry(GUIDE, "account.ts", "rest"), null);
  assert.equal(stepEntry(GUIDE, "account.ts", undefined), null);
  assert.equal(stepEntry(GUIDE, "a.ts", undefined), GUIDE[1]);
  // A part index that belongs to another path (a stale step) shows nothing.
  assert.equal(stepEntry(GUIDE, "a.ts", 0), null);
});

test("carryStep re-finds the part by path and title after the guide's indices move", () => {
  // The new guide puts a.ts first: Fees is now entry 1, Lockout entry 2.
  const swapped = [GUIDE[1]!, GUIDE[0]!, GUIDE[2]!];
  const p = stepPlan(
    swapped,
    FILES,
    changesOf([block("fees", 1), block("lockout", 2), block("loose")]),
  );
  assert.deepEqual(carryStep(p, 1, 0, "Fees"), { fileIndex: 1, part: 1 });
  // A part the new guide no longer has falls back to the whole file.
  assert.deepEqual(carryStep(p, 1, 0, "Refunds"), { fileIndex: 1 });
  assert.deepEqual(carryStep(p, 1, "rest", undefined), { fileIndex: 1, part: "rest" });
  // Rest stays Rest only while the file still has unclaimed blocks.
  const claimed = stepPlan(swapped, FILES, changesOf([block("fees", 1), block("lockout", 2)]));
  assert.deepEqual(carryStep(claimed, 1, "rest", undefined), { fileIndex: 1 });
  assert.deepEqual(carryStep(p, 0, undefined, undefined), { fileIndex: 0 });
});
