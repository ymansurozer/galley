import { after, beforeEach } from "node:test";
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
// The deadline starts with the first observed test. A stuck import or suite setup before then
// depends on the CI job timeout.
if (process.env.NODE_TEST_CONTEXT) {
  const configured = Number(process.env.TEST_DEADLINE_MS);
  const deadline = Number.isFinite(configured) && configured > 0 ? configured : 60_000;
  const file = path.relative(process.cwd(), process.argv[1] ?? "");
  // execArgv: [] keeps this preload (and tsx) out of the worker.
  const watchdog = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { writeSync } = require("node:fs");
    const { deadline, file } = workerData;
    const running = new Map();
    let rootSettled = false;
    let settledAt;
    parentPort.on("message", ({ kind, id, name }) => {
      if (kind === "start") {
        running.set(id, { name, at: performance.now() });
        settledAt = undefined;
      } else {
        if (kind === "end") running.delete(id);
        else rootSettled = true;
        if (rootSettled && running.size === 0) settledAt = performance.now();
      }
    });
    const stop = (why) => {
      writeSync(2, "\\n✖ " + why + ", so its test file is stopped.\\n");
      process.kill(process.pid, "SIGKILL");
    };
    setInterval(() => {
      const now = performance.now();
      for (const { name, at } of running.values())
        if (now - at >= deadline) stop(name + " (" + file + ") is still running after " + deadline + " ms");
      if (settledAt !== undefined && now - settledAt >= deadline)
        stop(file + " is still open " + deadline + " ms after its tests finished: something it started holds it open");
    }, 250);
    `,
    { eval: true, execArgv: [], workerData: { deadline, file } },
  );
  watchdog.unref();

  let next = 0;
  beforeEach((t) => {
    const id = next++;
    watchdog.postMessage({ kind: "start", id, name: t.fullName ?? t.name });
    // Node aborts the context when the test finishes, after its teardown hooks.
    t.signal.addEventListener("abort", () => watchdog.postMessage({ kind: "end", id }), {
      once: true,
    });
  });
  // The first root after hook, registered before the file's own: the file's teardown runs inside
  // the settled deadline.
  after(() => {
    watchdog.postMessage({ kind: "settled" });
  });
}
