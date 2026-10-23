import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangeState, DiffHunk, GuideFile } from "../types.js";
import type { FileReviewState } from "./types.js";
import { lineStats, lineTotals, walkthroughGroups, walkRows } from "./walkthrough.js";

// Hand-built fixtures (only the fields the helpers read are meaningful). A hunk is spelled
// as a kind string — "aadc" = add, add, delete, context.
function hunk(kinds: string): DiffHunk {
  return {
    header: "",
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    lines: [...kinds].map((k, i) => ({
      kind: k === "a" ? "add" : k === "d" ? "delete" : "context",
      text: "",
      diffPosition: i,
      hunkHeader: "",
    })),
  };
}

function file(path: string, ...hunkKinds: string[]) {
  return { path, hunks: hunkKinds.map(hunk) };
}

function guideFile(path: string, category: string, extra: Partial<GuideFile> = {}): GuideFile {
  return { path, order: 0, category, orientation: `about ${path}`, ...extra };
}

const allPending = () => "pending" as FileReviewState;

test("lineStats counts adds and deletes per file, across hunks", () => {
  const stats = lineStats([file("a.ts", "aacd", "ad"), file("b.ts", "ccc"), file("c.ts")]);
  assert.deepEqual(stats.get("a.ts"), { added: 3, removed: 2 });
  assert.deepEqual(stats.get("b.ts"), { added: 0, removed: 0 });
  assert.deepEqual(stats.get("c.ts"), { added: 0, removed: 0 });
});

test("lineStats reads the builder's +/− stamps for a hunk-less file (full-file add)", () => {
  // A hunk-less full-file add has no hunk to sum; the lean builder stamps its whole-content +count.
  const stats = lineStats([
    { path: "new.ts", hunks: [], added: 3, removed: 0 },
    { path: "empty.ts", hunks: [], added: 0, removed: 0 },
  ]);
  assert.deepEqual(stats.get("new.ts"), { added: 3, removed: 0 });
  assert.deepEqual(stats.get("empty.ts"), { added: 0, removed: 0 });
});

test("lineTotals combines the full diff's counts, including hunkless files and metadata", () => {
  assert.deepEqual(
    lineTotals([
      file("modified.ts", "aacd", "ad"),
      { path: "new.ts", hunks: [], added: 7, removed: 0 },
      file("deleted.ts", "dddd"),
      { ...file("stamped.ts", "a"), added: 5, removed: 2 },
      { path: "image.png", hunks: [], added: 0, removed: 0 },
      { path: "renamed.ts", oldPath: "old.ts", newPath: "renamed.ts", hunks: [] },
    ]),
    { added: 15, removed: 8 },
  );
});

test("lineTotals starts from zero for an empty or replaced diff", () => {
  assert.deepEqual(lineTotals([file("before.ts", "aaad")]), { added: 3, removed: 1 });
  assert.deepEqual(lineTotals([file("after.ts", "add")]), { added: 1, removed: 2 });
  assert.deepEqual(lineTotals([]), { added: 0, removed: 0 });
});

test("walkthroughGroups starts a new section each time the category changes (run-length)", () => {
  const groups = walkthroughGroups(
    [
      guideFile("core/a.ts", "Core"),
      guideFile("docs/d.md", "Docs"),
      guideFile("core/b.ts", "Core"),
    ],
    [file("docs/d.md", "a"), file("core/a.ts", "aa"), file("core/b.ts", "d")],
    allPending,
  );
  // The trailing Core does NOT fold back up — it is its own section, so the display mirrors
  // the guide order (Core → Docs → Core) instead of collapsing to two groups.
  assert.deepEqual(
    groups.map((g) => g.category),
    ["Core", "Docs", "Core"],
  );
  assert.deepEqual(
    groups[0]!.files.map((f) => f.path),
    ["core/a.ts"],
  );
  assert.deepEqual(
    groups[2]!.files.map((f) => f.path),
    ["core/b.ts"],
  );
});

test("walkthroughGroups keeps a run together across a guide entry absent from the diff", () => {
  // gone.ts (Other category, not in the diff) is skipped without splitting the Core run.
  const groups = walkthroughGroups(
    [guideFile("a.ts", "Core"), guideFile("gone.ts", "Tests"), guideFile("b.ts", "Core")],
    [file("a.ts", "a"), file("b.ts", "a")],
    allPending,
  );
  assert.deepEqual(
    groups.map((g) => g.category),
    ["Core"],
  );
  assert.deepEqual(
    groups[0]!.files.map((f) => f.path),
    ["a.ts", "b.ts"],
  );
});

test("walkthroughGroups: roll-ups, basename split, and fileIndex into the diff list", () => {
  const groups = walkthroughGroups(
    [
      guideFile("src/ui/a.ts", "Core", { flag: "check the reject path" }),
      guideFile("b.ts", "Core"),
    ],
    [file("b.ts", "d"), file("src/ui/a.ts", "aad")],
    (s) => (s.path === "b.ts" ? "approved" : "pending"),
  );
  const core = groups[0]!;
  assert.equal(core.total, 2);
  assert.equal(core.done, 1);
  assert.equal(core.added, 2);
  assert.equal(core.removed, 2);
  const a = core.files[0]!;
  assert.equal(a.dir, "src/ui/");
  assert.equal(a.name, "a.ts");
  assert.equal(a.fileIndex, 1); // index into the diff's file list, not the guide's
  assert.equal(a.flag, "check the reject path");
  assert.equal(core.files[1]!.state, "approved");
});

test("walkthroughGroups skips guide entries absent from the diff (guideOrder rule)", () => {
  const groups = walkthroughGroups(
    [guideFile("gone.ts", "Ghost"), guideFile("a.ts", "Core")],
    [file("a.ts", "a")],
    allPending,
  );
  assert.deepEqual(
    groups.map((g) => g.category),
    ["Core"],
  );
});

test("walkthroughGroups puts unlisted diff files in a trailing Other group, orientation-less", () => {
  const groups = walkthroughGroups(
    [guideFile("a.ts", "Core")],
    [file("stray.ts", "a"), file("a.ts", "a")],
    allPending,
  );
  assert.equal(groups.length, 2);
  const other = groups[1]!;
  assert.equal(other.other, true);
  assert.equal(other.category, "Other");
  assert.deepEqual(
    other.files.map((f) => [f.path, f.orientation]),
    [["stray.ts", ""]],
  );
});

test("walkthroughGroups with no guide files is just the Other group", () => {
  const groups = walkthroughGroups([], [file("a.ts", "a")], allPending);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.other, true);
});

test("walkRows flattens to cat,file… rows and marks only the active path", () => {
  const groups = walkthroughGroups(
    [guideFile("a.ts", "Core"), guideFile("b.ts", "Core")],
    [file("a.ts", "a"), file("b.ts", "a"), file("stray.ts", "a")],
    (s) => (s.path === "stray.ts" ? "pending" : "approved"),
  );
  const rows = walkRows(groups, "b.ts");
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["cat", "file", "file", "cat", "file"],
  );
  assert.deepEqual(
    rows.map((r) => (r.kind === "file" ? r.cls : "")),
    ["", "", "active", "", ""],
  );
  // Core is fully reviewed → complete; Other still has the pending stray.
  const cats = rows.filter((r) => r.kind === "cat");
  assert.deepEqual(
    cats.map((c) => c.complete),
    [true, false],
  );
});

test("walkRows: no active row while the Overview is showing (null activePath)", () => {
  const groups = walkthroughGroups([guideFile("a.ts", "Core")], [file("a.ts", "a")], allPending);
  const rows = walkRows(groups, null);
  assert.ok(rows.every((r) => r.kind === "cat" || r.cls === ""));
});

test("walkRows: a repeated category yields distinct keys and per-occurrence jumpIndex", () => {
  // Core appears twice (positions 0 and 2 of the guide); the diff orders them differently.
  const groups = walkthroughGroups(
    [guideFile("core/a.ts", "Core"), guideFile("t/b.ts", "Tests"), guideFile("core/c.ts", "Core")],
    [file("t/b.ts", "a"), file("core/a.ts", "a"), file("core/c.ts", "a")],
    allPending,
  );
  const cats = walkRows(groups, null).filter((r) => r.kind === "cat");
  assert.deepEqual(
    cats.map((c) => c.category),
    ["Core", "Tests", "Core"],
  );
  // Keys must be unique so Alpine's x-for never reuses a header DOM node across runs.
  assert.equal(new Set(cats.map((c) => c.key)).size, cats.length);
  // Each Core header jumps to ITS OWN file (diff indices: a.ts=1, c.ts=2), not the first Core.
  assert.equal(cats[0]!.kind === "cat" && cats[0]!.jump.fileIndex, 1);
  assert.equal(cats[2]!.kind === "cat" && cats[2]!.jump.fileIndex, 2);
});

test("walkthroughGroups gathers fully-skimmed files into one trailing Skimmed group", () => {
  // a.ts and stray.ts are fully skimmed → they leave their normal groups (Core / Other) and
  // collect in a trailing "Skimmed" group; b.ts stays in Core.
  const groups = walkthroughGroups(
    [guideFile("a.ts", "Core"), guideFile("b.ts", "Core")],
    [file("a.ts", "a"), file("b.ts", "a"), file("stray.ts", "a")],
    allPending,
    (p) => p === "a.ts" || p === "stray.ts",
  );
  assert.deepEqual(
    groups.map((g) => g.category),
    ["Core", "Skimmed"],
  );
  const core = groups[0]!;
  assert.deepEqual(
    core.files.map((f) => f.path),
    ["b.ts"],
  );
  const skim = groups[1]!;
  assert.equal(skim.skimmed, true);
  assert.equal(skim.total, 2);
  assert.deepEqual(
    skim.files.map((f) => f.path),
    ["a.ts", "stray.ts"], // guide-listed first, then the unlisted stray
  );
});

test("walkthroughGroups: a skimmed file between same-category files does not split the run", () => {
  // a and c are Core with b (Core, skimmed) between them — the run must stay one Core group.
  const groups = walkthroughGroups(
    [guideFile("a.ts", "Core"), guideFile("b.ts", "Core"), guideFile("c.ts", "Core")],
    [file("a.ts", "a"), file("b.ts", "a"), file("c.ts", "a")],
    allPending,
    (p) => p === "b.ts",
  );
  assert.deepEqual(
    groups.map((g) => g.category),
    ["Core", "Skimmed"],
  );
  assert.deepEqual(
    groups[0]!.files.map((f) => f.path),
    ["a.ts", "c.ts"],
  );
});

test("walkRows hides the Skimmed group's file rows until expanded", () => {
  const groups = walkthroughGroups(
    [guideFile("a.ts", "Core"), guideFile("b.ts", "Core")],
    [file("a.ts", "a"), file("b.ts", "a")],
    allPending,
    (p) => p === "b.ts",
  );
  // Collapsed (default): the Skimmed header shows, its file row does not.
  const collapsed = walkRows(groups, null, false);
  assert.deepEqual(
    collapsed.map((r) => r.kind),
    ["cat", "file", "cat"],
  );
  const skimCat = collapsed.find((r) => r.kind === "cat" && r.skimmed);
  assert.ok(skimCat && skimCat.kind === "cat" && !skimCat.open);
  // Expanded: the skimmed file row appears under its header.
  const expanded = walkRows(groups, null, true);
  assert.deepEqual(
    expanded.map((r) => r.kind),
    ["cat", "file", "cat", "file"],
  );
  const skimCatOpen = expanded.find((r) => r.kind === "cat" && r.skimmed);
  assert.ok(skimCatOpen && skimCatOpen.kind === "cat" && skimCatOpen.open);
});

test("walkRows: a category-header jumpIndex prefers the group's first pending file", () => {
  // core/a is approved, core/c is pending → the header should land on core/c (diff index 2).
  const groups = walkthroughGroups(
    [guideFile("core/a.ts", "Core"), guideFile("core/c.ts", "Core")],
    [file("x.ts", "a"), file("core/a.ts", "a"), file("core/c.ts", "a")],
    (s) => (s.path === "core/a.ts" ? "approved" : "pending"),
  );
  const cat = walkRows(groups, null).find((r) => r.kind === "cat");
  assert.equal(cat!.kind === "cat" && cat!.jump.fileIndex, 2);
});

test("walkthroughGroups: a pure rename gets movedFrom and folds into the Skimmed group (issue 01)", () => {
  const files = [
    file("core/a.ts", "aa"),
    { path: "lib/new.ts", hunks: [], oldPath: "lib/old.ts", newPath: "lib/new.ts" },
  ];
  const groups = walkthroughGroups(
    [guideFile("core/a.ts", "Core")],
    files,
    allPending,
    (p) => p === "lib/new.ts", // the moved file has left the main flow
  );
  const skim = groups.find((g) => g.skimmed);
  assert.ok(skim);
  assert.equal(skim!.files.length, 1);
  assert.equal(skim!.files[0]!.path, "lib/new.ts");
  assert.equal(skim!.files[0]!.movedFrom, "lib/old.ts"); // drives the "← old" arrow
  const core = groups.find((g) => g.category === "Core");
  assert.equal(core!.files[0]!.movedFrom, ""); // a normal edit is not a rename
});

// ── Guide parts: a split file walks as one row per part, plus its Rest ───────
// account.ts is split into Fees (guide entry 0, Billing) and Lockout (entry 2, Auth); a.ts sits
// between them. Block counts ride the stableKey (`side:line:deletions:additions`).
function partEntry(title: string, category: string): GuideFile {
  return guideFile("src/account.ts", category, { part: { title, lines: [1] } });
}
const SPLIT_GUIDE = [
  partEntry("Fees", "Billing"),
  guideFile("a.ts", "Core"),
  partEntry("Lockout", "Auth"),
];
const SPLIT_FILES = [file("a.ts", "a"), file("src/account.ts", "aaaddaad")];
function block(stableKey: string, part?: number, skim = false): ChangeState {
  return {
    id: `src/account.ts:${stableKey}`,
    path: "src/account.ts",
    hunkIndex: 0,
    side: "additions",
    lineNumber: 1,
    title: "",
    stableKey,
    status: "pending",
    ...(part === undefined ? {} : { part }),
    ...(skim ? { skim: {} } : {}),
  };
}
const blocksOf =
  (blocks: ChangeState[]) =>
  (path: string): ChangeState[] =>
    path === "src/account.ts" ? blocks : [];

test("walkthroughGroups gives each part of a split file its own row, in its own category", () => {
  const groups = walkthroughGroups(
    SPLIT_GUIDE,
    SPLIT_FILES,
    allPending,
    () => false,
    blocksOf([
      block("additions:10:0:3", 0),
      block("additions:20:1:1", 0),
      block("deletions:40:2:0", 2),
    ]),
  );
  assert.deepEqual(
    groups.map((g) => [g.category, g.files.map((f) => [f.name, f.partTitle, f.part])]),
    [
      ["Billing", [["account.ts", "Fees", 0]]],
      ["Core", [["a.ts", "", undefined]]],
      ["Auth", [["account.ts", "Lockout", 2]]],
    ],
  );
  // Each part counts only its own blocks: Fees +3 −0 and +1 −1, Lockout −2.
  const [fees, lockout] = [groups[0]!.files[0]!, groups[2]!.files[0]!];
  assert.deepEqual([fees.added, fees.removed], [4, 1]);
  assert.deepEqual([lockout.added, lockout.removed], [0, 2]);
  assert.deepEqual([groups[0]!.added, groups[0]!.removed], [4, 1]);
  assert.equal(
    groups.some((g) => g.other),
    false,
    "every block is claimed: no Rest row",
  );
});

test("walkthroughGroups puts a Rest row in Other only while a block is unclaimed", () => {
  const groups = walkthroughGroups(
    SPLIT_GUIDE,
    [...SPLIT_FILES, file("stray.ts", "a")],
    allPending,
    () => false,
    blocksOf([
      block("additions:10:0:3", 0),
      block("additions:40:0:1", 2),
      block("additions:60:2:5"),
    ]),
  );
  const other = groups.find((g) => g.other)!;
  assert.deepEqual(
    other.files.map((f) => [f.path, f.part, f.added, f.removed]),
    [
      ["src/account.ts", "rest", 5, 2],
      ["stray.ts", undefined, 1, 0],
    ],
  );
  assert.equal(other.files[0]!.orientation, "", "Rest carries no part's orientation");
});

test("walkthroughGroups sends a fully skimmed part to Skimmed and keeps its sibling in the flow", () => {
  const groups = walkthroughGroups(
    SPLIT_GUIDE,
    SPLIT_FILES,
    allPending,
    () => false, // the file as a whole is not fully skimmed
    blocksOf([block("additions:10:0:3", 0, true), block("additions:40:0:1", 2)]),
  );
  assert.deepEqual(
    groups.map((g) => [g.category, g.files.map((f) => f.partTitle || f.name)]),
    [
      ["Core", ["a.ts"]],
      ["Auth", ["Lockout"]],
      ["Skimmed", ["Fees"]],
    ],
  );
});

test("walkRows counts a group's rows as steps once it lists a part, else as files", () => {
  const withPart = walkthroughGroups(
    SPLIT_GUIDE,
    [...SPLIT_FILES, file("b.ts", "a")],
    allPending,
    (p) => p === "b.ts",
    blocksOf([block("additions:10:0:3", 0, true), block("additions:40:0:1", 2)]),
  );
  const header = (groups: ReturnType<typeof walkthroughGroups>) =>
    walkRows(groups).find((r) => r.kind === "cat" && r.skimmed);
  // Skimmed holds the Fees part and b.ts.
  const skimmed = header(withPart);
  assert.equal(skimmed?.kind === "cat" && skimmed.count, "2 steps");
  const wholeFiles = walkthroughGroups(
    [guideFile("a.ts", "Core"), guideFile("b.ts", "Core")],
    [file("a.ts", "a"), file("b.ts", "a")],
    allPending,
    (p) => p === "b.ts",
  );
  const files = header(wholeFiles);
  assert.equal(files?.kind === "cat" && files.count, "1 file");
});

test("walkthroughGroups gives each part row its own step's state, and counts it in its group", () => {
  const groups = walkthroughGroups(
    [partEntry("Fees", "Billing"), partEntry("Lockout", "Billing")],
    SPLIT_FILES,
    (s) => (s.step.part === 0 ? "approved" : "pending"),
    () => false,
    blocksOf([block("additions:10:0:3", 0), block("additions:40:0:1", 1)]),
  );
  const billing = groups[0]!;
  assert.deepEqual(
    billing.files.map((f) => [f.partTitle, f.state]),
    [
      ["Fees", "approved"],
      ["Lockout", "pending"],
    ],
  );
  assert.deepEqual([billing.done, billing.total], [1, 2]);
  const header = walkRows(groups, null).find((r) => r.kind === "cat");
  assert.deepEqual(header?.kind === "cat" && header.jump, { fileIndex: 1, part: 1 });
});

test("walkRows keys each part row apart and a category header jumps to the part's step", () => {
  const groups = walkthroughGroups(
    SPLIT_GUIDE,
    SPLIT_FILES,
    allPending,
    () => false,
    blocksOf([
      block("additions:10:0:3", 0),
      block("additions:40:0:1", 2),
      block("additions:60:0:1"),
    ]),
  );
  const rows = walkRows(groups, null);
  assert.deepEqual(
    rows.filter((r) => r.kind === "file").map((r) => r.key),
    ["part:0:src/account.ts", "file:a.ts", "part:2:src/account.ts", "rest:src/account.ts"],
  );
  const auth = rows.find((r) => r.kind === "cat" && r.category === "Auth");
  assert.deepEqual(auth!.kind === "cat" && auth!.jump, { fileIndex: 1, part: 2 });
});
