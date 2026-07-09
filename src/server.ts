import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveEditorCommand } from "./editor.js";
import { git, listProjectTree, patchForChange } from "./git.js";
import { validateGuide } from "./guide.js";
import {
  anchorTextFor,
  buildReviewResult,
  buildReviewState,
  hash,
  mergeReviewerSave,
  mergeReviewState,
  nowIso,
  persistReview,
  questionPayload,
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
  QuestionPayload,
  ReviewState,
} from "./types.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = "Run `galley spec` for the full agent contract.";

export type ServerOptions = {
  state: ReviewState;
  port?: number;
  open?: boolean;
  // Test seam: lets server.test.ts assert the resolved editor invocation without
  // actually launching anything.
  runEditorCommand?: (command: string, args: string[]) => Promise<void>;
  // Test seam: TTL for the ephemeral agent-activity line (default 90s).
  statusTtlMs?: number;
};

export type ServerHandle = {
  server: http.Server;
  url: string;
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
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function fail(res: http.ServerResponse, status: number, code: string, error: string, fix: string) {
  json(res, status, { error, code, fix, docs: DOCS });
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
    await fs.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "galley-")),
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

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const { state } = options;
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
  const server = http.createServer(async (req, res) => {
    try {
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
      if (req.method === "GET" && url.pathname === "/api/state") {
        await syncGitState(state);
        return json(res, 200, { ...state, ...deskStatus() });
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
        const root = path.resolve(state.root);
        const abs = path.resolve(root, rel);
        if (abs !== root && !abs.startsWith(root + path.sep))
          return fail(res, 400, "BAD_PATH", "Path escapes the repo.", "Use a repo-relative path.");
        const contents = await fs.readFile(abs, "utf8").catch(() => null);
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
        mergeReviewerSave(state, JSON.parse(await readBody(req)));
        const file = await persistReview(state);
        return json(res, 200, { ok: true, file });
      }
      if (req.method === "POST" && url.pathname === "/api/send") {
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
        const merged = mergeReviewState(base, state);
        if (validatedGuide) {
          merged.guide = { ...validatedGuide, baseDiffHash: merged.baseDiffHash };
          const skim = resolveSkim(merged.rawDiff, merged.changes, merged.guide, { strict: true });
          if (!skim.ok)
            return fail(
              res,
              422,
              "INVALID_GUIDE",
              `Invalid guide: ${skim.reason}.`,
              "Run `galley spec` for the guided-review schema.",
            );
        } else if (merged.guide) {
          resolveSkim(merged.rawDiff, merged.changes, merged.guide, { strict: false });
        }
        Object.assign(state, merged);
        await syncGitState(state);
        await persistReview(state);
        return json(res, 200, { ok: true, empty: false, baseDiffHash: state.baseDiffHash });
      }
      if (req.method === "POST" && url.pathname === "/api/comment") {
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
          anchorText: anchorTextFor(state.files, body.path, side, lineNumber),
        };
        state.comments.push(comment);
        // The reply the reviewer was waiting on has landed — the "what I'm doing
        // now" line is obsolete the moment a real agent message exists.
        if (comment.role === "agent") agentActivity = null;
        await persistReview(state);
        return json(res, 200, { ok: true, commentId: comment.id });
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
        const body = JSON.parse(await readBody(req)) as { path?: string; paths?: string[] };
        const paths = body.paths ?? (body.path ? [body.path] : []);
        if (paths.length) await git(["add", "--", ...paths], state.root);
        const recorded = body.path ?? paths.at(-1);
        if (recorded && !state.stagedFiles.includes(recorded)) state.stagedFiles.push(recorded);
        await persistReview(state);
        return json(res, 200, { ok: true });
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
      }
      if (req.method === "POST" && url.pathname === "/api/unstage") {
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
        server.listen(0, "127.0.0.1", resolve);
      } else reject(error);
    };
    server.once("error", onError);
    server.listen(preferred, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}/`;
  if (options.open !== false) await openUrl(url);
  return { server, url };
}
