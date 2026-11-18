import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// scripts/test-deadline.mjs, the preload `pnpm test` runs every test file under, run the same way
// against throwaway test files with a 1 s deadline.
const PRELOAD = fileURLToPath(new URL("../scripts/test-deadline.mjs", import.meta.url));
const DEADLINE_MS = 1000;

async function runTestFile(source: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "galley-deadline-"));
  try {
    await writeFile(path.join(dir, "probe.test.mjs"), source);
    // This file runs as a test file itself; the spawned runner must not think it's one too.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const child = spawn(
      process.execPath,
      ["--import", PRELOAD, "--test", "--test-reporter=spec", "probe.test.mjs"],
      { cwd: dir, env: { ...env, TEST_DEADLINE_MS: String(DEADLINE_MS) } },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const started = Date.now();
    // A hang the preload misses would hang this test too; kill it well past the deadline.
    const backstop = setTimeout(() => child.kill("SIGKILL"), 15 * DEADLINE_MS);
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    clearTimeout(backstop);
    return { status, output, ms: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const header = `import { after, afterEach, test } from "node:test";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
`;

test("a test that never settles fails its file by name, though a timer it left holds the file open", async () => {
  const r = await runTestFile(
    header +
      `test("waits forever", () => { setInterval(() => {}, 1000); return new Promise(() => {}); });`,
  );
  assert.equal(r.status, 1);
  assert.match(r.output, /waits forever \(probe\.test\.mjs\) is still running after 1000 ms/);
  assert.ok(r.ms < 8 * DEADLINE_MS, `stopped in ${r.ms} ms`);
});

test("a test that blocks its thread synchronously fails its file by name", async () => {
  const r = await runTestFile(header + `test("spins", () => { for (;;) {} });`);
  assert.equal(r.status, 1);
  assert.match(r.output, /spins \(probe\.test\.mjs\) is still running after 1000 ms/);
  assert.ok(r.ms < 8 * DEADLINE_MS, `stopped in ${r.ms} ms`);
});

test("the deadline is per test: tests each under it pass, together over it", async () => {
  const r = await runTestFile(
    header +
      `test("first", () => wait(${DEADLINE_MS * 0.6}));
test("second", () => wait(${DEADLINE_MS * 0.6}));`,
  );
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /pass 2/);
});

test("a file left open after its tests finish fails, keeping its own failure", async () => {
  const r = await runTestFile(
    header +
      `test("fails and leaks a timer", () => { setInterval(() => {}, 1000); throw new Error("the real failure"); });`,
  );
  assert.equal(r.status, 1);
  assert.match(r.output, /the real failure/);
  assert.match(r.output, /probe\.test\.mjs is still open 1000 ms after its tests finished/);
});

test("teardown that fails inside the deadline still fails the run, on Node's own report", async () => {
  const r = await runTestFile(
    header +
      `after(async () => { await wait(${DEADLINE_MS / 2}); throw new Error("teardown broke"); });
test("passes", () => {});`,
  );
  assert.equal(r.status, 1);
  assert.match(r.output, /teardown broke/);
  assert.doesNotMatch(r.output, /so its test file is stopped/);
});

test("a late-registered test gets a fresh deadline", async () => {
  const r = await runTestFile(
    header +
      `test("early", () => {});
await wait(${DEADLINE_MS * 0.65});
test("late", () => wait(${DEADLINE_MS * 0.65}));`,
  );
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /pass 2/);
});

test("a hanging afterEach stays inside the test deadline", async () => {
  const r = await runTestFile(
    header +
      `afterEach(() => { setInterval(() => {}, 1000); return new Promise(() => {}); });
test("hanging cleanup", () => {});`,
  );
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /hanging cleanup \(probe\.test\.mjs\) is still running after 1000 ms/);
  assert.ok(r.ms < 8 * DEADLINE_MS, `stopped in ${r.ms} ms`);
});

test("a native timeout still bounds hanging cleanup", async () => {
  const r = await runTestFile(
    header +
      `afterEach(() => { setInterval(() => {}, 1000); return new Promise(() => {}); });
test("timed out before cleanup", { timeout: 100 }, () => new Promise(() => {}));`,
  );
  assert.equal(r.status, 1, r.output);
  assert.match(
    r.output,
    /timed out before cleanup \(probe\.test\.mjs\) is still running after 1000 ms/,
  );
  assert.ok(r.ms < 8 * DEADLINE_MS, `stopped in ${r.ms} ms`);
});

test("a timed-out file's subprocess cannot hold the runner output open", async () => {
  const r = await runTestFile(
    header +
      `import { spawn } from "node:child_process";
test("leaves inherited stdio open", () => {
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 9000)"], { stdio: "inherit" });
  return new Promise(() => {});
});`,
  );
  assert.equal(r.status, 1, r.output);
  assert.match(
    r.output,
    /leaves inherited stdio open \(probe\.test\.mjs\) is still running after 1000 ms/,
  );
  assert.ok(r.ms < 8 * DEADLINE_MS, `stopped in ${r.ms} ms`);
});

test("a parent deadline names the active subtest", async () => {
  const r = await runTestFile(
    header +
      `test("parent", (t) => t.test("child hangs", () => {
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}));`,
  );
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /also running:.*child hangs/);
});
