// Perf regression gate: generates a throwaway ~1,000-file git repo (every file edited in
// the working tree, plus one oversized generated file), starts a real desk against dist/,
// and asserts the PRD's budgets with CI-safe margins. The point is catching order-of-magnitude
// regressions — the 170 MB payload / ~2,550 sequential-spawn kind — not millisecond drift.
// Run: pnpm build && pnpm perf-smoke
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const PORT = 6798,
  ID = "perf-smoke";
const CLI = path.join(process.cwd(), "dist", "cli.js");
const UI_BUNDLE = path.join(process.cwd(), "dist", "ui.js");
const BASE = `http://127.0.0.1:${PORT}`;
const FILE_COUNT = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (...args) => execFileSync("node", [CLI, ...args], { encoding: "utf8" }).trim();
const getText = async (p) => (await fetch(BASE + p)).text();

// Budgets: generous CI margins over local reality (noted per-assert below).
const BUDGET_STARTUP_MS = 15_000; // local ~2s
const BUDGET_STATE_BYTES = 10 * 1024 * 1024;
const BUDGET_PERSISTED_BYTES = 10 * 1024 * 1024;
const BUDGET_BUNDLE_BYTES = 3.2 * 1024 * 1024;
const BUDGET_RELOAD_MS = 10_000; // local ~280ms

let desk, tmp, homeDir;
const oldHome = process.env.HOME;
const cleanup = () => {
  try {
    desk?.kill();
  } catch {
    /**/
  }
  try {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  } catch {
    /**/
  }
  try {
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  } catch {
    /**/
  }
  process.env.HOME = oldHome;
};
process.on("exit", cleanup);

function budget(name, actual, limit, unit, note) {
  const ok = actual < limit;
  console.log(`  ${ok ? "✓" : "✗"} ${name}: ${actual}${unit} (budget < ${limit}${unit}) ${note}`);
  if (!ok)
    throw new Error(`perf budget violated: ${name} = ${actual}${unit} (budget < ${limit}${unit})`);
}

try {
  // Point HOME at a throwaway dir so the persisted review file lands somewhere we control and
  // clean up, hermetic like src/server.test.ts.
  homeDir = mkdtempSync(path.join(tmpdir(), "galley-perf-home-"));
  process.env.HOME = homeDir;

  // Throwaway ~1,000-file repo: committed base, then every file edited in the working tree,
  // plus one oversized generated file (>5000 changed lines) — mirrors scripts/smoke.mjs and
  // the buildDiffSource oversized-stamp fixture in src/state.test.ts.
  tmp = mkdtempSync(path.join(tmpdir(), "galley-perf-repo-"));
  const git = (...a) => execFileSync("git", a, { cwd: tmp, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "s@s.dev");
  git("config", "user.name", "perf-smoke");

  const dirA = path.join(tmp, "src");
  mkdirSync(dirA, { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(
      path.join(dirA, `file-${i}.txt`),
      `line one ${i}\nline two ${i}\nline three ${i}\n`,
    );
  }
  const bigLines = (tag) =>
    Array.from({ length: 6000 }, (_, i) => `${tag} line ${i}`).join("\n") + "\n";
  writeFileSync(path.join(tmp, "generated-bundle.txt"), bigLines("orig"));
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(
      path.join(dirA, `file-${i}.txt`),
      `line one ${i} CHANGED\nline two ${i}\nline three ${i}\n`,
    );
  }
  writeFileSync(path.join(tmp, "generated-bundle.txt"), bigLines("edited"));

  const startedAt = Date.now();
  desk = spawn("node", [CLI, "--repo", tmp, "--session", ID, "--port", String(PORT), "--no-open"], {
    stdio: "ignore",
    env: { ...process.env, GALLEY_NO_UPDATE_CHECK: "1" },
  });
  let up = false;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(BASE + "/api/poll");
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      /**/
    }
    await sleep(100);
  }
  const startupMs = Date.now() - startedAt;
  assert.ok(up, "desk answered /api/poll before the poll loop gave up");
  budget(
    "startup",
    startupMs,
    BUDGET_STARTUP_MS,
    "ms",
    "(desk start → first successful /api/poll)",
  );

  const stateText = await getText("/api/state");
  const state = JSON.parse(stateText);
  assert.equal(state.mode, "repo");
  assert.ok(state.changes.length >= FILE_COUNT, `desk has ${FILE_COUNT}+ changes to review`);
  const stateBytes = Buffer.byteLength(stateText, "utf8");
  budget("/api/state size", stateBytes, BUDGET_STATE_BYTES, " bytes", "");
  assert.ok(
    state.files.every((f) => !("oldFile" in f) && !("newFile" in f)),
    "no file contents ride /api/state",
  );
  assert.ok(!stateText.includes('"contents"'), "state has no contents field");
  console.log("  ✓ /api/state has no oldFile/newFile/contents fields");
  const oversized = state.files.find((f) => f.path === "generated-bundle.txt");
  assert.equal(oversized?.oversized, true, "the oversized generated file is stamped");
  assert.ok(
    state.files.every((f) => typeof f.changeKind === "string"),
    "every file carries a changeKind stamp",
  );
  console.log("  ✓ oversized + changeKind stamps present");

  // The persisted review file under $HOME/.galley — same content-free bar as /api/state.
  const repoHashDir = readdirSync(path.join(homeDir, ".galley"))[0];
  const sessionDir = path.join(homeDir, ".galley", repoHashDir, ID);
  const persistedName = readdirSync(sessionDir).find((n) => n.endsWith(".json"));
  assert.ok(persistedName, "a persisted review file exists under ~/.galley");
  const persistedPath = path.join(sessionDir, persistedName);
  const persistedBytes = statSync(persistedPath).size;
  budget("persisted review file size", persistedBytes, BUDGET_PERSISTED_BYTES, " bytes", "");
  const persistedText = readFileSync(persistedPath, "utf8");
  assert.ok(!persistedText.includes('"oldFile"'), "persisted file has no oldFile field");
  assert.ok(!persistedText.includes('"newFile"'), "persisted file has no newFile field");
  assert.ok(!persistedText.includes('"contents"'), "persisted file has no contents field");
  console.log("  ✓ persisted review file is content-free");

  const bundleBytes = statSync(UI_BUNDLE).size;
  budget(
    "dist/ui.js size",
    bundleBytes,
    BUDGET_BUNDLE_BYTES,
    " bytes",
    "(belt-and-suspenders with the build gate)",
  );

  // `galley reload` after a working-tree touch.
  writeFileSync(
    path.join(dirA, "file-0.txt"),
    `line one 0 CHANGED AGAIN\nline two 0\nline three 0\n`,
  );
  const reloadStart = Date.now();
  const reloaded = JSON.parse(cli("reload", "--repo", tmp, "--session", ID));
  const reloadMs = Date.now() - reloadStart;
  assert.ok(reloaded.ok, "reload accepted");
  budget("reload", reloadMs, BUDGET_RELOAD_MS, "ms", "");

  const stop = JSON.parse(cli("stop", "--repo", tmp, "--session", ID));
  assert.ok(stop.ok, "stop acked");

  console.log("\nPERF SMOKE PASS");
  console.log(
    JSON.stringify({ startupMs, stateBytes, persistedBytes, bundleBytes, reloadMs }, null, 2),
  );
} catch (error) {
  console.error("\nPERF SMOKE FAIL:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  cleanup();
}
