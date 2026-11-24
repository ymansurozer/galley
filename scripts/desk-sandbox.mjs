// A disposable desk for testing Galley by hand or from an agent. A desk writes settings, locks and
// saved reviews under $HOME/.galley, so a test desk run against the real HOME rewrites the user's
// own settings and reviews. This one gets a throwaway HOME and a fixture repo with one change of
// every kind, binds loopback on a port in 5100-5299, prints one JSON line once /api/state serves
// the fixture, and removes it all on Ctrl-C, SIGTERM, SIGHUP or `galley stop`. With --guide it also
// attaches a topics guide, so the desk opens in Decisions mode with a reviewer's thread to answer.
// Run: pnpm build && pnpm --silent desk:sandbox [--guide]
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
const STOP_MS = 5_000;
// One file per change kind the desk distinguishes, so the tree, the diff and a rename all render,
// plus two files sharing a name, so a check that finds files by name alone can't pass.
const FIXTURE_PATHS = [
  "README.md",
  "docs/README.md",
  "src/greet.ts",
  "src/format.ts",
  "docs/guide.md",
  "notes/obsolete.txt",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (child) => child.exitCode === null && child.signalCode === null;
const fail = (message) => {
  console.error(`desk:sandbox: ${message}`);
  process.exitCode = 1;
  shutdown();
};
// POSIX sh single quotes keep every byte literal; a quote inside closes, escapes and reopens.
const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--guide");
if (unknown.length) {
  console.error(`desk:sandbox: unknown argument ${unknown[0]}. Usage: desk:sandbox [--guide]`);
  process.exit(1);
}
const GUIDED = args.includes("--guide");

if (!existsSync(CLI)) {
  console.error("desk:sandbox: dist/cli.js is missing. Run `pnpm build` first.");
  process.exit(1);
}

const root = mkdtempSync(path.join(tmpdir(), "galley-sandbox-"));
const home = path.join(root, "home");
const repo = path.join(root, "repo");
// Outside the repo, so the guide is no change under review, and inside the root, so it goes with it.
const guidePath = path.join(root, "guide.json");
let desk;
let stopping = false;

// The fixture's git and the desk (which runs git too) share one environment that can reach
// nothing outside the root. The caller's GIT_* variables would otherwise steer them: GIT_DIR
// alone points `git init` and `git commit` at another repository. Every XDG base, including the
// one git reads its global config from, resolves inside the throwaway HOME.
function sandboxEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith("GIT_") && !key.startsWith("GALLEY_")) env[key] = value;
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GALLEY_HOST: "127.0.0.1",
    GALLEY_PORT_RANGE: `${PORT_LO}-${PORT_HI}`,
    GALLEY_NO_UPDATE_CHECK: "1",
  };
}

// Synchronous so it also runs from the exit handler. The desk only writes under the throwaway
// HOME, so removing the root while it dies loses nothing.
function cleanup() {
  if (desk && alive(desk)) desk.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}

// SIGTERM, then SIGKILL once STOP_MS passes, so a hung desk can't hold a stop open.
function stopDesk(child) {
  return new Promise((resolve) => {
    if (!alive(child)) return resolve();
    const force = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  (desk ? stopDesk(desk) : Promise.resolve()).then(() => {
    cleanup();
    process.exit();
  });
}

process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, shutdown);

function writeFixture() {
  mkdirSync(home);
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  };
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore", env: sandboxEnv() });

  write("README.md", "# Sandbox\n\nA fixture repo for a Galley test desk.\n");
  write("docs/README.md", "# Docs\n\nStart with the guide.\n");
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
  write("docs/README.md", "# Docs\n\nStart with the guide, then the sources.\n");
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

// A Decisions-mode guide over the fixture's diff: two groups, every changed block under a topic and
// the pure rename skimmed, as the desk's coverage check demands. The first topic carries a flag card,
// a list and inline code, and gets the seeded thread (seedThread); the second quotes the diff
// through a `lines` fence.
const FLAG_TOPIC = "title-case";
const THREAD = "sandbox-q1";
const FLAG =
  "`title` upper-cases one UTF-16 code unit, so a name that opens with an emoji comes back unchanged.";
function writeGuide() {
  const topic = (id, title, recorded, body, covers, extra) => ({
    id,
    title,
    recorded,
    body,
    covers,
    ...extra,
  });
  const guide = {
    title: "Sandbox review",
    overview: "The sandbox greets a name in title case, and its docs say where to start.",
    stages: [
      {
        id: "sandbox",
        label: "Sandbox",
        groups: [
          {
            id: "greeting",
            title: "Greeting",
            summary: "How `greet` shapes a name.",
            topics: [
              topic(
                FLAG_TOPIC,
                "Title-case a name through a helper of its own",
                "Only the code records this.",
                "`greet` passes the name through `title` from `src/format.ts`:\n\n" +
                  "- `title` upper-cases the first character and keeps the rest.\n" +
                  '- An empty name stays empty: `title("")` returns `""`.\n' +
                  "- Nothing else calls `title` yet.\n",
                [{ path: "src/format.ts" }],
                { flag: FLAG },
              ),
              topic(
                "exclaim",
                "End the greeting with an exclamation mark",
                "Only the code records this.",
                "The greeting reads `Hello, Ada!` now.\n\n```lines\nsrc/greet.ts:1-5\n```\n",
                [],
              ),
            ],
          },
          {
            id: "docs",
            title: "Docs",
            summary: "Where a reader starts.",
            topics: [
              topic(
                "readme",
                "Point readers at the guide first",
                "README.md and docs/README.md.",
                "Both READMEs gain a line on what to read first.",
                [{ path: "README.md" }, { path: "docs/README.md" }],
              ),
              topic(
                "obsolete-note",
                "Drop the obsolete note",
                "Only the code records this.",
                "Nothing reads `notes/obsolete.txt` any more.",
                [{ path: "notes/obsolete.txt" }],
              ),
            ],
          },
        ],
      },
    ],
    skims: [{ reason: "A pure rename, nothing to read", covers: [{ path: "docs/guide.md" }] }],
  };
  writeFileSync(guidePath, JSON.stringify(guide, null, 2));
}

// Starts a desk and resolves with it and the port it printed in
// `Galley <session>: http://127.0.0.1:<port>/` on stderr. The line can arrive split, so chunks
// accumulate until it shows; from then on the desk's stderr passes straight through.
function startDesk(port) {
  const child = spawn(
    process.execPath,
    [
      CLI,
      "--repo",
      repo,
      "--session",
      SESSION,
      "--port",
      String(port),
      "--no-open",
      ...(GUIDED ? ["--guide", guidePath] : []),
    ],
    { stdio: ["ignore", "ignore", "pipe"], env: sandboxEnv() },
  );
  desk = child;
  let log = "";
  return new Promise((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error(`the desk printed no URL within ${READY_MS / 1000}s:\n${log}`));
    }, READY_MS);
    const onData = (d) => {
      log += d;
      const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!m) return;
      settle();
      child.stderr.pipe(process.stderr);
      resolve({ child, port: Number(m[1]) });
    };
    const onExit = (code, signal) => {
      settle();
      reject(new Error(`the desk exited (${signal ?? code}) before printing its URL:\n${log}`));
    };
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

// Ready means /api/state serves the fixture: the payload the tab renders from, not only a socket.
// Each request is bounded by the time left, so a desk that accepts and then stalls can't hold the
// wait past its deadline.
async function waitForFixture(child, base) {
  const deadline = Date.now() + READY_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    if (!alive(child)) throw new Error("the desk exited before it served the fixture");
    try {
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const res = await fetch(`${base}/api/state`, { signal });
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
  throw new Error(`the desk never served the fixture within ${READY_MS / 1000}s (${last})`);
}

const getState = async (base) => {
  const res = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(READY_MS) });
  if (!res.ok) throw new Error(`/api/state answered ${res.status}`);
  return res.json();
};

// A reviewer's question on the flag topic's Flagged note, saved the way the tab saves a new thread,
// then the agent's answer through `galley comment --topic`, so the thread shows both roles. Resolves
// only once /api/state holds the guide and the answered thread, so the ready line promises both.
async function seedThread(base) {
  const state = await getState(base);
  const at = new Date().toISOString();
  const res = await fetch(`${base}/api/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      base: state.saveNumber ?? 0,
      changes: {
        topicThreads: {
          changed: [
            {
              id: THREAD,
              target: { topic: FLAG_TOPIC, part: "flag" },
              title: "",
              quote: FLAG,
              intent: "question",
              status: "open",
              comments: [
                {
                  id: "sandbox-q1-m1",
                  role: "user",
                  intent: "question",
                  body: "Does any caller pass a name that opens with an emoji?",
                  createdAt: at,
                  updatedAt: at,
                },
              ],
            },
          ],
          removed: [],
        },
      },
      seen: {
        token: null,
        reloadGeneration: state.reloadGeneration ?? 0,
        baseDiffHash: state.baseDiffHash,
      },
    }),
  });
  if (!res.ok) throw new Error(`seeding the topic thread: /api/save answered ${res.status}`);
  execFileSync(
    process.execPath,
    [
      CLI,
      "comment",
      "--repo",
      repo,
      "--session",
      SESSION,
      "--topic",
      THREAD,
      "--body",
      "Not yet: the only caller is `greet`, and the fixture passes ASCII names.",
    ],
    { stdio: ["ignore", "ignore", "pipe"], env: sandboxEnv() },
  );
  const seeded = await getState(base);
  const thread = seeded.topicThreads?.find((t) => t.id === THREAD);
  if (
    !seeded.guide?.stages?.some((st) =>
      st.groups.some((g) => g.topics.some((t) => t.id === FLAG_TOPIC)),
    )
  )
    throw new Error("the desk holds no fixture guide after the seed");
  if (thread?.target.part !== "flag" || thread.comments.map((m) => m.role).join() !== "user,agent")
    throw new Error(
      `the desk lacks the seeded thread on ${FLAG_TOPIC}'s flag, question and answer`,
    );
}

try {
  writeFixture();
  if (GUIDED) writeGuide();
  let started;
  for (let attempt = 1; attempt <= ATTEMPTS && !started; attempt++) {
    const start = PORT_LO + Math.floor(Math.random() * (PORT_HI - PORT_LO + 1));
    const { child, port } = await startDesk(start);
    if (port >= PORT_LO && port <= PORT_HI) started = { child, port };
    else {
      console.error(
        `desk:sandbox: the desk bound ${port}, outside ${PORT_LO}-${PORT_HI}; retrying`,
      );
      await stopDesk(child);
    }
  }
  if (!started)
    throw new Error(
      `every port in ${PORT_LO}-${PORT_HI} stayed taken; stop a desk you no longer need and retry`,
    );
  const { child, port } = started;

  // The desk ends the sandbox either way: a clean exit after the ready line is `galley stop`,
  // anything else a crash whose only clue is the desk's stderr above.
  let ready = false;
  child.once("exit", (code, signal) => {
    if (stopping) return;
    if (ready && code === 0) {
      console.error("desk:sandbox: the desk stopped; sandbox removed");
      shutdown();
    } else fail(`the desk exited (${signal ?? code}); sandbox removed`);
  });
  const url = `http://127.0.0.1:${port}/`;
  await waitForFixture(child, url.slice(0, -1));
  if (GUIDED) await seedThread(url.slice(0, -1));
  if (!alive(child) || stopping) throw new Error("the desk exited before it was ready");

  ready = true;
  console.log(
    JSON.stringify({
      ready: true,
      url,
      port,
      session: SESSION,
      repo,
      home,
      pid: process.pid,
      cli: `env -i PATH="$PATH" HOME=${shellQuote(home)} GIT_CONFIG_NOSYSTEM=1 ${shellQuote(process.execPath)} ${shellQuote(CLI)} <command> --repo ${shellQuote(repo)} --session ${SESSION}`,
    }),
  );
  console.error(`desk:sandbox: ${url} is up. Ctrl-C or SIGTERM stops it and removes ${root}.`);
} catch (error) {
  if (!stopping) fail(error instanceof Error ? error.message : String(error));
}
