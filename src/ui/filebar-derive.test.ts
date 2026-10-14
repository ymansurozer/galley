import { test } from "node:test";
import assert from "node:assert/strict";
import { fileBarActions, splitPath } from "./filebar-derive.js";

const pending = {
  finished: false,
  objections: false,
  blockers: 0,
  hasDecisions: false,
  skimExpanded: false,
};

test("a clean unfinished file offers only Approve File", () => {
  assert.deepEqual(fileBarActions(pending), ["approve"]);
});

test("an unfinished file with objections offers Mark Reviewed after its blockers", () => {
  assert.deepEqual(fileBarActions({ ...pending, objections: true, blockers: 2 }), [
    "blockers",
    "mark",
  ]);
});

test("an unfinished file with hunk decisions leads with Reset", () => {
  assert.deepEqual(fileBarActions({ ...pending, hasDecisions: true }), ["reset", "approve"]);
});

test("an expanded skimmed file leads with Collapse, before Reset and the blockers", () => {
  assert.deepEqual(
    fileBarActions({
      ...pending,
      skimExpanded: true,
      hasDecisions: true,
      objections: true,
      blockers: 1,
    }),
    ["collapse", "reset", "blockers", "mark"],
  );
});

test("a finished clean file shows the quiet Approved state, then Reset", () => {
  assert.deepEqual(fileBarActions({ ...pending, finished: true }), ["approved", "reset"]);
});

test("a finished file with objections shows its blockers, Reviewed with requests, then Reset", () => {
  assert.deepEqual(fileBarActions({ ...pending, finished: true, objections: true, blockers: 3 }), [
    "blockers",
    "reviewed",
    "reset",
  ]);
});

test("a finished file offers Reset whether or not it has hunk decisions", () => {
  assert.deepEqual(fileBarActions({ ...pending, finished: true, hasDecisions: true }), [
    "approved",
    "reset",
  ]);
});

test("an expanded skimmed file keeps Collapse once finished", () => {
  assert.deepEqual(fileBarActions({ ...pending, finished: true, skimExpanded: true }), [
    "collapse",
    "approved",
    "reset",
  ]);
});

test("a path splits into its folder (with the trailing slash) and its filename", () => {
  assert.deepEqual(splitPath("src/storage/uploads.ts"), {
    dir: "src/storage/",
    name: "uploads.ts",
  });
});

test("a root-level path has no folder", () => {
  assert.deepEqual(splitPath("README.md"), { dir: "", name: "README.md" });
});
