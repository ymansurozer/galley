import { test } from "node:test";
import assert from "node:assert/strict";
import { sameGuide, validateGuide } from "./guide.js";
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

test("sameGuide compares guides whatever diff each was stamped against, as stored", () => {
  const valid = () => {
    const r = validateGuide(validInput());
    assert.ok(r.ok);
    return r.guide;
  };
  const stored: Guide = JSON.parse(JSON.stringify({ ...valid(), baseDiffHash: "d1" }));
  assert.ok(sameGuide(valid(), stored));
  const regrouped = valid();
  regrouped.files[0]!.category = "Elsewhere";
  assert.ok(!sameGuide(regrouped, stored));
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

// A topics guide: stages hold groups, groups hold topics, each topic covers part of the diff.
const topicsInput = () => ({
  title: "Rate limiting",
  overview: "Adds rate limiting.",
  stages: [
    {
      id: "edge",
      label: "Edge",
      groups: [
        {
          id: "limits",
          title: "Limits",
          summary: "Where the limit is enforced.",
          topics: [
            {
              id: "per-key",
              title: "Limit per API key",
              recorded: "Only the code records this call.",
              body: "The limiter keys on the API key.",
              concern: "Behaviour",
              flag: "Shared keys hit the limit together.",
              covers: [{ path: "src/limit.ts" }, { path: "src/config/", lines: [3, [9, 7]] }],
              pages: ["/settings"],
            },
          ],
        },
      ],
    },
    {
      id: "data",
      label: "Data",
      groups: [
        {
          id: "store",
          title: "Store",
          topics: [
            {
              id: "redis",
              title: "Counters in Redis",
              recorded: "ADR 12",
              body: "Counters live in Redis.",
              covers: [{ path: "src/store.ts" }],
            },
          ],
        },
      ],
    },
  ],
});

// The validation's refusal, asserting it was one.
function refusal(input: unknown) {
  const r = validateGuide(input);
  assert.equal(r.ok, false, JSON.stringify(input));
  return r.ok ? "" : r.reason;
}

test("validateGuide accepts a guide with stages and no files, keeping its stages in order", () => {
  const r = validateGuide(topicsInput());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.guide.files, undefined);
  assert.deepEqual(
    r.guide.stages?.map((s) => s.id),
    ["edge", "data"],
  );
  const topic = r.guide.stages![0]!.groups[0]!.topics[0]!;
  assert.deepEqual(topic, {
    id: "per-key",
    title: "Limit per API key",
    recorded: "Only the code records this call.",
    body: "The limiter keys on the API key.",
    concern: "Behaviour",
    flag: "Shared keys hit the limit together.",
    covers: [{ path: "src/limit.ts" }, { path: "src/config/", lines: [3, [7, 9]] }],
    pages: ["/settings"],
  });
  assert.equal(r.guide.stages![0]!.groups[0]!.summary, "Where the limit is enforced.");
  const bare = r.guide.stages![1]!.groups[0]!;
  assert.equal(bare.summary, undefined);
  assert.deepEqual(Object.keys(bare.topics[0]!).sort(), [
    "body",
    "covers",
    "id",
    "recorded",
    "title",
  ]);
});

test("validateGuide accepts a guide with both files and stages", () => {
  const r = validateGuide({ ...topicsInput(), files: validInput().files });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.guide.files?.length, 2);
  assert.equal(r.guide.stages?.length, 2);
});

test("validateGuide refuses a guide with neither files nor stages", () => {
  assert.match(refusal({ overview: "x" }), /guide needs files or stages/);
});

test("validateGuide refuses each missing required field on a stage, group and topic, naming it", () => {
  const cases: Array<[string, (g: ReturnType<typeof topicsInput>) => void, RegExp]> = [
    [
      "stage id",
      (g) => delete (g.stages[0] as Partial<(typeof g.stages)[0]>).id,
      /guide\.stages\[0\]\.id must be a non-empty string/,
    ],
    [
      "stage label",
      (g) => delete (g.stages[1] as Partial<(typeof g.stages)[1]>).label,
      /guide\.stages\[1\] \("data"\)\.label must be a non-empty string/,
    ],
    [
      "stage groups",
      (g) => delete (g.stages[0] as Partial<(typeof g.stages)[0]>).groups,
      /guide\.stages\[0\] \("edge"\)\.groups must be a non-empty array/,
    ],
    [
      "group id",
      (g) => delete (g.stages[0]!.groups[0] as Partial<(typeof g.stages)[0]["groups"][0]>).id,
      /guide\.stages\[0\]\.groups\[0\]\.id must be a non-empty string/,
    ],
    [
      "group title",
      (g) => delete (g.stages[0]!.groups[0] as Partial<(typeof g.stages)[0]["groups"][0]>).title,
      /guide\.stages\[0\]\.groups\[0\] \("limits"\)\.title must be a non-empty string/,
    ],
    [
      "group topics",
      (g) => delete (g.stages[0]!.groups[0] as Partial<(typeof g.stages)[0]["groups"][0]>).topics,
      /guide\.stages\[0\]\.groups\[0\] \("limits"\)\.topics must be a non-empty array/,
    ],
  ];
  const topicFields = ["id", "title", "recorded", "body", "covers"] as const;
  for (const field of topicFields) {
    const g = topicsInput();
    delete (g.stages[0]!.groups[0]!.topics[0] as Partial<Record<string, unknown>>)[field];
    const at =
      field === "id"
        ? "guide\\.stages\\[0\\]\\.groups\\[0\\]\\.topics\\[0\\]"
        : 'guide\\.stages\\[0\\]\\.groups\\[0\\]\\.topics\\[0\\] \\("per-key"\\)';
    const kind = field === "covers" ? "a non-empty array" : "a non-empty string";
    assert.match(refusal(g), new RegExp(`${at}\\.${field} must be ${kind}`), field);
  }
  for (const [name, mutate, expected] of cases) {
    const g = topicsInput();
    mutate(g);
    assert.match(refusal(g), expected, name);
  }
});

test("validateGuide refuses malformed covers, naming the topic and the entry", () => {
  const withCovers = (covers: unknown) => {
    const g = topicsInput();
    (g.stages[0]!.groups[0]!.topics[0] as { covers: unknown }).covers = covers;
    return g;
  };
  assert.match(refusal(withCovers([])), /\("per-key"\)\.covers must be a non-empty array/);
  assert.match(
    refusal(withCovers([{ lines: [1] }])),
    /\("per-key"\)\.covers\[0\]\.path must be a non-empty string/,
  );
  assert.match(
    refusal(withCovers([{ path: "a.ts", lines: [] }])),
    /\("per-key"\)\.covers\[0\]\.lines \(on "a\.ts"\) must be a non-empty array of line numbers and \[start, end\] pairs/,
  );
  assert.match(
    refusal(withCovers([{ path: "a.ts" }, { path: "b.ts", lines: ["x"] }])),
    /\("per-key"\)\.covers\[1\]\.lines \(on "b\.ts"\)/,
  );
});

test("validateGuide refuses duplicate stage, group and topic ids, naming the id", () => {
  const stage = topicsInput();
  stage.stages[1]!.id = "edge";
  assert.match(refusal(stage), /two stages share the id "edge"/);
  const group = topicsInput();
  group.stages[1]!.groups[0]!.id = "limits";
  assert.match(refusal(group), /two groups share the id "limits"/);
  const topic = topicsInput();
  topic.stages[1]!.groups[0]!.topics[0]!.id = "per-key";
  assert.match(refusal(topic), /two topics share the id "per-key"/);
  // A thread on the Overview names it "overview", so no topic may.
  const overview = topicsInput();
  overview.stages[1]!.groups[0]!.topics[0]!.id = "overview";
  assert.match(refusal(overview), /\("overview"\)\.id "overview" is taken: it names the Overview/);
});

test("validateGuide refuses malformed optional topic fields", () => {
  const g = topicsInput();
  (g.stages[0]!.groups[0]!.topics[0] as { pages: unknown }).pages = "/settings";
  assert.match(refusal(g), /\("per-key"\)\.pages must be an array of strings/);
  const s = topicsInput();
  (s as { stages: unknown }).stages = [];
  assert.match(refusal(s), /guide\.stages must be a non-empty array/);
});

// Links join two groups with a short label; Galley draws the map from them.
const withLinks = (links: unknown) => ({ ...topicsInput(), links });

test("validateGuide keeps a guide's links, a 40-character label included", () => {
  const label = "x".repeat(40);
  const r = validateGuide(withLinks([{ from: "limits", to: "store", label }]));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.guide.links, [{ from: "limits", to: "store", label }]);
});

test("validateGuide refuses a link to an unknown group, a self link and a long label, naming the link", () => {
  assert.match(
    refusal(withLinks([{ from: "limits", to: "ghost", label: "counts" }])),
    /guide\.links\[0\] \(limits → ghost\): "ghost" is not a group id/,
  );
  assert.match(
    refusal(withLinks([{ from: "store", to: "store", label: "counts" }])),
    /guide\.links\[0\] \(store → store\) joins a group to itself/,
  );
  assert.match(
    refusal(
      withLinks([
        { from: "limits", to: "store", label: "ok" },
        { from: "store", to: "limits", label: "y".repeat(41) },
      ]),
    ),
    /guide\.links\[1\] \(store → limits\): the label is 41 characters; the limit is 40/,
  );
});

test("validateGuide refuses malformed links, a repeated link and links without stages", () => {
  assert.match(refusal(withLinks({})), /guide\.links must be an array/);
  assert.match(refusal(withLinks(["a"])), /guide\.links\[0\] must be an object/);
  assert.match(
    refusal(withLinks([{ from: "limits", label: "x" }])),
    /guide\.links\[0\]\.to must be a non-empty string/,
  );
  assert.match(
    refusal(withLinks([{ from: "limits", to: "store" }])),
    /guide\.links\[0\] \(limits → store\)\.label must be a non-empty string/,
  );
  assert.match(
    refusal(
      withLinks([
        { from: "limits", to: "store", label: "a" },
        { from: "limits", to: "store", label: "b" },
      ]),
    ),
    /guide\.links\[1\] \(limits → store\) repeats a link/,
  );
  assert.match(
    refusal({ ...validInput(), links: [{ from: "a", to: "b", label: "x" }] }),
    /guide\.links needs stages/,
  );
});

test("skims require a reason and normalize covers with optional reviewer rule", () => {
  assert.deepEqual(validateGuide({ ...topicsInput(), skims: [{ covers: [{ path: "a" }] }] }), {
    ok: false,
    reason: "guide.skims[0].reason must be a non-empty string",
  });
  const r = validateGuide({
    ...topicsInput(),
    skims: [{ reason: "Generated", rule: "Churn", covers: [{ path: "a", lines: [[8, 3]] }] }],
  });
  assert.ok(r.ok);
  if (r.ok)
    assert.deepEqual(r.guide.skims, [
      { reason: "Generated", rule: "Churn", covers: [{ path: "a", lines: [[3, 8]] }] },
    ]);
});

test("validateGuide refuses skims without stages", () => {
  assert.deepEqual(validateGuide({ ...validInput(), skims: [] }), {
    ok: false,
    reason: "guide.skims needs stages",
  });
});
