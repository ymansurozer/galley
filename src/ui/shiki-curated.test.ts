import { test } from "node:test";
import assert from "node:assert/strict";
import { codeScheme } from "./shiki-curated.js";

test("a curated code theme's scheme is its own type", () => {
  assert.equal(codeScheme("github-light"), "light");
  assert.equal(codeScheme("catppuccin-latte"), "light");
  assert.equal(codeScheme("dracula"), "dark");
  assert.equal(codeScheme("material-theme-palenight"), "dark");
});

test("of @pierre's diff-only themes only pierre-light is light, and an unknown name reads dark", () => {
  assert.equal(codeScheme("pierre-light"), "light");
  assert.equal(codeScheme("pierre-dark"), "dark");
  assert.equal(codeScheme("pierre-dark-soft"), "dark");
  assert.equal(codeScheme("no-such-theme"), "dark");
});
