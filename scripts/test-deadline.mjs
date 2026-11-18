import { after, afterEach, beforeEach } from "node:test";
import { Worker } from "node:worker_threads";
import path from "node:path";

// Preloaded into every test file's process by `pnpm test`, so a stuck test file fails instead of
// stalling the run. Two deadlines, each TEST_DEADLINE_MS (default 60 s): a test still running
// after it fails its file, naming the test, and so does a file still open that long after its
// tests finished (a timer, socket or child process left behind holds it open).
//
// --test-timeout can't do this. On Node 22, the CI runtime, a test file's process ignores it and
// the runner applies it to the whole file. Where it does time out a test, a timer or socket the
// test left behind still holds the file's process open, and the runner reports none of the
// file's results until that process ends.
//
// The clock runs in a worker thread, so it keeps time even while a test blocks the main thread
// synchronously. When a test passes the deadline, the worker writes its name to stderr, which the
// runner reports for the file, and kills the process, which fails the file. Nothing else here
// ends the process: a file that exits within the deadlines passes or fails on Node's own terms,
// late teardown and late errors included. --test-force-exit was rejected: it exits before the
// reporter flushes, and it dropped test results without failing the run.
//
// Not covered: a hang outside any test (a module's top-level await, a before or after hook). The
// CI job's own timeout is the bound there.
if (process.env.NODE_TEST_CONTEXT) {
  const deadline = Number(process.env.TEST_DEADLINE_MS) || 60_000;
  const file = path.relative(process.cwd(), process.argv[1] ?? "");
  // execArgv: [] keeps this preload (and tsx) out of the worker.
  const watchdog = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { writeSync } = require("node:fs");
    const { deadline, file } = workerData;
    const running = new Map();
    let settledAt;
    parentPort.on("message", ({ kind, id, name }) => {
      if (kind === "start") running.set(id, { name, at: Date.now() });
      else if (kind === "end") running.delete(id);
      else settledAt = Date.now();
    });
    const stop = (why) => {
      writeSync(2, "\\n✖ " + why + ", so its test file is stopped.\\n");
      process.kill(process.pid, "SIGKILL");
    };
    setInterval(() => {
      const now = Date.now();
      for (const { name, at } of running.values())
        if (now - at >= deadline) stop(name + " (" + file + ") is still running after " + deadline + " ms");
      if (settledAt !== undefined && now - settledAt >= deadline)
        stop(file + " is still open " + deadline + " ms after its tests finished: something it started holds it open");
    }, 250);
    `,
    { eval: true, execArgv: [], workerData: { deadline, file } },
  );
  watchdog.unref();

  // Hooks get the test's own context, so a context is the test's id across its two hooks.
  const ids = new WeakMap();
  let next = 0;
  beforeEach((t) => {
    const id = next++;
    ids.set(t, id);
    watchdog.postMessage({ kind: "start", id, name: t.fullName });
  });
  afterEach((t) => {
    watchdog.postMessage({ kind: "end", id: ids.get(t) });
  });
  // The first root after hook, registered before the file's own: the file's teardown runs inside
  // the settled deadline.
  after(() => {
    watchdog.postMessage({ kind: "settled" });
  });
}
