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

test("validateGuide accepts skim fields and normalizes skimBlocks lines", () => {
  const r = validateGuide({
    overview: "o",
    files: [
      {
        path: "a.ts",
        orientation: "s",
        skim: true,
        skimReason: "generated",
        skimBlocks: [{ lines: 5, reason: "import" }, { lines: [12, 10] }],
      },
    ],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  const f = r.guide.files[0]!;
  assert.equal(f.skim, true);
  assert.equal(f.skimReason, "generated");
  // a bare number normalizes to [n, n]; a reversed pair is ordered ascending.
  assert.deepEqual(f.skimBlocks, [{ lines: [5, 5], reason: "import" }, { lines: [10, 12] }]);
});

test("validateGuide leaves skim fields unset when absent", () => {
  const r = validateGuide({ overview: "o", files: [{ path: "a.ts", orientation: "s" }] });
  assert.ok(r.ok);
  if (!r.ok) return;
  const f = r.guide.files[0]!;
  assert.equal(f.skim, undefined);
  assert.equal(f.skimReason, undefined);
  assert.equal(f.skimBlocks, undefined);
});

test("validateGuide carries focused as a boolean and rejects other types (issue 04)", () => {
  const on = validateGuide({
    overview: "o",
    focused: true,
    files: [{ path: "a.ts", orientation: "s" }],
  });
  assert.ok(on.ok);
  if (on.ok) assert.equal(on.guide.focused, true);
  // Omitted → undefined (a plain guide renders no badge).
  const off = validateGuide({ overview: "o", files: [{ path: "a.ts", orientation: "s" }] });
  assert.ok(off.ok);
  if (off.ok) assert.equal(off.guide.focused, undefined);
  // Non-boolean → rejected.
  assert.equal(
    validateGuide({ overview: "o", focused: "yes", files: [{ path: "a.ts", orientation: "s" }] })
      .ok,
    false,
  );
});

test("validateGuide accepts movedFrom and rejects it with skimBlocks (issue 03)", () => {
  // movedFrom alone (and with whole-file skim) is fine — shape only; diff resolution is later.
  const ok = validateGuide({
    overview: "o",
    files: [{ path: "b.ts", orientation: "s", movedFrom: "a.ts", skim: true }],
  });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.guide.files[0]!.movedFrom, "a.ts");
    assert.equal(ok.guide.files[0]!.skim, true);
  }
  // Empty/non-string movedFrom is rejected.
  assert.equal(
    validateGuide({ overview: "o", files: [{ path: "b.ts", orientation: "s", movedFrom: "  " }] })
      .ok,
    false,
  );
  // movedFrom + skimBlocks on one entry is a validation error (no rawDiff section to resolve spans).
  assert.equal(
    validateGuide({
      overview: "o",
      files: [{ path: "b.ts", orientation: "s", movedFrom: "a.ts", skimBlocks: [{ lines: 3 }] }],
    }).ok,
    false,
  );
});

test("validateGuide rejects malformed skimBlocks", () => {
  const bad = (skimBlocks: unknown) =>
    validateGuide({ overview: "o", files: [{ path: "a.ts", orientation: "s", skimBlocks }] }).ok;
  assert.equal(bad("nope"), false); // not an array
  assert.equal(bad([null]), false); // entry not an object
  assert.equal(bad([{ lines: "x" }]), false); // lines not a number/pair
  assert.equal(bad([{ lines: [1] }]), false); // wrong-length pair
  assert.equal(bad([{ lines: [1, 2, 3] }]), false); // wrong-length pair
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

test("mergeReviewState carries an attached guide across a reload", async () => {
  const guide: Guide = {
    overview: "o",
    files: [{ path: "a.ts", order: 0, category: "Config", orientation: "s" }],
  };
  const base = state({ baseDiffHash: "new" }); // freshly rebuilt diff — no guide
  const saved = state({ guide }); // live state with the attached guide
  const merged = await mergeReviewState(base, saved);
  assert.deepEqual(merged.guide, guide);
  assert.equal(merged.baseDiffHash, "new");
});

test("mergeReviewState leaves guide undefined when none was attached", async () => {
  const merged = await mergeReviewState(state({}), state({}));
  assert.equal(merged.guide, undefined);
});
