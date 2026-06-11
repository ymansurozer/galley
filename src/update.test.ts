import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  currentVersion,
  detectInstall,
  isNewer,
  readCheckCache,
  writeCheckCache,
} from "./update.js";

test("isNewer compares plain x.y.z numerically", () => {
  assert.equal(isNewer("0.3.0", "0.2.1"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.2.10", "0.2.9"), true); // numeric, not lexicographic
  assert.equal(isNewer("0.2.1", "0.2.1"), false);
  assert.equal(isNewer("0.2.0", "0.2.1"), false);
  assert.equal(isNewer("0.2.1", "0.3.0"), false);
});

test("isNewer refuses anything that isn't plain semver", () => {
  assert.equal(isNewer("0.3.0-beta.1", "0.2.1"), false);
  assert.equal(isNewer("latest", "0.2.1"), false);
  assert.equal(isNewer("0.3", "0.2.1"), false);
  assert.equal(isNewer("", ""), false);
});

test("currentVersion reads the package version", () => {
  assert.match(currentVersion(), /^\d+\.\d+\.\d+/);
});

test("detectInstall: project-local installs are notice-only", () => {
  const cwd = "/work/repo";
  const local = detectInstall("/work/repo/node_modules/@ymansurozer/galley/dist/cli.js", cwd);
  assert.equal(local.kind, "local");
  assert.deepEqual(local.command, ["npm", "i", "-D", "@ymansurozer/galley@latest"]);
});

test("detectInstall: global installs pick the manager from the path", () => {
  const cwd = "/work/repo";
  assert.deepEqual(
    detectInstall("/usr/local/lib/node_modules/@ymansurozer/galley/dist/cli.js", cwd),
    { kind: "global", command: ["npm", "i", "-g", "@ymansurozer/galley@latest"] },
  );
  assert.deepEqual(
    detectInstall(
      "/Users/u/Library/pnpm/global/5/.pnpm/@ymansurozer+galley@0.2.1/node_modules/@ymansurozer/galley/dist/cli.js",
      cwd,
    ),
    { kind: "global", command: ["pnpm", "add", "-g", "@ymansurozer/galley@latest"] },
  );
  assert.deepEqual(
    detectInstall("/Users/u/.bun/install/global/node_modules/@ymansurozer/galley/dist/cli.js", cwd),
    {
      kind: "global",
      command: ["bun", "add", "-g", "@ymansurozer/galley@latest"],
    },
  );
});

test("update-check cache: round-trip; missing/corrupt read as {}", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "galley-update-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.deepEqual(await readCheckCache(), {});
    await writeCheckCache({ lastCheckedAt: "2026-06-11T00:00:00.000Z", latest: "9.9.9" });
    assert.deepEqual(await readCheckCache(), {
      lastCheckedAt: "2026-06-11T00:00:00.000Z",
      latest: "9.9.9",
    });
    await fs.writeFile(path.join(home, ".galley", "update-check.json"), "{nope", "utf8");
    assert.deepEqual(await readCheckCache(), {});
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    await fs.rm(home, { recursive: true, force: true });
  }
});
