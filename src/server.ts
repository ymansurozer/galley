import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveEditorCommand } from "./editor.js";
import { blobOid, git, listProjectTree, patchForChange } from "./git.js";
import { validateGuide } from "./guide.js";
import { createSerializer } from "./mutex.js";
import {
  anchorTextFor,
  buildReviewResult,
  buildReviewState,
  hash,
  mergeReviewerSave,
  mergeReviewState,
  parsedDiffOf,
  nowIso,
  persistReview,
  questionPayload,
  readFileContents,
  readGlobalSettings,
  resolveMovedFrom,
  resolveSkim,
  syncGitState,
  writeGlobalSettings,
} from "./state.js";
import type {
  AgentActivity,
  AwaitEvent,
  DeskStatus,
  PollPayload,
  QuestionPayload,
  ReviewState,
} from "./types.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = "Run `galley spec` for the full agent contract.";

export type ServerOptions = {
  state: ReviewState;
  port?: number;
  // Bind address. Defaults to 127.0.0.1 (loopback-only) — the desk stays local unless explicitly
  // opted into a broader bind (--host / GALLEY_HOST). See resolveBinding for how this shapes the
  // origin guard, the printed URL, and the lock-file URL.
  host?: string;
  // Extra host names (beyond the machine's hostname/bound address) whose authority the origin guard
  // trusts when bound non-loopback — GALLEY_ALLOWED_HOSTS, for exotic names like a MagicDNS FQDN.
  allowedHosts?: string[];
  open?: boolean;
  // Test seam: lets server.test.ts assert the resolved editor invocation without
  // actually launching anything.
  runEditorCommand?: (command: string, args: string[]) => Promise<void>;
  // Test seam: TTL for the ephemeral agent-activity line (default 90s).
  statusTtlMs?: number;
  // Auto-exit after this long with no HTTP activity (default 2h; 0 disables). An open
  // tab polls /api/state and a waiting agent holds /api/await-send, so "idle" really
  // means abandoned — no tab, no agent. State is persisted on every save and the desk
  // is idempotent on a stable port, so restarting later restores everything.
  idleTimeoutMs?: number;
  // Test seam: called instead of process.exit(0) when the desk shuts itself down
  // (idle timeout or POST /api/shutdown).
  onShutdown?: (reason: "idle" | "stop") => void;
};

export type ServerHandle = {
  server: http.Server;
  // The URL to open/print — reachable from the reviewer's browser (hostname-based when bound
  // non-loopback). Equals lockUrl for the default loopback bind.
  url: string;
  // The URL the same-machine agent CLI reaches the desk at (recorded in the desk lock) — loopback
  // for a loopback/wildcard bind, the bound address for a specific non-loopback bind.
  lockUrl: string;
};

// 50 MB: pre-0.6.2 tabs post the entire multi-MB ReviewState on /api/send, and a big PR desk
// crosses 5 MB — the old cap made Send fail on exactly the largest reviews (readBody threw
// before the result was built, so no artifact and no event, while slice-only auto-saves kept
// succeeding). The server is localhost-only, so a generous cap is safe.
async function readBody(req: http.IncomingMessage, limit = 50_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function fail(res: http.ServerResponse, status: number, code: string, error: string, fix: string) {
  json(res, status, { error, code, fix, docs: DOCS });
}

// Wrap a bare IPv6 literal in brackets for use as a URL/authority host; leave names and IPv4
// (and already-bracketed literals) untouched. An IPv6 address is the only host that needs it.
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

// The loopback authorities #51 has always trusted. A non-loopback bind EXTENDS this set (never
// replaces it) so the same-machine agent CLI, which talks to 127.0.0.1 regardless of bind address,
// keeps working.
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;
// Host strings that mean "this machine's loopback" (no widening) and "every interface" (a wildcard
// bind has no single address to advertise, so loopback still reaches it).
const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]"]);

export type Binding = {
  // The URL a browser (possibly on another device) uses — printed and opened.
  browserHost: string;
  // The URL the same-machine agent CLI reaches the desk at, recorded in the desk lock.
  lockHost: string;
  // The host names whose `name:port` authority the origin guard accepts, beyond the port.
  allowedHosts: string[];
};

// Derive the browser URL host, the lock-file URL host, and the origin-guard authority names from
// the bind address. Pure (hostname + env injected) so it's unit-testable without binding exotic
// addresses. The default (loopback) path adds NOTHING to the loopback authority set and keeps both
// URLs on 127.0.0.1 — byte-for-byte the pre-flag behavior. A wildcard bind (0.0.0.0/::) advertises
// the machine's hostname to the browser but keeps the lock on loopback (still reachable). A specific
// non-loopback bind can't be reached over loopback, so both URLs use that exact address. os.hostname()
// and any GALLEY_ALLOWED_HOSTS (a MagicDNS FQDN differs from the short hostname) widen the guard.
export function resolveBinding(host: string, hostname: string, allowedHostsEnv: string[]): Binding {
  if (LOOPBACK_BINDS.has(host))
    return { browserHost: "127.0.0.1", lockHost: "127.0.0.1", allowedHosts: [...LOOPBACK_HOSTS] };
  const wildcard = WILDCARD_BINDS.has(host);
  const extra = [hostname, ...(wildcard ? [] : [urlHost(host)]), ...allowedHostsEnv].filter(
    Boolean,
  );
  return {
    browserHost: wildcard ? hostname : urlHost(host),
    lockHost: wildcard ? "127.0.0.1" : urlHost(host),
    allowedHosts: [...LOOPBACK_HOSTS, ...extra],
  };
}

// Lock the desk to its own trusted origin. stablePort binds a *deterministic* port, so the origin is
// guessable — without this, any page the reviewer has open in the same browser could POST to the
// state-changing routes (CSRF: /api/reset wipes the review, /api/shutdown kills the desk) or read the
// diff off-machine (the dropped wildcard CORS). The Host check defeats DNS-rebinding — a rebinding
// attack arrives with the attacker's hostname in Host — so only the desk's own authorities pass.
// `allowedHosts` is the loopback set by default (a loopback bind), EXTENDED with the machine's
// hostname / bound address / GALLEY_ALLOWED_HOSTS when bound beyond loopback (see resolveBinding),
// never widened otherwise. The Origin check blocks cross-site POSTs; header-less callers (curl and
// the `galley await`/`comment`/`reload`/`status` CLI, which target 127.0.0.1 and send no Origin) stay
// allowed. Returns false once it has answered 403.
function originAllowed(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
  allowedHosts: readonly string[],
): boolean {
  const authorities = allowedHosts.map((h) => `${h}:${port}`);
  const host = req.headers.host;
  if (!host || !authorities.includes(host)) {
    fail(
      res,
      403,
      "FORBIDDEN_HOST",
      `Host "${host ?? ""}" is not this desk.`,
      "Reach the desk at its 127.0.0.1 origin.",
    );
    return false;
  }
  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin && !authorities.some((a) => origin === `http://${a}`)) {
      fail(
        res,
        403,
        "FORBIDDEN_ORIGIN",
        `Cross-site request from origin "${origin}" is not allowed.`,
        "The desk only accepts same-origin requests.",
      );
      return false;
    }
  }
  return true;
}

// Resolve a UI asset against the built location first (__dirname is dist/ in a
// real install), then a dev fallback. Under `pnpm dev` the server runs from
// source via tsx, so __dirname is src/ — the served bundle lives in dist/ and
// the page markup in src/ui/.
async function firstExisting(...candidates: string[]) {
  for (const p of candidates)
    if (
      await fs.stat(p).then(
        () => true,
        () => false,
      )
    )
      return p;
  return candidates[0];
}

async function uiBundlePath() {
  return firstExisting(path.join(__dirname, "ui.js"), path.join(process.cwd(), "dist", "ui.js"));
}

async function html() {
  const file = await firstExisting(
    path.join(__dirname, "index.html"),
    path.join(process.cwd(), "src", "ui", "index.html"),
  );
  return fs.readFile(file, "utf8");
}

async function applyPatchToIndex(root: string, patch: string) {
  const tmp = path.join(
    // os.tmpdir(), not $TMPDIR-or-/tmp: Windows sets TEMP/TMP instead, so the old fallback
    // resolved to a nonexistent C:\tmp and mkdtemp ENOENT'd — hunk staging failed there.
    await fs.mkdtemp(path.join(os.tmpdir(), "galley-")),
    `${crypto.randomUUID()}.diff`,
  );
  await fs.writeFile(tmp, patch, "utf8");
  try {
    const baseArgs = ["apply", "--cached", "--unidiff-zero"];
    const alreadyApplied = await git([...baseArgs, "--reverse", "--check", tmp], root).then(
      () => true,
      () => false,
    );
    if (alreadyApplied) return "skipped" as const;
    await git([...baseArgs, tmp], root);
    return "applied" as const;
  } finally {
    await fs.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => undefined);
  }
}

async function openUrl(url: string) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await execFileAsync(command, args).catch(() => undefined);
}

// Repo-relative path → absolute, or null if it is absolute or escapes the repo.
// /api/open-editor hands this to a local process, so the boundary must be strict.
function repoPath(root: string, rel: string) {
  if (path.isAbsolute(rel)) return null;
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, rel);
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) return null;
  return abs;
}

// Resolve a repo-relative path to an absolute one that provably stays inside the repo
// AFTER symlinks are followed. The plain startsWith check runs on the UNRESOLVED path,
// so an in-repo symlink pointing outside the repo passes it and readFile then follows
// the link off-tree. Mirror state.ts's working-tree read: realpath the target and the
// root, then re-check containment. "missing" (realpath ENOENT) stays distinct from
// "escape" so a route can 404 a nonexistent file while /api/file-contents still serves
// a file whose bytes come from git (deleted / index-only), not the working tree.
async function resolveContained(
  root: string,
  rel: string,
): Promise<{ abs: string } | { error: "escape" | "missing" }> {
  const resolvedRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const abs = path.resolve(resolvedRoot, rel);
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) return { error: "escape" };
  const real = await fs.realpath(abs).catch(() => null);
  if (real === null) return { error: "missing" };
  if (real !== resolvedRoot && !real.startsWith(resolvedRoot + path.sep))
    return { error: "escape" };
  return { abs: real };
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { state } = options;
  const host = options.host ?? "127.0.0.1";
  const binding = resolveBinding(host, os.hostname(), options.allowedHosts ?? []);
  // The desk is a living surface: it keeps serving across rounds. `galley await` is a
  // tagged event stream — a "question" (reviewer clicked Ask, wants an answer now) or a
  // "review" (Send). Events hand to a parked waiter, else queue (FIFO) until one arms.
  const eventWaiters: Array<(ev: AwaitEvent) => void> = [];
  const eventQueue: AwaitEvent[] = [];
  const emitEvent = (ev: AwaitEvent) => {
    const waiter = eventWaiters.shift();
    if (waiter) waiter(ev);
    else eventQueue.push(ev);
  };

  // Ephemeral "what the agent is doing now" line (`galley status`). Lives only in
  // this process — never on `state`, which persistReview serializes verbatim.
  // Staleness is checked on read (no timers): a crashed agent's last line must not
  // show as live activity forever.
  const statusTtlMs = options.statusTtlMs ?? 90_000;
  let agentActivity: AgentActivity | null = null;
  const liveActivity = () => {
    if (agentActivity && Date.now() - Date.parse(agentActivity.at) > statusTtlMs)
      agentActivity = null;
    return agentActivity;
  };
  const deskStatus = (): DeskStatus => ({
    agentActivity: liveActivity(),
    agentListening: eventWaiters.length > 0,
    queuedQuestions: eventQueue.filter((e) => e.kind === "question").length,
    queuedReviews: eventQueue.filter((e) => e.kind === "review").length,
  });

  // Desk lifecycle: without this, an abandoned desk (tab closed, agent gone) serves
  // forever and desks accumulate across repos/sessions. Any request marks activity;
  // an in-flight request (the await-send long-poll especially) pins the desk alive
  // via activeRequests, so only a desk nobody is connected to can idle out.
  const shutdown =
    options.onShutdown ??
    ((reason: "idle" | "stop") => {
      console.error(
        reason === "idle"
          ? `Desk idle — shutting down. Restart with: galley --session ${state.session}`
          : "Desk stopped via galley stop.",
      );
      process.exit(0);
    });
  const idleMs = options.idleTimeoutMs ?? 2 * 60 * 60 * 1000;
  let lastActivity = Date.now();
  let activeRequests = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  if (idleMs > 0) {
    // Check often enough that tests can use tiny timeouts, rarely enough to be free.
    idleTimer = setInterval(
      () => {
        if (activeRequests === 0 && Date.now() - lastActivity >= idleMs) {
          clearInterval(idleTimer); // one-shot: never re-fire while shutdown runs
          shutdown("idle");
        }
      },
      Math.min(60_000, Math.max(idleMs / 4, 10)),
    );
    idleTimer.unref();
  }

  // Serialize every state/git-index-mutating route through one promise-chain mutex. Both
  // /api/send and /api/reload walk `state` across several awaits (send: mergeReviewerSave →
  // syncGitState → persistReview → buildReviewResult; reload: buildReviewState → mergeReviewState
  // → Object.assign(state) → syncGitState → persistReview). With no mutual exclusion a reload's
  // Object.assign landing mid-send emits a ReviewResult (and persists a file) stitched from two
  // snapshots — a baseDiffHash that no longer agrees with the decisions/changes beside it, or a
  // reviewer save silently overwritten by a reload built from a pre-save snapshot. This is the
  // exact window the two-actor design opens (an agent calls `galley reload` while the reviewer
  // hits Send). Read-only routes (/api/state, /api/poll, /api/file*, /api/tree) stay OUTSIDE the
  // queue, and the /api/await-send long-poll MUST stay out — it parks for the length of a round,
  // so serializing it would wedge every mutation behind a waiter that only a mutation releases.
  // A rejected fn settles the chain without poisoning it (chain swallows the error), while the
  // caller still sees the rejection and the outer handler turns it into a 500. (createSerializer
  // is unit-tested in mutex.test.ts; the ordering/non-poisoning guarantees live there.)
  const serialize = createSerializer();

  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    activeRequests++;
    res.on("close", () => {
      activeRequests--;
      lastActivity = Date.now();
    });
    try {
      // Guard every route (current and future) before dispatch: the desk answers only its own
      // loopback origin. server.address() is populated by the time requests arrive.
      const bound = server.address();
      const boundPort = typeof bound === "object" && bound ? bound.port : 0;
      if (!originAllowed(req, res, boundPort, binding.allowedHosts)) return;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(await html());
        return;
      }
      if (req.method === "GET" && url.pathname === "/ui.js") {
        const file = await uiBundlePath();
        const stat = await fs.stat(file).catch(() => null);
        const etag = stat ? `"${stat.size}-${Math.round(stat.mtimeMs)}"` : "";
        if (etag && req.headers["if-none-match"] === etag) {
          res.writeHead(304);
          res.end();
          return;
        }
        const js = await fs.readFile(file, "utf8").catch(() => "");
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          ...(etag ? { etag, "cache-control": "no-cache" } : {}),
        });
        res.end(js);
        return;
      }
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/poll") {
        // The tab's 1.5s heartbeat. Deliberately tiny and git-free: the full ReviewState
        // carries the contents of every file in the diff (>100 MB on a big monorepo PR),
        // and re-serializing it every tick pegged both the desk process and the tab.
        // Ship only what pollState diffs — hash, guide, comments, liveness; the tab
        // fetches /api/state exactly once per baseDiffHash change.
        const poll: PollPayload = {
          baseDiffHash: state.baseDiffHash,
          guide: state.guide,
          comments: state.comments,
        };
        return json(res, 200, { ...poll, ...deskStatus() });
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        await syncGitState(state);
        return json(res, 200, { ...state, ...deskStatus() });
      }
      if (req.method === "POST" && url.pathname === "/api/shutdown") {
        // `galley stop`: exit after the response flushes so the caller gets its ack.
        // The process exit handler removes the desk lock.
        res.on("finish", () => shutdown("stop"));
        return json(res, 200, { ok: true, stopping: true });
      }
      // Display preferences, stored globally in ~/.galley/settings.json — the desk's
      // random port makes browser localStorage (per-origin) useless for them.
      if (req.method === "GET" && url.pathname === "/api/settings")
        return json(res, 200, await readGlobalSettings());
      if (req.method === "POST" && url.pathname === "/api/settings") {
        await writeGlobalSettings(JSON.parse(await readBody(req)));
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/tree") {
        await syncGitState(state);
        return json(res, 200, { files: await listProjectTree(state.root) });
      }
      if (req.method === "GET" && url.pathname === "/api/file") {
        // Read an arbitrary repo file (for previewing/commenting on unchanged files).
        const rel = url.searchParams.get("path") || "";
        const resolved = await resolveContained(state.root, rel);
        if ("error" in resolved && resolved.error === "escape")
          return fail(res, 400, "BAD_PATH", "Path escapes the repo.", "Use a repo-relative path.");
        const contents =
          "abs" in resolved ? await fs.readFile(resolved.abs, "utf8").catch(() => null) : null;
        if (contents === null)
          return fail(
            res,
            404,
            "NOT_FOUND",
            `Cannot read "${rel}".`,
            "Check the path is a readable text file in the repo.",
          );
        return json(res, 200, { path: rel, contents });
      }
      if (req.method === "GET" && url.pathname === "/api/file-contents") {
        // One reviewed file's old/new contents, fetched on demand so the full contents never
        // have to ride /api/state. Same strict path boundary as /api/file (repo-relative, no
        // escapes). Resolves from git/the working tree via readFileContents — not the embedded copies.
        const rel = url.searchParams.get("path") || "";
        const resolved = await resolveContained(state.root, rel);
        // Only an ESCAPE is fatal here: a "missing" working-tree file is legitimate because the
        // old/new bytes may come from git (a deleted or index-only file has no working-tree path).
        if ("error" in resolved && resolved.error === "escape")
          return fail(res, 400, "BAD_PATH", "Path escapes the repo.", "Use a repo-relative path.");
        const file = state.files.find((f) => f.path === rel);
        if (!file)
          return fail(
            res,
            404,
            "NOT_FOUND",
            `"${rel}" is not part of this review.`,
            "Reload the desk (GET /api/state) if the diff changed.",
          );
        try {
          const { oldContents, newContents } = await readFileContents(state, file);
          // newOid is the file-level staleness key (the new-side blob OID); oldOid is hashed locally
          // from the resolved old side. Carried for a future client cache — the tab ignores them now.
          return json(res, 200, {
            path: rel,
            oldContents,
            newContents,
            oldOid: blobOid(oldContents),
            newOid: file.contentHash || blobOid(newContents),
          });
        } catch (error) {
          // A git object that can't be read (e.g. rewritten/dropped by a rebase mid-session).
          return fail(
            res,
            404,
            "NOT_FOUND",
            `Could not read contents for "${rel}": ${error instanceof Error ? error.message : String(error)}`,
            "The desk may be stale after a rebase — reload it (GET /api/state).",
          );
        }
      }
      if (req.method === "POST" && url.pathname === "/api/open-editor") {
        const body = JSON.parse(await readBody(req)) as { path?: string; lineNumber?: number };
        const rel = body.path ?? "";
        const abs = repoPath(state.root, rel);
        if (!rel || !abs)
          return fail(res, 400, "BAD_PATH", "Path escapes the repo.", "Use a repo-relative path.");
        // The editor command is a reviewer/machine preference, so it lives in the global
        // ~/.galley/settings.json with the rest of them (deliberately not per-repo).
        const prefs = (await readGlobalSettings()) as { settings?: { editorCommand?: unknown } };
        let cmd;
        try {
          cmd = resolveEditorCommand(String(prefs.settings?.editorCommand ?? ""), {
            repo: path.resolve(state.root),
            file: abs,
            line: body.lineNumber,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = message.includes("not allowed")
            ? "EDITOR_NOT_ALLOWED"
            : "BAD_EDITOR_COMMAND";
          return fail(res, 422, code, message, "Update the editor command in Settings.");
        }
        try {
          if (options.runEditorCommand) await options.runEditorCommand(cmd.command, cmd.args);
          else await execFileAsync(cmd.command, cmd.args, { timeout: 5000 });
        } catch (error) {
          return fail(
            res,
            500,
            "EDITOR_FAILED",
            error instanceof Error ? error.message : String(error),
            "Check the editor command in Settings and try again.",
          );
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/save") {
        // Merge only the reviewer-owned slice; the diff, file contents, changes, and desk
        // metadata stay authoritative here. Pick from whatever body arrives so a stale open
        // tab still posting the old full-state body keeps working (extra fields ignored).
        return await serialize(async () => {
          mergeReviewerSave(state, JSON.parse(await readBody(req)));
          const file = await persistReview(state);
          return json(res, 200, { ok: true, file });
        });
      }
      if (req.method === "POST" && url.pathname === "/api/send") {
        return await serialize(async () => {
          const body = JSON.parse(await readBody(req));
          // overallNote is an ephemeral, per-Send instruction threaded straight into the result —
          // mergeReviewerSave never copies it onto `state`, so it is never persisted.
          const overallNote = typeof body.overallNote === "string" ? body.overallNote.trim() : "";
          // Merge only the reviewer-owned slice (same contract as /api/save): the UI posts
          // { ...reviewerSlice, overallNote }, and a stale open tab still posting the old
          // full ReviewState keeps working because everything else in the body is ignored.
          mergeReviewerSave(state, body);
          await syncGitState(state);
          const file = await persistReview(state);
          const sessionDir = path.dirname(file);
          const resultJson = path.join(sessionDir, `${state.id}-result.json`);
          const payload = buildReviewResult(state, { resultJson, sessionDir }, overallNote);
          await fs.writeFile(resultJson, JSON.stringify(payload, null, 2) + "\n", "utf8");
          res.on("finish", () => {
            // Drop any still-queued questions: the review supersedes them (their unanswered ones
            // ride out in result.openQuestions), so stale question events never dribble in after
            // the round lands. This is also the invariant the await-send batch drain relies on.
            for (let i = eventQueue.length - 1; i >= 0; i--)
              if (eventQueue[i].kind === "question") eventQueue.splice(i, 1);
            emitEvent({ kind: "review", result: payload });
          });
          return json(res, 200, { ok: true, sent: true, resultJson });
        });
      }
      if (req.method === "POST" && url.pathname === "/api/ask") {
        // Reviewer clicked Ask: push a question to the agent now (out of band from Send).
        const b = JSON.parse(await readBody(req)) as {
          path?: string;
          lineNumber?: number;
          side?: string;
          body?: string;
        };
        const text = (b.body ?? "").trim();
        if (!b.path || !text)
          return fail(
            res,
            422,
            "INVALID_QUESTION",
            "ask requires path and body",
            "Send { path, lineNumber, side, body } as JSON.",
          );
        // Bake the singular into a one-element `questions` here so a question handed straight
        // to a parked waiter already carries the array — batching only has to merge on drain.
        const question = questionPayload(state, {
          path: b.path,
          lineNumber: Number(b.lineNumber ?? 1),
          side: b.side === "deletions" ? "deletions" : "additions",
          body: text,
        });
        emitEvent({ kind: "question", question, questions: [question] });
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/await-send") {
        // Long-poll the tagged event stream: resolves with the next queued event
        // ({kind:"question"|"review"}). Lets the agent learn of questions and Sends
        // without the desk process exiting.
        // When the head is a question, drain ALL queued questions into one event (the reviewer
        // can fire several before the agent returns) — singular `question` is the oldest,
        // `questions` holds them in arrival order. Safe because a Send flushes every queued
        // question before enqueuing its review (see /api/send), so a review can never sit
        // between two queued questions; draining all questions can't skip past a review.
        if (eventQueue[0]?.kind === "question") {
          const batched: QuestionPayload[] = [];
          for (let i = eventQueue.length - 1; i >= 0; i--) {
            const ev = eventQueue[i];
            if (ev.kind === "question") {
              batched.unshift(...ev.questions);
              eventQueue.splice(i, 1);
            }
          }
          return json(res, 200, { kind: "question", question: batched[0], questions: batched });
        }
        const queued = eventQueue.shift();
        if (queued) return json(res, 200, queued);
        let settled = false;
        const waiter = (ev: AwaitEvent) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          json(res, 200, ev);
        };
        const drop = () => {
          const i = eventWaiters.indexOf(waiter);
          if (i >= 0) eventWaiters.splice(i, 1);
        };
        // Bounded long-poll for harnesses that pass --timeout; otherwise hold for an hour.
        const timeoutSec = Number(url.searchParams.get("timeout"));
        const holdMs =
          Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 60 * 60 * 1000;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          drop();
          res.writeHead(204);
          res.end();
        }, holdMs);
        req.on("close", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            drop();
          }
        });
        eventWaiters.push(waiter);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/reload") {
        // Re-diff and fold it into the live state so the open desk reflects the
        // agent's edits without a restart. Rebuilds using the stored mode params.
        // An optional { guide } in the body swaps the attached guide in the same
        // round-trip — the multi-round path: regenerate the guide, reload, same tab.
        return await serialize(async () => {
          let newGuide: unknown;
          try {
            const raw = await readBody(req);
            newGuide = raw ? (JSON.parse(raw) as { guide?: unknown }).guide : undefined;
          } catch {
            newGuide = undefined; // tolerate empty/non-JSON bodies (legacy callers)
          }
          let validatedGuide;
          if (newGuide !== undefined) {
            const result = validateGuide(newGuide);
            if (!result.ok)
              return fail(
                res,
                422,
                "INVALID_GUIDE",
                `Invalid guide: ${result.reason}.`,
                "Run `galley spec` for the guided-review schema.",
              );
            validatedGuide = result.guide;
          }
          const base = await buildReviewState(state.root, {
            mode: state.mode,
            session: state.session,
            staged: state.staged,
            path: state.mode === "file" ? state.target : undefined,
            target: state.mode === "pr" ? state.target : undefined,
            base: state.mode === "pr" ? state.base : undefined,
          });
          if (!base) {
            state.files = [];
            state.changes = [];
            state.rawDiff = "";
            state.baseDiffHash = hash("");
            await persistReview(state);
            return json(res, 200, { ok: true, empty: true, baseDiffHash: state.baseDiffHash });
          }
          // Guide-declared moves (movedFrom) must merge into `base` BEFORE reconciliation, so a
          // merged pair's distinct paths drive mergeReviewState's rename migration (issue 01). A new
          // guide is strict (reject the reload naming the entry, desk untouched — nothing committed
          // yet); a carried-forward guide is lenient (an unresolvable move drops to delete+add).
          const moveGuide = validatedGuide ?? state.guide;
          if (moveGuide) {
            const moved = resolveMovedFrom(base, moveGuide, { strict: !!validatedGuide });
            if (!moved.ok)
              return fail(
                res,
                422,
                "INVALID_GUIDE",
                `Invalid guide: ${moved.reason}.`,
                "Run `galley spec` for the guided-review schema.",
              );
          }
          // The merge carries the old guide forward; a provided guide replaces it, stamped
          // against the just-rebuilt diff so it isn't born stale. Resolve skim spans + reject a
          // bad NEW guide (strict) BEFORE committing the merge onto the live state, so a rejected
          // reload leaves the desk untouched. A guide carried forward re-resolves leniently —
          // stale spans drop, they never fail a reload (see resolveSkim's strict/lenient split).
          const merged = await mergeReviewState(base, state);
          // merged.rawDiff shares identity with base.rawDiff, so the parse seeded on `base` (via
          // buildReviewState) is the one resolveSkim needs — pass it so the reload parses once (06).
          const parsed = parsedDiffOf(base);
          if (validatedGuide) {
            merged.guide = { ...validatedGuide, baseDiffHash: merged.baseDiffHash };
            const skim = resolveSkim(
              merged.rawDiff,
              merged.changes,
              merged.guide,
              { strict: true },
              parsed,
            );
            if (!skim.ok)
              return fail(
                res,
                422,
                "INVALID_GUIDE",
                `Invalid guide: ${skim.reason}.`,
                "Run `galley spec` for the guided-review schema.",
              );
          } else if (merged.guide) {
            resolveSkim(merged.rawDiff, merged.changes, merged.guide, { strict: false }, parsed);
          }
          Object.assign(state, merged);
          await syncGitState(state);
          await persistReview(state);
          return json(res, 200, { ok: true, empty: false, baseDiffHash: state.baseDiffHash });
        });
      }
      if (req.method === "POST" && url.pathname === "/api/comment") {
        return await serialize(async () => {
          const body = JSON.parse(await readBody(req)) as {
            path?: string;
            side?: string;
            lineNumber?: number;
            body?: string;
            role?: string;
          };
          const text = (body.body ?? "").trim();
          if (!body.path || !text)
            return fail(
              res,
              422,
              "INVALID_COMMENT",
              "comment requires path and body",
              "Send { path, lineNumber, side, body } as JSON.",
            );
          const now = nowIso();
          const side = body.side === "deletions" ? ("deletions" as const) : ("additions" as const);
          const lineNumber = Number(body.lineNumber ?? 1);
          // Fetch just this file's contents (the state embeds none) to capture the anchor line — works
          // for a file the tab never opened, since the resolver reads git/the working tree directly.
          const file = state.files.find((f) => f.path === body.path);
          const contents = file
            ? await readFileContents(state, file).catch(() => undefined)
            : undefined;
          const comment = {
            id: crypto.randomUUID(),
            path: body.path,
            side,
            lineNumber,
            body: text,
            createdAt: now,
            updatedAt: now,
            status: "open" as const,
            intent: "note" as const,
            role: body.role === "user" ? ("user" as const) : ("agent" as const),
            anchorText: anchorTextFor(contents, side, lineNumber),
          };
          state.comments.push(comment);
          // The reply the reviewer was waiting on has landed — the "what I'm doing
          // now" line is obsolete the moment a real agent message exists.
          if (comment.role === "agent") agentActivity = null;
          await persistReview(state);
          return json(res, 200, { ok: true, commentId: comment.id });
        });
      }
      if (req.method === "POST" && url.pathname === "/api/status") {
        // Ephemeral agent activity (`galley status`): a one-line "what I'm doing
        // now" while the agent works on a question or review. Never persisted.
        const body = JSON.parse(await readBody(req)) as { body?: string };
        const text = (body.body ?? "").trim().slice(0, 200);
        if (!text)
          return fail(
            res,
            422,
            "INVALID_STATUS",
            "status requires a non-empty body",
            'Send { body: "what you are doing" } as JSON.',
          );
        agentActivity = { body: text, at: nowIso() };
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        return await serialize(async () => {
          for (const file of state.files) {
            await git(["restore", "--staged", "--", file.path], state.root).catch(async () =>
              git(["reset", "HEAD", "--", file.path], state.root),
            );
          }
          state.comments = [];
          state.reviewedFiles = [];
          state.reviewedFileHashes = {};
          state.stagedFiles = [];
          state.stagedChangeKeys = [];
          state.decisionFiles = [];
          state.decisions = [];
          state.changes = state.changes.map((change) => ({
            ...change,
            status: "pending",
            reviewedHash: undefined,
          }));
          await persistReview(state);
          return json(res, 200, { ok: true, state });
        });
      }
      if (req.method === "POST" && url.pathname === "/api/stage") {
        if (state.mode === "pr")
          return fail(
            res,
            409,
            "STAGING_DISABLED",
            "Staging is unavailable in PR review mode.",
            "PR changes are committed; accept/reject are approve/request-changes verdicts.",
          );
        // `{ path }` stages one file (back-compat); `{ paths }` stages several in one `git add`
        // — used for a working-mode move pair, where `git add`-ing both the old (deleted) and new
        // path records the rename in the index. stagedFiles records the review file's path once:
        // the caller's `path`, else the last of `paths` (approveCurrentFile sends [old, new]).
        return await serialize(async () => {
          const body = JSON.parse(await readBody(req)) as { path?: string; paths?: string[] };
          const paths = body.paths ?? (body.path ? [body.path] : []);
          if (paths.length) await git(["add", "--", ...paths], state.root);
          const recorded = body.path ?? paths.at(-1);
          if (recorded && !state.stagedFiles.includes(recorded)) state.stagedFiles.push(recorded);
          await persistReview(state);
          return json(res, 200, { ok: true });
        });
      }
      if (req.method === "POST" && url.pathname === "/api/stage-change") {
        if (state.mode === "pr")
          return fail(
            res,
            409,
            "STAGING_DISABLED",
            "Staging is unavailable in PR review mode.",
            "PR changes are committed; accept/reject are approve/request-changes verdicts.",
          );
        return await serialize(async () => {
          const { path: filePath, stableKey } = JSON.parse(await readBody(req)) as {
            path: string;
            stableKey: string;
          };
          const key = `${filePath}:${stableKey}`;
          state.stagedChangeKeys ??= [];
          if (state.stagedChangeKeys.includes(key))
            return json(res, 200, { ok: true, skipped: true });
          let result: "applied" | "skipped";
          try {
            result = await applyPatchToIndex(
              state.root,
              patchForChange(state.rawDiff, filePath, stableKey),
            );
          } catch (error) {
            return fail(
              res,
              409,
              "PATCH_CONFLICT",
              error instanceof Error ? error.message : String(error),
              "The working tree changed since the desk loaded. Reload it (GET /api/state) and retry.",
            );
          }
          state.stagedChangeKeys.push(key);
          await persistReview(state);
          return json(res, 200, { ok: true, skipped: result === "skipped" });
        });
      }
      if (req.method === "POST" && url.pathname === "/api/unstage") {
        return await serialize(async () => {
          const { path: filePath } = JSON.parse(await readBody(req)) as { path: string };
          await git(["restore", "--staged", "--", filePath], state.root).catch(async () =>
            git(["reset", "HEAD", "--", filePath], state.root),
          );
          state.stagedFiles = state.stagedFiles.filter((p) => p !== filePath);
          state.stagedChangeKeys = (state.stagedChangeKeys ?? []).filter(
            (key) => !key.startsWith(`${filePath}:`),
          );
          await persistReview(state);
          return json(res, 200, { ok: true });
        });
      }
      fail(res, 404, "NOT_FOUND", "Not found", `See ${DOCS} for the route list.`);
    } catch (error) {
      fail(
        res,
        500,
        "INTERNAL",
        error instanceof Error ? error.message : String(error),
        "Unexpected server error; retry once, then reload the desk.",
      );
    }
  });

  // Prefer the requested (stable per-session) port; if a foreign process holds it,
  // fall back to a random one rather than failing the launch.
  await new Promise<void>((resolve, reject) => {
    const preferred = options.port ?? 0;
    const onError = (error: NodeJS.ErrnoException) => {
      if (preferred !== 0 && (error.code === "EADDRINUSE" || error.code === "EACCES")) {
        console.error(`Port ${preferred} is taken — falling back to a random port.`);
        server.removeListener("error", onError);
        server.listen(0, host, resolve);
      } else reject(error);
    };
    server.once("error", onError);
    server.listen(preferred, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  server.on("close", () => {
    if (idleTimer) clearInterval(idleTimer);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://${binding.browserHost}:${port}/`;
  const lockUrl = `http://${binding.lockHost}:${port}/`;
  if (options.open !== false) await openUrl(url);
  return { server, url, lockUrl };
}
