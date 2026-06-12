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
import { validateGuide } from "./guide.js";
import { resolveEditorCommand } from "./editor.js";
import type { AgentActivity, AwaitEvent, DeskStatus, ReviewState } from "./types.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = "skills/galley/SKILL.md";

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
  // The UI's /api/save and /api/send post back its copy of the /api/state payload,
  // which now carries the DeskStatus fields — drop them so Object.assign never
  // copies them onto `state` (and from there into the persisted file).
  const stripDeskStatus = (body: Record<string, unknown>) => {
    for (const key of ["agentActivity", "agentListening", "queuedQuestions", "queuedReviews"])
      delete body[key];
    return body;
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
        Object.assign(state, stripDeskStatus(JSON.parse(await readBody(req))));
        const file = await persistReview(state);
        return json(res, 200, { ok: true, file });
      }
      if (req.method === "POST" && url.pathname === "/api/send") {
        Object.assign(state, stripDeskStatus(JSON.parse(await readBody(req))));
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
              "Run `galley guide-spec` for the schema.",
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
        Object.assign(state, mergeReviewState(base, state));
        // The merge carries the old guide forward; a provided guide replaces it,
        // stamped against the just-rebuilt diff so it isn't born stale.
        if (validatedGuide) state.guide = { ...validatedGuide, baseDiffHash: state.baseDiffHash };
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
