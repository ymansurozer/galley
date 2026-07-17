#!/usr/bin/env node
import { readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getBranch, getGitRoot, gh, git } from "./git.js";
import { validateGuide } from "./guide.js";
import { startServer } from "./server.js";
import { SPEC } from "./spec.js";
import {
  appendComment,
  buildReviewState,
  deskLockPath,
  findLiveDesks,
  loadLatestReview,
  mergeReviewState,
  parsedDiffOf,
  persistReview,
  readDeskLock,
  resolveMovedFrom,
  resolveSkim,
  reviewDir,
  sanitizeSession,
  stablePort,
  syncGitState,
} from "./state.js";
import type { DeskLock } from "./state.js";
import type { Guide, ReviewMode } from "./types.js";
import { maybeOfferUpdate } from "./update.js";

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = { diff: "working", open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-open") out.open = false;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function resolveRepo(args: Record<string, string | boolean>) {
  return path.resolve(String(args.repo ?? process.cwd()));
}

// Default session per mode: <branch> / file-<path> / pr-<ref>, overridable.
function deskSession(
  mode: ReviewMode,
  target: string | undefined,
  branch: string,
  override?: string,
) {
  if (override) return sanitizeSession(override);
  if (mode === "file") return sanitizeSession(`file-${target ?? "file"}`);
  if (mode === "pr") return sanitizeSession(`pr-${target || branch || "pr"}`);
  return sanitizeSession(branch || "review");
}

// For await/comment/reload: honor --session, else auto-find the lone live desk
// (so the agent needn't know the mode prefix), else fall back to the branch.
async function resolveActionSession(
  root: string,
  args: Record<string, string | boolean>,
): Promise<string> {
  if (typeof args.session === "string") return sanitizeSession(args.session);
  const live = await findLiveDesks(root);
  if (live.length === 1) return live[0]!.session;
  if (live.length > 1) {
    console.error(
      `Multiple live desks for this repo (${live.map((l) => l.session).join(", ")}); pass --session <id>.`,
    );
    process.exit(1);
  }
  return sanitizeSession((await getBranch(root)) || "review");
}

// GET with no client-side timeout, so a long-poll holds until the server
// responds. Avoids undici's ~5min headersTimeout that fetch() imposes.
function httpGetJson(urlStr: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.from(c)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(0); // hold indefinitely for the long-poll
  });
}

// A desk lock can outlive its process (crash, SIGKILL) — trust it only if the
// server actually answers. Exported for cli.test.ts; behavior is unchanged.
export async function deskAlive(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${url}api/state`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// `galley comment --path <file> --line <n> [--side additions] --body "..."`
// Posts an agent reply. If a live desk is running for the session, it goes over
// HTTP so the open tab updates immediately; otherwise it is appended to the
// saved review for the next time the desk opens.
async function runComment(args: Record<string, string | boolean>) {
  const root = await getGitRoot(resolveRepo(args)).catch(() => resolveRepo(args));
  const session = await resolveActionSession(root, args);
  const filePath = typeof args.path === "string" ? args.path : "";
  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (!filePath || !body) {
    console.error(
      'Usage: galley comment --path <file> --line <n> [--side additions|deletions] --body "..." [--session <id>] [--repo <path>]',
    );
    process.exitCode = 1;
    return;
  }
  const side: "additions" | "deletions" = args.side === "deletions" ? "deletions" : "additions";
  const payload = {
    path: filePath,
    side,
    lineNumber: Number(args.line ?? 1),
    body,
    role: "agent" as const,
  };
  const lock = await readDeskLock(root, session);
  if (lock) {
    try {
      const res = await fetch(`${lock.url}api/comment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const json = (await res.json()) as { commentId?: string };
        process.stdout.write(
          JSON.stringify({ ok: true, live: true, session, commentId: json.commentId }) + "\n",
        );
        return;
      }
    } catch {
      /* desk not reachable; fall through to offline append */
    }
  }
  const comment = await appendComment(root, session, payload);
  process.stdout.write(
    JSON.stringify({ ok: true, live: false, session, commentId: comment.id }) + "\n",
  );
}

// `galley status --body "..."` — post an ephemeral "what I'm doing now" line that
// shows next to the reviewer's waiting indicator. Unlike comment there is no
// offline fallback: ephemeral status is meaningless without a live desk, and it
// must never fail the agent loop — no desk just reports { live: false }, exit 0.
async function runStatus(args: Record<string, string | boolean>) {
  const root = await getGitRoot(resolveRepo(args)).catch(() => resolveRepo(args));
  const session = await resolveActionSession(root, args);
  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (!body) {
    console.error('Usage: galley status --body "..." [--session <id>] [--repo <path>]');
    process.exitCode = 1;
    return;
  }
  const lock = await readDeskLock(root, session);
  if (lock) {
    try {
      const res = await fetch(`${lock.url}api/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (res.ok) {
        process.stdout.write(JSON.stringify({ ok: true, live: true, session }) + "\n");
        return;
      }
    } catch {
      /* desk not reachable; report not-live below */
    }
  }
  process.stdout.write(JSON.stringify({ ok: false, live: false, session }) + "\n");
}

// `galley stop [--session <id> | --all]` — shut down this repo's live desk(s). Idempotent:
// exit 0 whether or not anything was running, so agents can call it unconditionally when a
// review session ends. Shutdown goes over HTTP (the desk exits after acking, removing its
// own lock) — never a bare kill(pid), which risks PID reuse. A lock whose pid is dead is
// swept; a lock whose pid is alive but whose server won't answer is reported, not killed.
async function runStop(args: Record<string, string | boolean>) {
  const root = await getGitRoot(resolveRepo(args)).catch(() => resolveRepo(args));
  let locks: DeskLock[];
  if (args.all === true) locks = await findLiveDesks(root);
  else {
    const session = await resolveActionSession(root, args);
    const lock = await readDeskLock(root, session);
    locks = lock ? [lock] : [];
  }
  const stopped: string[] = [];
  const unreachable: Array<{ session: string; pid: number }> = [];
  for (const lock of locks) {
    const res = await fetch(`${lock.url}api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    if (res?.ok) {
      stopped.push(lock.session);
      continue;
    }
    const alive = (() => {
      try {
        process.kill(lock.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (alive) unreachable.push({ session: lock.session, pid: lock.pid });
    else unlinkSync(deskLockPath(await reviewDir(root, lock.session)));
  }
  for (const u of unreachable)
    console.error(
      `Desk "${u.session}" (pid ${u.pid}) is running but not answering — kill it manually: kill ${u.pid}`,
    );
  process.stdout.write(JSON.stringify({ ok: true, stopped, unreachable }) + "\n");
}

// `galley await --session <id>` — block until the next desk event, then print it
// to stdout as a tagged envelope and exit. The event is either
//   {"kind":"question","question":{path,lineNumber,side,body,mode,session}}  — answer it now
//   {"kind":"review","result":{…ReviewResult…}}                              — the reviewer hit Send
// Call in a loop and branch on `kind`. Answer a question with `galley comment`.
async function runAwait(args: Record<string, string | boolean>) {
  const root = await getGitRoot(resolveRepo(args)).catch(() => resolveRepo(args));
  const session = await resolveActionSession(root, args);
  const lock = await readDeskLock(root, session);
  if (!lock) {
    console.error(
      `No live desk for session "${session}". Start it with: galley --session ${session}`,
    );
    process.exitCode = 1;
    return;
  }
  let urlStr = `${lock.url}api/await-send`;
  if (typeof args.timeout === "string" && Number(args.timeout) > 0)
    urlStr += `?timeout=${Number(args.timeout)}`;
  const res = await httpGetJson(urlStr).catch(() => null);
  if (!res || res.status === 204 || !res.body) return; // timed out, no event; caller re-runs
  if (res.body.kind) process.stdout.write(JSON.stringify(res.body) + "\n");
}

// `galley reload --session <id> [--guide <file>]` — re-diff the working tree into the
// live desk so the agent's edits show up in the open tab without a restart; --guide
// swaps the attached review guide in the same round-trip.
async function runReload(args: Record<string, string | boolean>) {
  const root = await getGitRoot(resolveRepo(args)).catch(() => resolveRepo(args));
  const session = await resolveActionSession(root, args);
  const lock = await readDeskLock(root, session);
  if (!lock) {
    console.error(
      `No live desk for session "${session}" to reload. Start it with: galley --session ${session}`,
    );
    process.exitCode = 1;
    return;
  }
  const guide = loadGuideArg(args.guide);
  if (guide === null) {
    process.exitCode = 1;
    return;
  }
  const res = await fetch(`${lock.url}api/reload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(guide ? { guide } : {}),
  }).catch(() => null);
  if (!res || !res.ok) {
    console.error("Reload failed — is the desk still running?");
    process.exitCode = 1;
    return;
  }
  const j = (await res.json()) as { baseDiffHash?: string; empty?: boolean };
  process.stdout.write(
    JSON.stringify({
      ok: true,
      live: true,
      session,
      baseDiffHash: j.baseDiffHash,
      empty: j.empty,
    }) + "\n",
  );
}

// Read + validate a guide JSON file for the `--guide` start flag. Returns the validated
// guide, or null on any error (after printing why) so the caller can abort.
function loadGuideArg(value: string | boolean | undefined) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    console.error("--guide requires a path to a guide JSON file, e.g. --guide guide.json");
    return null;
  }
  const SCHEMA = "Run `galley spec` for the full guide schema.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(value, "utf8"));
  } catch (error) {
    console.error(
      `Could not read guide file "${value}" as JSON: ${error instanceof Error ? error.message : String(error)}\n${SCHEMA}`,
    );
    return null;
  }
  const result = validateGuide(parsed);
  if (!result.ok) {
    console.error(`Invalid guide: ${result.reason}.\n${SCHEMA}`);
    return null;
  }
  return result.guide;
}

// A `galley pr <ref>` target is a PR number (`123`) or a GitHub PR URL when it matches these;
// anything else is treated as a plain branch name (the original behavior).
function isPrRef(ref: string) {
  return /^\d+$/.test(ref) || /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(ref);
}

// Resolve a PR number/URL to its head branch + base via the GitHub CLI, checking it out
// (gh handles forks and fetching). Returns the head/base refs. Throws if gh is missing,
// unauthenticated, or the PR can't be found — the caller turns that into a clean exit.
async function resolvePrRef(ref: string, root: string): Promise<{ head: string; base: string }> {
  let info: { headRefName?: string; baseRefName?: string };
  try {
    info = JSON.parse(await gh(["pr", "view", ref, "--json", "headRefName,baseRefName"], root));
  } catch (error) {
    throw new Error(
      `Could not resolve PR "${ref}" via the GitHub CLI. Install gh and run \`gh auth login\`, or pass a branch name instead.\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!info.headRefName || !info.baseRefName)
    throw new Error(`PR "${ref}" did not resolve to a head/base branch.`);
  await gh(["pr", "checkout", ref], root);
  // `gh pr checkout` updates the HEAD but never refreshes the base branch, so a merge-base against
  // a stale local base makes a long-lived PR show unrelated mainline commits (the reported "PR diff
  // is wrong"). Refresh the base ref and diff against the remote-tracking tip, matching GitHub's
  // three-dot "Files changed". Best-effort: offline / a fork base not on `origin` falls back to the
  // bare branch name (prior behavior). --quiet keeps rev-parse from printing on the miss path.
  await git(["fetch", "origin", info.baseRefName], root).catch(() => {});
  const remoteBase = `origin/${info.baseRefName}`;
  const base = await git(["rev-parse", "--verify", "--quiet", remoteBase], root).then(
    () => remoteBase,
    () => info.baseRefName!,
  );
  return { head: info.headRefName, base };
}

// Launch a persistent desk in repo / file / pr mode.
async function runDesk(
  mode: ReviewMode,
  target: string | undefined,
  args: Record<string, string | boolean>,
) {
  // Desk starts only — the agent subcommands must never block on a prompt. On a
  // confirmed update this re-execs the new version with the same args and never returns.
  await maybeOfferUpdate();
  const repo = resolveRepo(args);
  const staged = args.diff === "staged" || args.staged === true;
  const root = await getGitRoot(repo).catch(() => repo);
  const branch = (await getBranch(root)) || "";

  // PR mode targets a branch by default; a numeric ref or GitHub PR URL is resolved to its
  // head/base branches via the GitHub CLI. prTarget/prBase carry the effective values.
  let prTarget = target;
  let prBase = mode === "pr" && typeof args.base === "string" ? args.base : undefined;

  if (mode === "pr" && target) {
    const dirty = await git(["status", "--porcelain", "--untracked-files=no"], root).catch(
      () => "",
    );
    if (dirty.trim()) {
      console.error(
        `Working tree has uncommitted changes to tracked files — commit or stash before reviewing a PR (no checkout performed):\n${dirty}`,
      );
      process.exitCode = 1;
      return;
    }
    if (isPrRef(target)) {
      try {
        const pr = await resolvePrRef(target, root);
        prTarget = pr.head;
        if (!prBase) prBase = pr.base;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }
    } else {
      try {
        await git(["checkout", target], root);
      } catch (error) {
        console.error(
          `Could not check out "${target}": ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
        return;
      }
    }
  }

  const session = deskSession(
    mode,
    prTarget,
    branch,
    typeof args.session === "string" ? args.session : undefined,
  );
  // Idempotent start: a live desk for this repo+session is reused — reload the diff
  // (and swap the guide, if one was passed) into the open tab instead of opening a
  // second desk on a new port. Use --session/--port for a genuinely separate desk.
  const liveLock = await readDeskLock(root, session);
  if (liveLock && (await deskAlive(liveLock.url))) {
    const guide = loadGuideArg(args.guide);
    if (guide === null) {
      process.exitCode = 1;
      return;
    }
    const res = await fetch(`${liveLock.url}api/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(guide ? { guide } : {}),
    }).catch(() => null);
    if (res?.ok) {
      console.error(
        `Desk already live for session "${session}" — reloaded${guide ? " with the new guide" : ""} in the open tab: ${liveLock.url}`,
      );
      return;
    }
    console.error("Live desk did not accept the reload — starting a fresh one.");
  }
  const base = await buildReviewState(repo, {
    mode,
    session,
    staged,
    path:
      mode === "file"
        ? target
        : mode === "repo"
          ? typeof args.path === "string"
            ? args.path
            : undefined
          : undefined,
    target: mode === "pr" ? prTarget || branch : undefined,
    base: mode === "pr" ? prBase : undefined,
  });
  if (!base) {
    console.error(
      mode === "pr"
        ? "No PR changes to review (branch matches its base)."
        : mode === "file"
          ? "File not found or unreadable."
          : "No git diff found to review.",
    );
    process.exitCode = 1;
    return;
  }
  const saved = await loadLatestReview(base.root, session);
  // Load the new guide (if any) up front — loadGuideArg validates it. Guide-declared moves
  // (movedFrom) must merge into `base` BEFORE reconciliation, so the merged pair's distinct paths
  // drive mergeReviewState's rename migration (issue 01). A new guide resolves strictly (an
  // unresolvable move aborts the launch); a guide carried forward by a previous session resolves
  // leniently off the saved state (the move drops back to delete+add).
  let newGuide: Guide | undefined;
  if (args.guide !== undefined) {
    const loaded = loadGuideArg(args.guide);
    if (!loaded) {
      process.exitCode = 1;
      return;
    }
    newGuide = loaded;
  }
  const moveGuide = newGuide ?? saved?.guide;
  if (moveGuide) {
    const moved = resolveMovedFrom(base, moveGuide, { strict: !!newGuide });
    if (!moved.ok) {
      console.error(`Invalid guide: ${moved.reason}.`);
      process.exitCode = 1;
      return;
    }
  }
  const state = await mergeReviewState(base, saved);
  // Optional agent-generated guided review, attached at startup. Required to be a readable,
  // valid JSON file when --guide is passed; survives reload via the state merge.
  if (newGuide) {
    // Stamp the diff hash the guide was generated against; if a later reload advances the
    // diff past it, the desk flags the guide as possibly stale (slice 05).
    state.guide = { ...newGuide, baseDiffHash: state.baseDiffHash };
    // Resolve skim spans against the fresh diff and stamp the collapsed blocks. Strict at
    // initial attach: an unresolvable span aborts the launch naming the offending field, like
    // any other invalid-guide input.
    // state.rawDiff shares identity with base.rawDiff, so pass the parse seeded on `base` — the
    // reload/launch parses the diff once, shared across build + skim resolution (issue 06).
    const skim = resolveSkim(
      state.rawDiff,
      state.changes,
      state.guide,
      { strict: true },
      parsedDiffOf(base),
    );
    if (!skim.ok) {
      console.error(`Invalid guide: ${skim.reason}.`);
      process.exitCode = 1;
      return;
    }
  } else if (state.guide) {
    // A guide carried forward by the merge (restart without --guide): re-resolve leniently
    // against the new diff — stale spans drop rather than abort (see resolveSkim).
    resolveSkim(state.rawDiff, state.changes, state.guide, { strict: false }, parsedDiffOf(base));
  }
  if (mode === "repo") await syncGitState(state);
  await persistReview(state);

  const lockFile = deskLockPath(await reviewDir(state.root, state.session));
  // Default to the stable per-session port so a restarted desk keeps the same origin
  // and an already-open tab reconnects by itself (startServer falls back to a random
  // port if a foreign process holds it).
  // Abandoned-desk reaper: exit after this long with no tab polling and no agent
  // attached (see startServer). Minutes; 0 disables. Persistence + the stable port
  // make auto-exit safe — a later start restores the session in the same tab.
  const idleMinutes = typeof args["idle-timeout"] === "string" ? Number(args["idle-timeout"]) : NaN;
  const { url } = await startServer({
    state,
    port: typeof args.port === "string" ? Number(args.port) : stablePort(state.root, state.session),
    open: args.open !== false,
    idleTimeoutMs:
      Number.isFinite(idleMinutes) && idleMinutes >= 0 ? idleMinutes * 60_000 : undefined,
  });

  writeFileSync(
    lockFile,
    JSON.stringify({
      pid: process.pid,
      url,
      session: state.session,
      startedAt: new Date().toISOString(),
    }) + "\n",
    "utf8",
  );
  const releaseLock = () => {
    try {
      unlinkSync(lockFile);
    } catch {
      /* already gone */
    }
  };
  let released = false;
  const cleanup = () => {
    if (!released) {
      released = true;
      releaseLock();
    }
  };
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }

  const label =
    mode === "repo" ? state.session : `${mode}:${state.target ?? ""} [${state.session}]`;
  console.error(`Galley ${label}: ${url}`);
  console.error("Live desk — the agent attaches with `galley await`. Ctrl-C to stop.");

  // The desk is persistent: keep serving across rounds until interrupted.
  await new Promise<never>(() => {});
}

const HELP = `galley — an integrated review environment (IRE) for code you didn't write by hand.

Usage:
  galley [--diff working|staged]    Review the working-tree (default) or staged diff
  galley file <path>                Review a single file or artifact (tracked or not)
  galley pr <ref|number|url>        Review a branch's commits vs its merge-base
  galley comment --path <f> --line <n> --body "..."   Post an agent reply into the desk
  galley status --body "..."        Post an ephemeral "what I'm doing" line into the desk
  galley await [--timeout <s>]      Block for the next desk event (question | review)
  galley reload [--guide <file>]    Re-diff the working tree into the open desk
                                    (--guide swaps the attached review guide too)
  galley stop [--session <id>|--all]  Stop this repo's live desk(s); idempotent
  galley spec                       Print the full agent contract (modes, loop, ReviewResult, guide schema)

Common flags:
  --repo <path>     Repo to review (default: cwd)
  --session <id>    Review session id (default: branch / file-<path> / pr-<ref>)
  --port <n>        Server port (default: a stable per-session port (41000–50999))
  --guide <file>    Attach an AI review guide (JSON)
  --idle-timeout <m>  Desk auto-exits after <m> minutes with no tab or agent (default 120; 0 = never)
  --no-open         Don't open the browser
  -h, --help        Show this help
  -v, --version     Show version

Env:
  GALLEY_NO_UPDATE_CHECK=1   Skip the new-version check at desk start

Docs: https://github.com/ymansurozer/galley`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("-v") || argv.includes("--version")) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    return;
  }
  if (argv[0] === "help" || argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
  const rest = sub ? argv.slice(1) : argv;
  const positional = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  const args = parseArgs(rest);
  if (sub === "comment") return runComment(args);
  if (sub === "status") return runStatus(args);
  if (sub === "await") return runAwait(args);
  if (sub === "reload") return runReload(args);
  if (sub === "stop") return runStop(args);
  if (sub === "spec") {
    process.stdout.write(SPEC + "\n");
    return;
  }
  if (sub === "file") {
    if (!positional) {
      console.error("Usage: galley file <path>");
      process.exitCode = 1;
      return;
    }
    return runDesk("file", positional, args);
  }
  if (sub === "pr") return runDesk("pr", positional, args);
  if (sub) {
    console.error(
      `Unknown command "${sub}". Use: galley | galley file <path> | galley pr <ref|number|url> | comment | status | await | reload | stop | spec.`,
    );
    process.exitCode = 1;
    return;
  }
  return runDesk("repo", undefined, args);
}

// Run only when executed as the bin (`galley` / `node dist/cli.js`), not when cli.test.ts
// imports this module to reach deskAlive() — otherwise import alone would launch a desk. npm
// installs the bin as a SYMLINK (.bin/galley -> dist/cli.js); Node resolves import.meta.url
// through the symlink to the real path, but leaves process.argv[1] as the symlink path — so
// argv[1] must be realpath'd before comparing, or the guard never fires under the published
// bin and the CLI silently no-ops. try/catch guards a dangling/unusual argv[1].
let isMain = false;
try {
  isMain =
    !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
} catch {
  /* argv[1] doesn't resolve — treat as not the entry point */
}
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
