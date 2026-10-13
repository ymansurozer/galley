import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deskAlive } from "./cli.js";
import { deskLockPath, loadLatestReview, persistReview, reviewDir } from "./state.js";
import type { ReviewState } from "./types.js";

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

// ── `--ui` / `galley ui`: spawned through tsx like the published bin, against throwaway repos ──

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

// Hermetic: HOME isolates ~/.galley, no update check, and no inherited GALLEY_HOST (the desk must
// print its loopback URL).
function cliEnv(home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GALLEY_NO_UPDATE_CHECK: "1" };
  delete env.GALLEY_HOST;
  delete env.GALLEY_ALLOWED_HOSTS;
  return env;
}

// A throwaway repo, plus a separate HOME so the desk's ~/.galley never lands in the tree.
async function tempRepo(dirty: boolean) {
  const home = await mkdtemp(path.join(tmpdir(), "galley-cli-home-"));
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "galley-cli-ui-")));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-q");
  run("config", "user.email", "t@t.co");
  run("config", "user.name", "t");
  await writeFile(path.join(dir, "a.txt"), "one\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  if (dirty) await writeFile(path.join(dir, "a.txt"), "two\n");
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  };
  return { repo: dir, home, cleanup };
}

const runCli = (args: string[], home: string) =>
  spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    env: cliEnv(home),
    timeout: 30_000,
  });

// Launch a persistent desk and resolve with its loopback URL once it prints it.
function startDesk(args: string[], home: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args, "--no-open"], {
    env: cliEnv(home),
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(
      () => reject(new Error(`desk never printed its URL:\n${err}`)),
      30_000,
    );
    child.stderr!.on("data", (d) => {
      err += d;
      const m = err.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[0] });
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`desk exited before printing its URL:\n${err}`));
    });
  });
}

type DeskState = {
  files: unknown[];
  ui?: { target: string };
  uiProxy: { port: number } | null;
};
const deskState = (url: string) =>
  fetch(`${url}api/state`).then((r) => r.json() as Promise<DeskState>);
const deskPoll = (url: string) =>
  fetch(`${url}api/poll`).then((r) => r.json() as Promise<DeskState>);

test("a non-loopback or https UI target exits non-zero with a clear message, starting nothing", async () => {
  const { repo, home, cleanup } = await tempRepo(true);
  try {
    const sub = runCli(["ui", "http://example.com:3000", "--repo", repo], home);
    assert.equal(sub.status, 1);
    assert.match(sub.stderr, /"example\.com" is not a loopback host/);
    const flag = runCli(["--ui", "http://10.1.2.3:3000", "--repo", repo, "--no-open"], home);
    assert.equal(flag.status, 1);
    assert.match(flag.stderr, /--ui: "10\.1\.2\.3" is not a loopback host/);
    const https = runCli(["ui", "https://localhost:3000", "--repo", repo], home);
    assert.equal(https.status, 1);
    assert.match(https.stderr, /must be an http:\/\/ URL/);
  } finally {
    await cleanup();
  }
});

test("a clean tree without a UI target still refuses to start", async () => {
  const { repo, home, cleanup } = await tempRepo(false);
  try {
    const res = runCli(["--repo", repo, "--no-open"], home);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No git diff found to review\./);
  } finally {
    await cleanup();
  }
});

test("galley ui with no live desk starts a UI-only desk on a clean tree; a second galley ui switches it live", async () => {
  const { repo, home, cleanup } = await tempRepo(false);
  let child: ChildProcess | undefined;
  try {
    const desk = await startDesk(
      ["ui", "http://localhost:3000/sign-in?as=x", "--repo", repo, "--port", "0"],
      home,
    );
    child = desk.child;
    const state = await deskState(desk.url);
    assert.deepEqual(state.files, [], "UI-only: no code to review");
    assert.deepEqual(state.ui, { target: "http://localhost:3000/sign-in?as=x" });
    assert.ok(state.uiProxy && state.uiProxy.port > 0, "the proxy is up");

    const live = runCli(["ui", "http://127.0.0.1:4000/app", "--repo", repo], home);
    assert.equal(live.status, 0, live.stderr);
    const out = JSON.parse(live.stdout) as { ok: boolean; live: boolean; target: string };
    assert.deepEqual([out.ok, out.live, out.target], [true, true, "http://127.0.0.1:4000/app"]);
    // The open tab reads the new target off its next poll — same desk, same proxy, no restart.
    const poll = await deskPoll(desk.url);
    assert.deepEqual(poll.ui, { target: "http://127.0.0.1:4000/app" });
    assert.equal(poll.uiProxy?.port, state.uiProxy.port);
  } finally {
    child?.kill();
    await cleanup();
  }
});

test("galley --ui on a dirty tree starts a combined desk with code and the UI target", async () => {
  const { repo, home, cleanup } = await tempRepo(true);
  let child: ChildProcess | undefined;
  try {
    const desk = await startDesk(["--ui", "localhost:5173", "--repo", repo, "--port", "0"], home);
    child = desk.child;
    const state = await deskState(desk.url);
    assert.equal(state.files.length, 1, "the diff is there");
    assert.deepEqual(state.ui, { target: "http://localhost:5173/" });
  } finally {
    child?.kill();
    await cleanup();
  }
});

test("a bare galley restarts a stopped UI-only desk on its persisted target", async () => {
  const { repo, home, cleanup } = await tempRepo(false);
  const children: ChildProcess[] = [];
  try {
    const first = await startDesk(
      ["ui", "http://localhost:3000/app", "--repo", repo, "--port", "0"],
      home,
    );
    children.push(first.child);
    const stop = runCli(["stop", "--repo", repo, "--all"], home);
    assert.equal(stop.status, 0, stop.stderr);
    await new Promise((resolve) => first.child.once("exit", resolve));
    // Still a clean tree, and no --ui: the saved target is what makes it a review.
    const again = await startDesk(["--repo", repo, "--port", "0"], home);
    children.push(again.child);
    const state = await deskState(again.url);
    assert.deepEqual(state.files, [], "back UI-only");
    assert.deepEqual(state.ui, { target: "http://localhost:3000/app" });
    assert.ok(state.uiProxy, "the proxy is back up");
  } finally {
    for (const c of children) c.kill();
    await cleanup();
  }
});

// ── `galley comment --ui`: live over HTTP, else appended to the saved review ──────────────────

// Async: the fake desk below answers in this process, which spawnSync would block.
function runCliAsync(args: string[], home: string) {
  const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { env: cliEnv(home) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    child.once("close", (status) => resolve({ status, stdout, stderr })),
  );
}

// A saved review holding UI question q1, as a desk persisted it.
async function savedQuestion(repo: string, home: string) {
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const at = "2026-10-13T10:00:00.000Z";
    const review: ReviewState = {
      id: "id",
      session: "s",
      root: repo,
      repoHash: "h",
      mode: "repo",
      staged: false,
      head: null,
      baseDiffHash: "base",
      createdAt: at,
      rawDiff: "",
      files: [],
      comments: [],
      changes: [],
      reviewedFiles: [],
      stagedFiles: [],
      ui: { target: "http://localhost:3000/" },
      annotations: [
        {
          id: "q1",
          number: 1,
          intent: "question",
          status: "open",
          placement: "placed",
          page: {
            url: "http://localhost:3000/app",
            route: "/app",
            viewport: { width: 1280, height: 800, dpr: 1 },
          },
          target: {
            kind: "element",
            elements: [
              { selector: "#save", tag: "button", rect: { x: 0, y: 0, width: 1, height: 1 } },
            ],
          },
          comments: [
            {
              id: "m1",
              role: "user",
              intent: "question",
              body: "Why?",
              createdAt: at,
              updatedAt: at,
            },
          ],
        },
      ],
    };
    await persistReview(review);
    const lock = deskLockPath(await reviewDir(repo, "s"));
    const thread = async () =>
      (await loadLatestReview(repo, "s"))!.annotations![0]!.comments.map((m) => m.role);
    return { lock, thread };
  } finally {
    process.env.HOME = oldHome;
  }
}

test("comment --ui fails, writing nothing, when the live desk takes the request but doesn't answer it", async () => {
  const { repo, home, cleanup } = await tempRepo(false);
  // A desk that is up (its state answers) but whose reply route drops the connection.
  const desk = http.createServer((req, res) => {
    if (req.url === "/api/state") res.end("{}");
    else req.socket.destroy();
  });
  await new Promise<void>((resolve) => desk.listen(0, "127.0.0.1", resolve));
  try {
    const { lock, thread } = await savedQuestion(repo, home);
    const address = desk.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}/`, session: "s" }),
    );
    const args = ["comment", "--repo", repo, "--session", "s", "--ui", "q1", "--body", "Because."];
    const failed = await runCliAsync(args, home);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /desk .* didn't take the reply/);
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      assert.deepEqual(await thread(), ["user"], "nothing written behind the live desk");
      // The desk is gone: the reply goes into the saved review instead.
      await new Promise((resolve) => desk.close(resolve));
      const offline = await runCliAsync(args, home);
      assert.equal(offline.status, 0, offline.stderr);
      assert.equal((JSON.parse(offline.stdout) as { live: boolean }).live, false);
      assert.deepEqual(await thread(), ["user", "agent"]);
    } finally {
      process.env.HOME = oldHome;
    }
  } finally {
    desk.close();
    await cleanup();
  }
});
