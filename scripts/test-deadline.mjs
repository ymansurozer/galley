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
    const { spawnSync } = require("node:child_process");
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
    // A descendant can keep the runner's inherited stdout pipe open after this file dies.
    // Stop our process tree only; the test runner and sibling files are outside it.
    const stopDescendants = () => {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(process.pid), "/T", "/F"], {
          timeout: 1000, stdio: "ignore", windowsHide: true,
        });
        return;
      }
      const { stdout } = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
        encoding: "utf8", timeout: 1000,
      });
      const children = new Map();
      for (const line of (stdout ?? "").trim().split("\\n")) {
        const [pid, parent] = line.trim().split(/\\s+/).map(Number);
        if (!pid || !parent) continue;
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(pid);
      }
      const tree = [process.pid];
      for (const pid of tree) tree.push(...(children.get(pid) ?? []));
      for (const pid of tree.slice(1).reverse()) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    };
    const stop = (why) => {
      writeSync(2, "\\n✖ " + why + ", so its test file is stopped.\\n");
      stopDescendants();
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
    // Node can abort the context early on a native timeout. The test's after hook runs
    // after its enclosing afterEach hooks; require both signals before ending its deadline.
    let reachedAfter = false;
    const finish = () => {
      if (reachedAfter && t.signal.aborted) watchdog.postMessage({ kind: "end", id });
    };
    t.after(() => {
      reachedAfter = true;
      finish();
    });
    t.signal.addEventListener("abort", finish, { once: true });
  });
  // The first root after hook, registered before the file's own: the file's teardown runs inside
  // the settled deadline.
  after(() => {
    watchdog.postMessage({ kind: "settled" });
  });
}
