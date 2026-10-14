import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangeState, GuideFile } from "../types.js";
import { nextUnreviewed, wrapNextTarget, wrapPrevTarget } from "./seek.js";
import {
  anchorStep,
  carryStep,
  neighborStep,
  planSteps,
  slotOutOfFlow,
  stepEntry,
  stepKey,
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

// Out-of-flow per step, read off the plan's slots (no whole file is skimmed in these fixtures).
const outOf = (p: ReturnType<typeof stepPlan>) => {
  const slots = [...p.listed, ...p.other];
  return (s: Step) => {
    const slot = slots.find((x) => stepKey(x.step) === stepKey(s));
    return !!slot && slotOutOfFlow(slot, () => false);
  };
};

test("next/prev walk one order — guide steps, then Rest and unlisted files — as exact inverses", () => {
  const p = plan();
  const out = outOf(p);
  const steps = planSteps(p, () => true);
  assert.deepEqual(keys(steps), ["1:0", "0", "1:2", "1:rest", "2", "3"]);
  for (let i = 0; i + 1 < steps.length; i++) {
    assert.deepEqual(neighborStep(p, steps[i]!, 1, out), steps[i + 1], `next from ${i}`);
    assert.deepEqual(neighborStep(p, steps[i + 1]!, -1, out), steps[i], `prev from ${i + 1}`);
  }
  assert.equal(neighborStep(p, { fileIndex: 3 }, 1, out), null); // the caller wraps
  assert.equal(neighborStep(p, { fileIndex: 1, part: 0 }, -1, out), null); // → the Overview
});

test("stepping skips steps out of the band — a fully skimmed part is passed over", () => {
  const p = plan([block("fees", 0, true), block("lockout", 2), block("loose")]);
  const out = outOf(p);
  assert.equal(out({ fileIndex: 1, part: 0 }), true, "the all-skimmed part left the flow");
  assert.equal(out({ fileIndex: 1, part: 2 }), false, "its sibling part didn't");
  assert.equal(neighborStep(p, { fileIndex: 0 }, -1, out), null, "nothing in-band before a.ts");
  // Opened from the Skimmed group, the part steps within its own band — where it is alone.
  assert.equal(neighborStep(p, { fileIndex: 1, part: 0 }, 1, out), null);
});

test("a split file opened whole steps as if from its first step", () => {
  const p = plan();
  const out = outOf(p);
  const slots = [...p.listed, ...p.other];
  assert.deepEqual(anchorStep(slots, { fileIndex: 1 }, out), {
    at: { fileIndex: 1, part: 0 },
    band: false,
  });
  // Unsplit files and part steps are their own anchor.
  assert.deepEqual(anchorStep(slots, { fileIndex: 0 }, out), { at: { fileIndex: 0 }, band: false });
  assert.deepEqual(anchorStep(slots, { fileIndex: 1, part: 2 }, out), {
    at: { fileIndex: 1, part: 2 },
    band: false,
  });
  assert.deepEqual(neighborStep(p, { fileIndex: 1 }, 1, out), { fileIndex: 0 });
  assert.equal(neighborStep(p, { fileIndex: 1 }, -1, out), null);
});

test("a split file opened whole steps in the flow even when its first part is skimmed", () => {
  //   files: 0 w.ts · 1 f.ts · 2 x.ts     guide: w.ts · f.ts "Fees" (all skimmed) · x.ts · f.ts "Lock"
  const fPart = (title: string): GuideFile => ({
    path: "f.ts",
    order: 0,
    category: "C",
    orientation: title,
    part: { title, lines: [1] },
  });
  const whole = (path: string): GuideFile => ({ path, order: 0, category: "C", orientation: path });
  const blocks = [
    { ...block("fees", 1, true), path: "f.ts" },
    { ...block("lock", 3), path: "f.ts" },
  ];
  const p = stepPlan(
    [whole("w.ts"), fPart("Fees"), whole("x.ts"), fPart("Lock")],
    [{ path: "w.ts" }, { path: "f.ts" }, { path: "x.ts" }],
    (path) => (path === "f.ts" ? blocks : []),
  );
  const out = outOf(p);
  assert.deepEqual(neighborStep(p, { fileIndex: 1 }, 1, out), { fileIndex: 2 }, "⇧→ = x.ts");
  assert.deepEqual(neighborStep(p, { fileIndex: 1 }, -1, out), { fileIndex: 0 }, "⇧← = w.ts");
  // Only when every part is skimmed does the whole-file view walk the Skimmed band.
  const allSkimmed = [blocks[0]!, { ...blocks[1]!, skim: {} }];
  const q = stepPlan(
    [whole("w.ts"), fPart("Fees"), whole("x.ts"), fPart("Lock")],
    [{ path: "w.ts" }, { path: "f.ts" }, { path: "x.ts" }],
    (path) => (path === "f.ts" ? allSkimmed : []),
  );
  assert.deepEqual(neighborStep(q, { fileIndex: 1 }, 1, outOf(q)), { fileIndex: 1, part: 3 });
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
