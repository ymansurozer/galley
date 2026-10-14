import { test } from "node:test";
import assert from "node:assert/strict";
import { approvePreview, approveTag, progressSummary } from "./progress-derive.js";

const pending = { outOfFlow: false, state: "pending" } as const;

test("approvePreview: lines mode, the open file's changed lines ahead of the fill", () => {
  // 40 of 200 lines reviewed (20%); the open file weighs 60 lines.
  assert.deepEqual(approvePreview({ done: 40, total: 200, pct: 20 }, { weight: 60, ...pending }), {
    tail: 30,
    after: 50,
  });
});

test("approvePreview: files mode, one file's share", () => {
  // 2 of 6 files (33%); a file weighs 1, so approving it lands on 3 of 6.
  assert.deepEqual(approvePreview({ done: 2, total: 6, pct: 33 }, { weight: 1, ...pending }), {
    tail: 17,
    after: 50,
  });
});

test("approvePreview: the tail ends where the rounded progress will land", () => {
  // 1/3 → 33% now; approving 1 more of 3 lands on 67%, so the tail is 34, not 33.
  assert.deepEqual(approvePreview({ done: 1, total: 3, pct: 33 }, { weight: 1, ...pending }), {
    tail: 34,
    after: 67,
  });
});

test("approvePreview: a skimmed or pure-rename file left the flow, so it has no tail", () => {
  assert.equal(
    approvePreview(
      { done: 40, total: 200, pct: 20 },
      { weight: 60, outOfFlow: true, state: "pending" },
    ),
    null,
  );
});

test("approvePreview: a file already signed off has no tail", () => {
  const p = { done: 100, total: 200, pct: 50 };
  assert.equal(approvePreview(p, { weight: 60, outOfFlow: false, state: "approved" }), null);
  assert.equal(
    approvePreview(p, { weight: 60, outOfFlow: false, state: "changes-requested" }),
    null,
  );
});

test("approvePreview: no open file, no tail", () => {
  assert.equal(approvePreview({ done: 40, total: 200, pct: 20 }, null), null);
});

test("approveTag: a rise reads its gain and where the bar now stands", () => {
  assert.deepEqual(approveTag(20, 50), { gain: 30, to: 50 });
});

test("approveTag: a drop or no movement shows no tag", () => {
  assert.equal(approveTag(50, 20), null);
  assert.equal(approveTag(50, 50), null);
});

test("progressSummary: lines mode names files and lines", () => {
  assert.deepEqual(progressSummary(47, { done: 3, total: 9 }, { done: 120, total: 294 }), {
    pct: "47%",
    detail: "3/9 files · 120/294 lines",
  });
});

test("progressSummary: files mode names files only", () => {
  assert.deepEqual(progressSummary(33, { done: 2, total: 6 }, null), {
    pct: "33%",
    detail: "2/6 files",
  });
});
