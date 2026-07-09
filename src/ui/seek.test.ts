import { test } from "node:test";
import assert from "node:assert/strict";
import { navFileOrder, nextUnreviewed, wrapNextTarget, wrapPrevTarget } from "./seek.js";

// A finished predicate backed by a set of signed-off file indices. A file absent from the set
// is unreviewed — this is how a hash-invalidated file (signed off, then edited by the agent)
// re-enters the seek: the store's fileFinished returns false for it, so it's just "not in set".
const finishedIn = (done: number[]) => {
  const s = new Set(done);
  return (i: number) => s.has(i);
};

test("nextUnreviewed wraps past the end to the first unreviewed file — guide order", () => {
  // Guide order is not the file-array order; the seek must follow it.
  const order = [3, 1, 4, 0, 2];
  // Everything signed off except file index 1; cur is the last file in the order (2).
  const next = nextUnreviewed(order, 2, finishedIn([3, 4, 0, 2]));
  assert.equal(next, 1, "scans forward from the last slot, wraps, lands on 1");
});

test("nextUnreviewed wraps past the end to the first unreviewed file — file order", () => {
  const order = [0, 1, 2, 3, 4];
  // Only file 2 remains; cur is the last file (4).
  assert.equal(nextUnreviewed(order, 4, finishedIn([0, 1, 3, 4])), 2);
});

test("nextUnreviewed returns null when the current file is the last remaining one", () => {
  // Approve-advance on the final unreviewed file: after approving, cur is finished and every
  // other file already was — no wrap target, so the caller shows the review-complete prompt.
  const order = [0, 1, 2];
  assert.equal(nextUnreviewed(order, 1, finishedIn([0, 1, 2])), null);
});

test("nextUnreviewed never returns the current file, even when it is unreviewed", () => {
  // The just-approved file is finished in practice, but guard the wrap regardless.
  const order = [0, 1, 2];
  assert.equal(nextUnreviewed(order, 1, finishedIn([0, 2])), null);
});

test("nextUnreviewed treats a hash-invalidated (dropped-out) file as a wrap target", () => {
  // File 0 was signed off then invalidated by an agent edit → back to unreviewed.
  const order = [0, 1, 2];
  assert.equal(nextUnreviewed(order, 2, finishedIn([1, 2])), 0);
});

test("nextUnreviewed starts from the top when cur is not in the order", () => {
  // A diff file absent from the guide order isn't in `order`; scan from the first slot.
  const order = [3, 1, 4];
  assert.equal(nextUnreviewed(order, 99, finishedIn([3])), 1);
});

test("partial guide: approve-advance and wrap reach the unlisted 'Other' files", () => {
  // navOrder() builds guide order followed by changed files the guide didn't list. Here the
  // guide covers files 2 and 0; files 1 and 3 are unlisted, appended in file-array order.
  const order = [2, 0, 1, 3];
  // Approve the last guide-listed file (0) while an unlisted file (1) is still pending →
  // advance must land on it, not dead-end at the end of the guided sequence.
  assert.equal(nextUnreviewed(order, 0, finishedIn([2, 0])), 1);
  // The plain-next wrap likewise targets an unlisted pending file.
  assert.equal(wrapNextTarget(order, finishedIn([2, 0])), 1);
  assert.equal(wrapPrevTarget(order, finishedIn([2, 0])), 3);
});

test("wrapNextTarget lands on the first unreviewed file when work remains", () => {
  assert.equal(wrapNextTarget([3, 1, 4, 0, 2], finishedIn([3, 1])), 4, "guide order");
  assert.equal(wrapNextTarget([0, 1, 2, 3], finishedIn([0])), 1, "file order");
});

test("wrapNextTarget cycles to the first file when everything is reviewed", () => {
  assert.equal(wrapNextTarget([3, 1, 4], finishedIn([3, 1, 4])), 3);
});

test("wrapPrevTarget lands on the last unreviewed file when work remains", () => {
  assert.equal(wrapPrevTarget([3, 1, 4, 0, 2], finishedIn([2, 0])), 4, "guide order");
  assert.equal(wrapPrevTarget([0, 1, 2, 3], finishedIn([3])), 2, "file order");
});

test("wrapPrevTarget cycles to the last file when everything is reviewed", () => {
  assert.equal(wrapPrevTarget([3, 1, 4], finishedIn([3, 1, 4])), 4);
});

test("navFileOrder without a guide is the file array minus fully-skimmed files", () => {
  // Files 1 and 3 are fully skimmed (out of flow) → excluded from the seek order entirely.
  const order = navFileOrder(5, null, (i) => i !== 1 && i !== 3);
  assert.deepEqual(order, [0, 2, 4]);
});

test("navFileOrder with a guide keeps guide order, appends unlisted, drops skimmed", () => {
  // Guide lists 2 then 0; files 1,3,4 are unlisted (appended in array order). File 4 is fully
  // skimmed → dropped; file 1 is skimmed too → dropped; so the seek order is [2, 0, 3].
  const order = navFileOrder(5, [2, 0], (i) => i !== 4 && i !== 1);
  assert.deepEqual(order, [2, 0, 3]);
});

test("seeks over the skim-excluded order never land on a fully-skimmed file", () => {
  // With fully-skimmed files already excluded from navFileOrder, the wrap/advance seeks can only
  // return in-flow indices — the issue-07 guarantee, expressed at the choke point.
  const order = navFileOrder(5, [2, 0], (i) => i !== 4 && i !== 1); // [2, 0, 3]
  const finished = (i: number) => i === 2; // only file 2 signed off
  assert.equal(nextUnreviewed(order, 2, finished), 0);
  assert.equal(wrapNextTarget(order, finished), 0);
  assert.equal(wrapPrevTarget(order, finished), 3);
  for (const t of [nextUnreviewed(order, 2, finished), wrapNextTarget(order, finished)])
    assert.ok(t !== 1 && t !== 4, "a skimmed index is never a seek target");
});

test("empty order yields no target", () => {
  const none = finishedIn([]);
  assert.equal(nextUnreviewed([], 0, none), null);
  assert.equal(wrapNextTarget([], none), null);
  assert.equal(wrapPrevTarget([], none), null);
});
