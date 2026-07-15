import { test } from "node:test";
import assert from "node:assert/strict";
import { isFullySkimmed } from "./skim-derive.js";

test("a file-level skim flag makes the file fully skimmed regardless of blocks", () => {
  assert.equal(isFullySkimmed(true, []), true);
  assert.equal(isFullySkimmed(true, [false, false]), true);
});

test("a file is fully skimmed when it has blocks and every one is skim-stamped", () => {
  assert.equal(isFullySkimmed(false, [true]), true);
  assert.equal(isFullySkimmed(false, [true, true, true]), true);
});

test("a partially-skimmed file (any unskimmed block) stays a normal file", () => {
  assert.equal(isFullySkimmed(false, [true, false]), false);
  assert.equal(isFullySkimmed(false, [false, true, true]), false);
});

test("a file with no change blocks and no file-level flag is not fully skimmed", () => {
  // A hunk-less new file with no skim flag stays in the flow — only the file-level flag pulls
  // it out (it carries no blocks to stamp).
  assert.equal(isFullySkimmed(false, []), false);
});

test("dropping the last skim stamp on reload returns the file to the flow", () => {
  // A block the agent rewrote loses its carried skim (new id, no prev) → the file, once fully
  // skimmed ([true, true]), rejoins the main flow ([true, false]) automatically.
  assert.equal(isFullySkimmed(false, [true, true]), true);
  assert.equal(isFullySkimmed(false, [true, false]), false);
});
