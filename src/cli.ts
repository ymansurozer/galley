#!/usr/bin/env node
import http from "node:http";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getBranch, getGitRoot, gh, git } from "./git.js";
import {
  appendComment,
  buildReviewState,
  deskLockPath,
  findLiveDesks,
  loadLatestReview,
  mergeReviewState,
  persistReview,
  readDeskLock,
  reviewDir,
  sanitizeSession,
  syncGitState,
} from "./state.js";
import { validateGuide } from "./guide.js";
import { GUIDE_SPEC } from "./guidespec.js";
import { startServer } from "./server.js";
import type { ReviewMode } from "./types.js";

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

// `galley reload --session <id>` — re-diff the working tree into the live desk
// so the agent's edits show up in the open tab without a restart.
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
  const res = await fetch(`${lock.url}api/reload`, { method: "POST" }).catch(() => null);
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
  const SCHEMA =
    "Expected JSON: { overview, prDescription?, files: [{ path, order, category, summary, critical?, why? }] }.";
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
  return { head: info.headRefName, base: info.baseRefName };
}

// Launch a persistent desk in repo / file / pr mode.
async function runDesk(
  mode: ReviewMode,
  target: string | undefined,
  args: Record<string, string | boolean>,
) {
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
  const state = mergeReviewState(base, saved);
  // Optional agent-generated guided review, attached at startup. Required to be a readable,
  // valid JSON file when --guide is passed; survives reload via the state merge.
  if (args.guide !== undefined) {
    const guide = loadGuideArg(args.guide);
    if (!guide) {
      process.exitCode = 1;
      return;
    }
    // Stamp the diff hash the guide was generated against; if a later reload advances the
    // diff past it, the desk flags the guide as possibly stale (slice 05).
    state.guide = { ...guide, baseDiffHash: state.baseDiffHash };
  }
  if (mode === "repo") await syncGitState(state);
  await persistReview(state);

  const lockFile = deskLockPath(await reviewDir(state.root, state.session));
  const { url } = await startServer({
    state,
    port: typeof args.port === "string" ? Number(args.port) : 0,
    open: args.open !== false,
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
  galley await [--timeout <s>]      Block for the next desk event (question | review)
  galley reload                     Re-diff the working tree into the open desk
  galley guide-spec                 Print the guide JSON schema + authoring rules

Common flags:
  --repo <path>     Repo to review (default: cwd)
  --session <id>    Review session id (default: branch / file-<path> / pr-<ref>)
  --port <n>        Server port (default: random)
  --guide <file>    Attach an AI review guide (JSON)
  --no-open         Don't open the browser
  -h, --help        Show this help
  -v, --version     Show version

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
  if (sub === "await") return runAwait(args);
  if (sub === "reload") return runReload(args);
  if (sub === "guide-spec") {
    process.stdout.write(GUIDE_SPEC + "\n");
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
      `Unknown command "${sub}". Use: galley | galley file <path> | galley pr <ref|number|url> | comment | await | reload | guide-spec.`,
    );
    process.exitCode = 1;
    return;
  }
  return runDesk("repo", undefined, args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
