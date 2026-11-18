// A disposable desk for testing Galley by hand or from an agent. A desk writes settings, locks and
// saved reviews under $HOME/.galley, so a test desk run against the real HOME rewrites the user's
// own settings and reviews. This one gets a throwaway HOME and a fixture repo with one change of
// every kind, binds loopback on a port in 5100-5299, prints one JSON line once /api/state serves
// the fixture, and removes it all on Ctrl-C, SIGTERM, SIGHUP or `galley stop`.
// Run: pnpm build && pnpm desk:sandbox
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SESSION = "sandbox";
const CLI = path.join(process.cwd(), "dist", "cli.js");
const PORT_LO = 5100;
const PORT_HI = 5299;
// The desk walks GALLEY_PORT_RANGE on a taken port and only leaves it once the whole range is
// taken; a fresh start covers a port lost to another process between the walk and the bind.
const ATTEMPTS = 3;
const READY_MS = 30_000;
// One file per change kind the desk distinguishes, so the tree, the diff and a rename all render.
const FIXTURE_PATHS = [
  "README.md",
  "src/greet.ts",
  "src/format.ts",
  "docs/guide.md",
  "notes/obsolete.txt",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  console.error(`desk:sandbox: ${message}`);
  process.exitCode = 1;
  shutdown();
};

if (!existsSync(CLI)) {
  console.error("desk:sandbox: dist/cli.js is missing. Run `pnpm build` first.");
  process.exit(1);
}

const root = mkdtempSync(path.join(tmpdir(), "galley-sandbox-"));
const home = path.join(root, "home");
const repo = path.join(root, "repo");
let desk;
let stopping = false;

// Synchronous so it also runs from the exit handler. The desk only writes under the throwaway
// HOME, so removing the root while it dies loses nothing.
function cleanup() {
  if (desk && desk.exitCode === null && desk.signalCode === null) desk.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (!desk || desk.exitCode !== null || desk.signalCode !== null) {
    cleanup();
    process.exit();
  }
  const force = setTimeout(() => desk.kill("SIGKILL"), 5_000);
  desk.once("exit", () => {
    clearTimeout(force);
    cleanup();
    process.exit();
  });
  desk.kill("SIGTERM");
}

process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, shutdown);

function writeFixture() {
  mkdirSync(home);
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  };
  // The fixture's git must not read the caller's global config either, so it runs with the
  // sandbox HOME too.
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, HOME: home } });

  write("README.md", "# Sandbox\n\nA fixture repo for a Galley test desk.\n");
  write(
    "src/greet.ts",
    'export function greet(name: string): string {\n  return "Hello, " + name;\n}\n',
  );
  write("docs/old-guide.md", "# Guide\n\nRead the README first.\n\nThen run the desk.\n");
  write("notes/obsolete.txt", "This note is about to go.\n");
  git("init", "-q");
  git("config", "user.email", "sandbox@galley.dev");
  git("config", "user.name", "desk-sandbox");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  write(
    "README.md",
    "# Sandbox\n\nA fixture repo for a Galley test desk.\n\nEvery change kind is here.\n",
  );
  write(
    "src/greet.ts",
    'import { title } from "./format";\n\nexport function greet(name: string): string {\n  return `Hello, ${title(name)}!`;\n}\n',
  );
  write(
    "src/format.ts",
    "export function title(name: string): string {\n  return name.charAt(0).toUpperCase() + name.slice(1);\n}\n",
  );
  // A desk reviews the unstaged diff, where a staged `git mv` never shows. Intent-to-add puts the
  // new path in that diff, so -M pairs it with the deleted one as a rename.
  renameSync(path.join(repo, "docs/old-guide.md"), path.join(repo, "docs/guide.md"));
  git("add", "-N", "docs/guide.md");
  rmSync(path.join(repo, "notes/obsolete.txt"));
}

function deskEnv() {
  const env = {
    ...process.env,
    HOME: home,
    GALLEY_HOST: "127.0.0.1",
    GALLEY_PORT_RANGE: `${PORT_LO}-${PORT_HI}`,
    GALLEY_NO_UPDATE_CHECK: "1",
  };
  delete env.GALLEY_ALLOWED_HOSTS;
  return env;
}

// Starts a desk and resolves with the port it printed in `Galley <session>: http://127.0.0.1:<port>/`
// on stderr. The line can arrive split, so chunks accumulate.
function startDesk(port) {
  desk = spawn(
    process.execPath,
    [CLI, "--repo", repo, "--session", SESSION, "--port", String(port), "--no-open"],
    { stdio: ["ignore", "ignore", "pipe"], env: deskEnv() },
  );
  let log = "";
  desk.stderr.on("data", (d) => {
    log += d;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the desk printed no URL within 30s:\n${log}`)),
      READY_MS,
    );
    const onData = () => {
      const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!m) return;
      clearTimeout(timer);
      desk.stderr.off("data", onData);
      resolve(Number(m[1]));
    };
    desk.stderr.on("data", onData);
    desk.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`the desk exited (${signal ?? code}) before printing its URL:\n${log}`));
    });
  });
}

function stopDesk() {
  return new Promise((resolve) => {
    if (desk.exitCode !== null || desk.signalCode !== null) return resolve();
    desk.once("exit", () => resolve());
    desk.kill("SIGTERM");
  });
}

// Ready means /api/state serves the fixture: the payload the tab renders from, not only a socket.
async function waitForFixture(base) {
  const deadline = Date.now() + READY_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/state`);
      if (res.ok) {
        const state = await res.json();
        const paths = new Set(state.files.map((f) => f.path));
        const missing = FIXTURE_PATHS.filter((p) => !paths.has(p));
        if (!missing.length) return;
        last = `/api/state lacks ${missing.join(", ")}`;
      } else last = `/api/state answered ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`the desk never served the fixture within 30s (${last})`);
}

try {
  writeFixture();
  let port;
  for (let attempt = 1; attempt <= ATTEMPTS && port === undefined; attempt++) {
    const start = PORT_LO + Math.floor(Math.random() * (PORT_HI - PORT_LO + 1));
    const bound = await startDesk(start);
    if (bound >= PORT_LO && bound <= PORT_HI) port = bound;
    else {
      console.error(
        `desk:sandbox: the desk bound ${bound}, outside ${PORT_LO}-${PORT_HI}; retrying`,
      );
      await stopDesk();
    }
  }
  if (port === undefined)
    throw new Error(
      `every port in ${PORT_LO}-${PORT_HI} stayed taken; stop a desk you no longer need and retry`,
    );
  const url = `http://127.0.0.1:${port}/`;
  await waitForFixture(url.slice(0, -1));

  // The desk ends the sandbox either way: a clean exit is `galley stop`, anything else a crash
  // whose only clue is the desk's stderr.
  desk.stderr.pipe(process.stderr);
  desk.once("exit", (code, signal) => {
    if (stopping) return;
    if (code === 0) {
      console.error("desk:sandbox: the desk stopped; sandbox removed");
      shutdown();
    } else fail(`the desk exited (${signal ?? code}); sandbox removed`);
  });
  console.log(
    JSON.stringify({
      ready: true,
      url,
      port,
      session: SESSION,
      repo,
      home,
      pid: process.pid,
      cli: `HOME=${home} node ${CLI} <command> --repo ${repo} --session ${SESSION}`,
    }),
  );
  console.error(`desk:sandbox: ${url} is up. Ctrl-C or SIGTERM stops it and removes ${root}.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
