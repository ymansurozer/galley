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

test("validateGuide makes orientation optional only on whole-file skim entries", () => {
  const reason = "guide.files[0].orientation must be a non-empty string";
  const one = (entry: Record<string, unknown>) =>
    validateGuide({ overview: "o", files: [{ path: "a.ts", ...entry }] });
  const skimmed = one({ skim: true, skimReason: "lockfile churn" });
  assert.ok(skimmed.ok);
  if (skimmed.ok) {
    assert.equal(skimmed.guide.files[0]!.orientation, undefined);
    assert.equal(skimmed.guide.files[0]!.skimReason, "lockfile churn");
  }
  // Present on a skim entry, it must still be non-empty.
  assert.deepEqual(one({ skim: true, orientation: "  " }), { ok: false, reason });
  // Partial skims and unskimmed entries stay in the review flow, so they still need one.
  assert.deepEqual(one({ skimBlocks: [{ lines: 3 }] }), { ok: false, reason });
  assert.deepEqual(one({ skim: "yes" }), { ok: false, reason });
  assert.deepEqual(one({}), { ok: false, reason });
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

// ── Guide parts: one file split into several review steps ────────────────────
const partEntry = (title: unknown, lines: unknown, extra: Record<string, unknown> = {}) => ({
  path: "src/account.ts",
  orientation: `about ${String(title)}`,
  part: { title, lines },
  ...extra,
});

test("validateGuide accepts a file split into parts, keeping each part's own entry", () => {
  const r = validateGuide({
    overview: "o",
    files: [
      { ...partEntry("Fee charging", [[10, 14], 30]), category: "Billing" },
      { path: "src/billing.ts", orientation: "Ledger." },
      { ...partEntry("Lockout", [[60, 52]]), category: "Auth", flag: "check the window" },
    ],
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  const [fees, , lockout] = r.guide.files;
  assert.deepEqual(fees!.part, { title: "Fee charging", lines: [[10, 14], 30] });
  assert.equal(fees!.category, "Billing");
  // A reversed span is ordered ascending, as skimBlocks spans are.
  assert.deepEqual(lockout!.part, { title: "Lockout", lines: [[52, 60]] });
  assert.equal(lockout!.flag, "check the window");
});

test("validateGuide rejects a split file with an entry that has no part, naming the path", () => {
  const r = validateGuide({
    overview: "o",
    files: [partEntry("Fee charging", [10]), { path: "src/account.ts", orientation: "Whole." }],
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /src\/account\.ts/);
  assert.match(r.reason, /part/);
  // The same path twice with no part at all is the same mistake.
  const plain = validateGuide({
    overview: "o",
    files: [
      { path: "a.ts", orientation: "s" },
      { path: "a.ts", orientation: "t" },
    ],
  });
  assert.equal(plain.ok, false);
  if (!plain.ok) assert.match(plain.reason, /a\.ts/);
});

test("validateGuide rejects two parts of one file with the same title, naming path and title", () => {
  const r = validateGuide({
    overview: "o",
    files: [
      partEntry("Fees", [3]),
      { path: "other.ts", orientation: "s", part: { title: "Fees", lines: [1] } },
      partEntry("Fees", [9]),
    ],
  });
  assert.deepEqual(r, {
    ok: false,
    reason:
      'guide.files[2] repeats part "Fees" on "src/account.ts" — each part of a file needs its own title',
  });
});

test("validateGuide rejects part combined with skim or movedFrom, naming the field", () => {
  const withSkim = validateGuide({
    overview: "o",
    files: [partEntry("Fees", [3], { skim: true })],
  });
  assert.deepEqual(withSkim, {
    ok: false,
    reason: 'guide.files[0] (part "Fees" on "src/account.ts") cannot set both part and skim',
  });
  const withMove = validateGuide({
    overview: "o",
    files: [partEntry("Fees", [3], { movedFrom: "old.ts" })],
  });
  assert.deepEqual(withMove, {
    ok: false,
    reason: 'guide.files[0] (part "Fees" on "src/account.ts") cannot set both part and movedFrom',
  });
});

test("validateGuide rejects a part with a blank title, naming the field", () => {
  for (const title of [undefined, "", "   ", 7])
    assert.deepEqual(validateGuide({ overview: "o", files: [partEntry(title, [3])] }), {
      ok: false,
      reason: 'guide.files[0].part.title (on "src/account.ts") must be a non-empty string',
    });
});

test("validateGuide rejects empty or malformed part lines, naming the field", () => {
  const bad = (lines: unknown) => validateGuide({ overview: "o", files: [partEntry("P", lines)] });
  const reason =
    'guide.files[0].part.lines (part "P" on "src/account.ts") must be a non-empty array of line numbers and [start, end] pairs';
  for (const lines of [undefined, [], "3", 3, [[1, 2, 3]], [[1]], ["x"], [[1, "2"]], [NaN]])
    assert.deepEqual(bad(lines), { ok: false, reason }, JSON.stringify(lines));
  // part itself must be an object
  assert.deepEqual(
    validateGuide({ overview: "o", files: [{ path: "a.ts", orientation: "s", part: "x" }] }),
    {
      ok: false,
      reason: 'guide.files[0].part (on "a.ts") must be an object with a title and lines',
    },
  );
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
