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
  return { path, order: 0, category, summary: `about ${path}`, ...extra };
}

const allPending = () => "pending" as FileReviewState;

test("lineStats counts adds and deletes per file, across hunks", () => {
  const stats = lineStats([file("a.ts", "aacd", "ad"), file("b.ts", "ccc"), file("c.ts")]);
  assert.deepEqual(stats.get("a.ts"), { added: 3, removed: 2 });
  assert.deepEqual(stats.get("b.ts"), { added: 0, removed: 0 });
  assert.deepEqual(stats.get("c.ts"), { added: 0, removed: 0 });
});

test("walkthroughGroups groups by category in first-occurrence guide order", () => {
  const groups = walkthroughGroups(
    [
      guideFile("core/a.ts", "Core"),
      guideFile("docs/d.md", "Docs"),
      guideFile("core/b.ts", "Core"),
    ],
    [file("docs/d.md", "a"), file("core/a.ts", "aa"), file("core/b.ts", "d")],
    allPending,
  );
  assert.deepEqual(
    groups.map((g) => g.category),
    ["Core", "Docs"],
  );
  assert.deepEqual(
    groups[0]!.files.map((f) => f.path),
    ["core/a.ts", "core/b.ts"],
  );
});

test("walkthroughGroups: roll-ups, basename split, and fileIndex into the diff list", () => {
  const groups = walkthroughGroups(
    [guideFile("src/ui/a.ts", "Core", { critical: true }), guideFile("b.ts", "Core")],
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
  assert.equal(a.critical, true);
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

test("walkthroughGroups puts unlisted diff files in a trailing Other group, summary-less", () => {
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
    other.files.map((f) => [f.path, f.summary]),
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
