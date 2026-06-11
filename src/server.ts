import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git, listProjectTree, patchForChange } from "./git.js";
import {
  anchorTextFor,
  buildReviewResult,
  buildReviewState,
  buildReviewSummary,
  hash,
  mergeReviewState,
  nowIso,
  persistReview,
  readGlobalSettings,
  syncGitState,
  writeGlobalSettings,
} from "./state.js";
import type { AwaitEvent, ReviewState } from "./types.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = "skills/galley/SKILL.md";

export type ServerOptions = {
  state: ReviewState;
  port?: number;
  open?: boolean;
};

export type ServerHandle = {
  server: http.Server;
  url: string;
};

async function readBody(req: http.IncomingMessage, limit = 5_000_000) {
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
        return json(res, 200, state);
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
      if (req.method === "POST" && url.pathname === "/api/save") {
        Object.assign(state, JSON.parse(await readBody(req)));
        const file = await persistReview(state);
        return json(res, 200, { ok: true, file });
      }
      if (req.method === "POST" && url.pathname === "/api/send") {
        Object.assign(state, JSON.parse(await readBody(req)));
        await syncGitState(state);
        const file = await persistReview(state);
        const sessionDir = path.dirname(file);
        const summaryMd = path.join(sessionDir, `${state.id}-send-review.md`);
        const resultJson = path.join(sessionDir, `${state.id}-result.json`);
        await fs.writeFile(summaryMd, buildReviewSummary(state) + "\n", "utf8");
        const payload = buildReviewResult(state, { resultJson, summaryMd, sessionDir });
        await fs.writeFile(resultJson, JSON.stringify(payload, null, 2) + "\n", "utf8");
        res.on("finish", () => emitEvent({ kind: "review", result: payload }));
        return json(res, 200, { ok: true, sent: true, summaryMd, resultJson });
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
        emitEvent({
          kind: "question",
          question: {
            path: b.path,
            lineNumber: Number(b.lineNumber ?? 1),
            side: b.side === "deletions" ? "deletions" : "additions",
            body: text,
            mode: state.mode,
            session: state.session,
          },
        });
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/await-send") {
        // Long-poll the tagged event stream: resolves with the next queued event
        // ({kind:"question"|"review"}). Lets the agent learn of questions and Sends
        // without the desk process exiting.
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
        Object.assign(state, mergeReviewState(base, state));
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
        await persistReview(state);
        return json(res, 200, { ok: true, commentId: comment.id });
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
        const { path: filePath } = JSON.parse(await readBody(req)) as { path: string };
        await git(["add", "--", filePath], state.root);
        if (!state.stagedFiles.includes(filePath)) state.stagedFiles.push(filePath);
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

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}/`;
  if (options.open !== false) await openUrl(url);
  return { server, url };
}
