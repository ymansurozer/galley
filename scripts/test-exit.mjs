import { after } from "node:test";

// Preloaded into every test file's process (`pnpm test`). A test that hits --test-timeout fails,
// but whatever it was awaiting stays behind: a timer or socket it holds keeps the file's process
// open, and the runner reports none of the file's results until that process ends. So once the
// file's tests are done, exit after a grace period long enough for the reporter to flush. The
// timer is unref'd, so a file that holds nothing exits on its own first. --test-force-exit was
// tried and rejected: it exits before the reporter flushes, silently dropping test results.
// NODE_TEST_CONTEXT is set only in the per-file child processes, not the runner that spawns them.
if (process.env.NODE_TEST_CONTEXT) {
  after(() => {
    setTimeout(() => process.exit(), 1000).unref();
  });
}
