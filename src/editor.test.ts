import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLine, resolveEditorCommand } from "./editor.js";

const values = { repo: "/repo", file: "/repo/src/a.ts", line: 12 };

test("resolveEditorCommand expands an allowlisted editor command", () => {
  const cmd = resolveEditorCommand("code -g {file}:{line}", values);
  assert.equal(cmd.command, "code");
  assert.deepEqual(cmd.args, ["-g", "/repo/src/a.ts:12"]);
});

test("resolveEditorCommand rejects non-allowlisted editors", () => {
  assert.throws(() => resolveEditorCommand("node {file}", values), /not allowed/);
});

test("resolveEditorCommand rejects shell metacharacters", () => {
  assert.throws(() => resolveEditorCommand("code {file}; rm -rf /", values), /shell syntax/);
});

test("resolveEditorCommand supports quoted arguments without invoking a shell", () => {
  const cmd = resolveEditorCommand('code --reuse-window "{file}:{line}"', values);
  assert.deepEqual(cmd.args, ["--reuse-window", "/repo/src/a.ts:12"]);
});

test("normalizeLine falls back to one for invalid input", () => {
  assert.equal(normalizeLine(undefined), 1);
  assert.equal(normalizeLine(0), 1);
  assert.equal(normalizeLine("abc"), 1);
  assert.equal(normalizeLine(7), 7);
});
