import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGuide } from "./guide.js";
import { mergeReviewState } from "./state.js";
import type { Guide, ReviewState } from "./types.js";

const validInput = () => ({
  title: "Add API rate limiting",
  overview: "Adds rate limiting.",
  prDescription: "Closes #312.",
  files: [
    {
      path: "src/middleware/rateLimit.ts",
      order: 2,
      category: "Core",
      orientation: "The limiter.",
      flag: "reject path",
    },
    { path: "src/config/limits.ts", order: 1, category: "Config", orientation: "Constants." },
  ],
});

test("validateGuide accepts a well-formed guide and sorts files by order", () => {
  const r = validateGuide(validInput());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.guide.title, "Add API rate limiting");
  assert.equal(r.guide.overview, "Adds rate limiting.");
  assert.equal(r.guide.prDescription, "Closes #312.");
  assert.deepEqual(
    r.guide.files.map((f) => f.path),
    ["src/config/limits.ts", "src/middleware/rateLimit.ts"],
  );
  assert.equal(r.guide.files[1]!.flag, "reject path");
});

test("validateGuide defaults missing order (by position) and category", () => {
  const r = validateGuide({ overview: "x", files: [{ path: "a.ts", orientation: "s" }] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.guide.files[0]!.order, 0);
  assert.equal(r.guide.files[0]!.category, "Changes");
  assert.equal(r.guide.files[0]!.flag, undefined);
});

test("validateGuide rejects malformed input", () => {
  const cases: unknown[] = [
    null,
    "nope",
    { files: [{ path: "a", orientation: "s" }] }, // missing overview
    { overview: "  ", files: [{ path: "a", orientation: "s" }] }, // blank overview
    { overview: "x" }, // missing files
    { overview: "x", files: "no" }, // files not array
    { overview: "x", files: [] }, // empty files
    { overview: "x", files: [{ orientation: "s" }] }, // entry missing path
    { overview: "x", files: [{ path: "a" }] }, // entry missing orientation
  ];
  for (const input of cases) assert.equal(validateGuide(input).ok, false, JSON.stringify(input));
});

// minimal state factory (mirrors state.test.ts)
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

test("mergeReviewState carries an attached guide across a reload", () => {
  const guide: Guide = {
    overview: "o",
    files: [{ path: "a.ts", order: 0, category: "Config", orientation: "s" }],
  };
  const base = state({ baseDiffHash: "new" }); // freshly rebuilt diff — no guide
  const saved = state({ guide }); // live state with the attached guide
  const merged = mergeReviewState(base, saved);
  assert.deepEqual(merged.guide, guide);
  assert.equal(merged.baseDiffHash, "new");
});

test("mergeReviewState leaves guide undefined when none was attached", () => {
  const merged = mergeReviewState(state({}), state({}));
  assert.equal(merged.guide, undefined);
});
