import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffHunk, GuideFile } from "../types.js";
import type { FileReviewState } from "./types.js";
import { lineStats, walkthroughGroups, walkRows } from "./walkthrough.js";

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

test("lineStats counts a hunk-less new file's whole content as additions", () => {
  // New files have no old side, so git emits no hunk — count the new content as all-added.
  const stats = lineStats([
    { path: "new.ts", hunks: [], oldFile: { contents: "" }, newFile: { contents: "a\nb\nc\n" } },
    { path: "nonl.ts", hunks: [], oldFile: { contents: "" }, newFile: { contents: "a\nb" } },
    { path: "empty.ts", hunks: [], oldFile: { contents: "" }, newFile: { contents: "" } },
  ]);
  assert.deepEqual(stats.get("new.ts"), { added: 3, removed: 0 }); // trailing newline trimmed
  assert.deepEqual(stats.get("nonl.ts"), { added: 2, removed: 0 }); // no trailing newline
  assert.deepEqual(stats.get("empty.ts"), { added: 0, removed: 0 }); // empty new file stays 0
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
    (p) => (p === "b.ts" ? "approved" : "pending"),
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
    (p) => (p === "stray.ts" ? "pending" : "approved"),
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
  assert.equal(cats[0]!.kind === "cat" && cats[0]!.jumpIndex, 1);
  assert.equal(cats[2]!.kind === "cat" && cats[2]!.jumpIndex, 2);
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
    (p) => (p === "core/a.ts" ? "approved" : "pending"),
  );
  const cat = walkRows(groups, null).find((r) => r.kind === "cat");
  assert.equal(cat!.kind === "cat" && cat!.jumpIndex, 2);
});
