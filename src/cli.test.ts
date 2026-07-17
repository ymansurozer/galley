import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deskAlive } from "./cli.js";

// A desk lock can outlive its process (crash, SIGKILL) — deskAlive is the only thing standing
// between "trust the lock" and "trust it only if the server answers" (see state.ts's stablePort
// invariant notes). Cover both sides: a dead URL and a URL that actually answers.

test("deskAlive resolves false for a URL nothing is listening on, within the abort budget", async () => {
  // Port 1 is a privileged, essentially-never-bound port — connection refused (or a hang the
  // ~1500ms internal abort catches) either way lands on false. We only assert the outcome and a
  // generous wall-clock ceiling, not the exact abort timing.
  const start = Date.now();
  const alive = await deskAlive("http://127.0.0.1:1/");
  assert.equal(alive, false);
  assert.ok(Date.now() - start < 5000, "resolves well within the ~1500ms abort budget plus slack");
});

test("deskAlive resolves true for a live server that answers", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const alive = await deskAlive(`http://127.0.0.1:${port}/`);
    assert.equal(alive, true);
  } finally {
    server.close();
  }
});

// Regression: npm installs the published bin as a SYMLINK (.bin/galley -> dist/cli.js). Node
// resolves import.meta.url through the symlink to cli.ts's real path, but leaves
// process.argv[1] as the symlink path — an entry-point guard that compares the two directly
// (no realpath) never fires under a symlinked invocation, and the CLI silently no-ops (exits 0,
// no output). Reproduce that exact shape here: symlink to the real src/cli.ts and run it through
// `node --import tsx` the same way the built bin runs through node directly.
test("running cli.ts through a symlink (npm bin shape) still runs main()", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "galley-cli-symlink-"));
  const link = path.join(dir, "galley");
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  try {
    await symlink(cliPath, link);
    const result = spawnSync(process.execPath, ["--import", "tsx", link, "--help"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /galley — an integrated review environment/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
