import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "./server.js";
import { buildReviewState, hash, writeGlobalSettings } from "./state.js";
import type { ReviewState } from "./types.js";

function state(root: string): ReviewState {
  return {
    id: "id",
    session: "s",
    root,
    repoHash: "h",
    mode: "repo",
    staged: false,
    head: null,
    baseDiffHash: "base",
    createdAt: "t",
    rawDiff: "",
    files: [
      { path: "a.ts", hunks: [], contentHash: "H", changeKind: "added", added: 1, removed: 0 },
    ],
    comments: [],
    changes: [],
    reviewedFiles: [],
    stagedFiles: [],
  };
}

// Each test points HOME at a temp dir so the global ~/.galley/settings.json the
// open-editor handler reads is isolated from the developer's real one.
async function withServer(
  run: (
    handle: Awaited<ReturnType<typeof startServer>>,
    root: string,
    st: ReviewState,
  ) => Promise<void>,
  options: {
    runEditorCommand?: (command: string, args: string[]) => Promise<void>;
    statusTtlMs?: number;
    idleTimeoutMs?: number;
    onShutdown?: (reason: "idle" | "stop") => void;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "galley-server-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const st = state(root);
  const handle = await startServer({ state: st, open: false, ...options });
  try {
    await run(handle, root, st);
  } finally {
    handle.server.close();
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
}

test("open-editor rejects paths outside the repo", async () => {
  await withServer(async (handle) => {
    const res = await fetch(`${handle.url}api/open-editor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../x.ts", lineNumber: 2 }),
    });
    const body = (await res.json()) as { code?: string };
    assert.equal(res.status, 400);
    assert.equal(body.code, "BAD_PATH");
  });
});

test("open-editor rejects absolute paths", async () => {
  await withServer(async (handle, root) => {
    const res = await fetch(`${handle.url}api/open-editor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(root, "a.ts"), lineNumber: 2 }),
    });
    const body = (await res.json()) as { code?: string };
    assert.equal(res.status, 400);
    assert.equal(body.code, "BAD_PATH");
  });
});

test("open-editor rejects a non-allowlisted editor command", async () => {
  await withServer(async (handle) => {
    await writeGlobalSettings({ settings: { editorCommand: "node {file}" } });
    const res = await fetch(`${handle.url}api/open-editor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "a.ts", lineNumber: 2 }),
    });
    const body = (await res.json()) as { code?: string };
    assert.equal(res.status, 422);
    assert.equal(body.code, "EDITOR_NOT_ALLOWED");
  });
});

test("open-editor runs the editor command from global settings", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  await withServer(
    async (handle, root) => {
      await writeFile(path.join(root, "a.ts"), "hello\n", "utf8");
      await writeGlobalSettings({ settings: { editorCommand: "code -g {file}:{line}" } });
      const body = await fetch(`${handle.url}api/open-editor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "a.ts", lineNumber: 9 }),
      }).then((r) => r.json() as Promise<{ ok: boolean }>);
      assert.equal(body.ok, true);
      assert.equal(calls[0]!.command, "code");
      assert.deepEqual(calls[0]!.args, ["-g", `${path.join(root, "a.ts")}:9`]);
    },
    {
      runEditorCommand: async (command, args) => {
        calls.push({ command, args });
      },
    },
  );
});

type StatePayload = ReviewState & {
  agentActivity: { body: string; at: string } | null;
  agentListening: boolean;
  queuedQuestions: number;
  queuedReviews: number;
};

const getState = (url: string) =>
  fetch(`${url}api/state`).then((r) => r.json() as Promise<StatePayload>);

const post = (url: string, pathname: string, body: unknown) =>
  fetch(`${url}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("status posts ephemeral agent activity into the state payload", async () => {
  await withServer(async (handle) => {
    const res = await post(handle.url, "api/status", { body: "Reading a.ts…" });
    assert.equal(res.status, 200);
    const st = await getState(handle.url);
    assert.equal(st.agentActivity?.body, "Reading a.ts…");
    assert.equal(st.agentListening, false);
    assert.equal(st.queuedQuestions, 0);
    assert.equal(st.queuedReviews, 0);
  });
});

test("status rejects an empty body", async () => {
  await withServer(async (handle) => {
    const res = await post(handle.url, "api/status", { body: "  " });
    const body = (await res.json()) as { code?: string };
    assert.equal(res.status, 422);
    assert.equal(body.code, "INVALID_STATUS");
  });
});

test("an agent comment clears the activity line", async () => {
  await withServer(async (handle) => {
    await post(handle.url, "api/status", { body: "Running tests…" });
    await post(handle.url, "api/comment", { path: "a.ts", lineNumber: 1, body: "Done — answer." });
    const st = await getState(handle.url);
    assert.equal(st.agentActivity, null);
  });
});

test("activity goes stale past the TTL (checked on read, no timers)", async () => {
  await withServer(
    async (handle) => {
      await post(handle.url, "api/status", { body: "Reading…" });
      const st = await getState(handle.url);
      assert.equal(st.agentActivity, null);
    },
    { statusTtlMs: 0 },
  );
});

test("/api/poll ships the lite slice plus desk status — never the heavy state", async () => {
  await withServer(async (handle, _root, st) => {
    st.rawDiff = "HEAVY DIFF THAT MUST NOT RIDE THE POLL";
    await post(handle.url, "api/status", { body: "Working…" });
    await post(handle.url, "api/comment", { path: "a.ts", lineNumber: 1, body: "a reply" });
    const poll = (await fetch(`${handle.url}api/poll`).then((r) => r.json())) as Record<
      string,
      unknown
    >;
    // Everything pollState diffs per tick…
    assert.equal(poll.baseDiffHash, st.baseDiffHash);
    assert.equal((poll.comments as unknown[]).length, 1);
    assert.equal(typeof poll.agentListening, "boolean");
    assert.equal(poll.queuedQuestions, 0);
    // …and none of the payload that made polling the full state melt big desks.
    assert.ok(!("rawDiff" in poll), "rawDiff must not ride the poll");
    assert.ok(!("files" in poll), "file contents must not ride the poll");
    assert.ok(!("changes" in poll), "changes must not ride the poll");
  });
});

test("an unconsumed question surfaces as queuedQuestions", async () => {
  await withServer(async (handle) => {
    await post(handle.url, "api/ask", { path: "a.ts", lineNumber: 1, body: "why?" });
    const st = await getState(handle.url);
    assert.equal(st.queuedQuestions, 1);
    assert.equal(st.agentListening, false);
  });
});

test("multiple questions asked before an await batch into one event, oldest first", async () => {
  await withServer(async (handle) => {
    await post(handle.url, "api/ask", { path: "a.ts", lineNumber: 1, body: "first?" });
    await post(handle.url, "api/ask", { path: "a.ts", lineNumber: 2, body: "second?" });
    const ev = (await fetch(`${handle.url}api/await-send`).then((r) => r.json())) as {
      kind: string;
      question: { body: string };
      questions: { body: string }[];
    };
    assert.equal(ev.kind, "question");
    assert.equal(ev.questions.length, 2);
    assert.deepEqual(
      ev.questions.map((q) => q.body),
      ["first?", "second?"],
    );
    assert.deepEqual(ev.question, ev.questions[0]); // singular is the oldest
    // Both drained — nothing left queued for the UI's waiting indicator.
    const st = await getState(handle.url);
    assert.equal(st.queuedQuestions, 0);
  });
});

test("Send flushes queued questions and folds the unanswered ones into openQuestions", async () => {
  await withServer(async (handle, _root, st) => {
    // Two open question comments the reviewer left (the source for openQuestions), plus the
    // matching live question events (the source for the queue) — two independent representations.
    st.comments.push(
      {
        id: "q1",
        path: "a.ts",
        side: "additions",
        lineNumber: 1,
        body: "why q1?",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        status: "open",
        intent: "question",
        role: "user",
      },
      {
        id: "q2",
        path: "a.ts",
        side: "additions",
        lineNumber: 2,
        body: "why q2?",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        status: "open",
        intent: "question",
        role: "user",
      },
    );
    await post(handle.url, "api/ask", { path: "a.ts", lineNumber: 1, body: "why q1?" });
    await post(handle.url, "api/ask", { path: "a.ts", lineNumber: 2, body: "why q2?" });

    const sent = (await post(handle.url, "api/send", await getState(handle.url)).then((r) =>
      r.json(),
    )) as { sent?: boolean };
    assert.equal(sent.sent, true);

    // The review is emitted on the send response's 'finish'; poll until it lands. The queued
    // questions are flushed in the same step, so queuedQuestions must be 0 by then.
    let status = await getState(handle.url);
    for (let i = 0; i < 100 && status.queuedReviews === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = await getState(handle.url);
    }
    assert.equal(status.queuedReviews, 1);
    assert.equal(status.queuedQuestions, 0); // superseded questions flushed

    // Next await is the review (not a stale question), carrying both unanswered questions.
    const ev = (await fetch(`${handle.url}api/await-send`).then((r) => r.json())) as {
      kind: string;
      result: { openQuestions: { body: string }[] };
    };
    assert.equal(ev.kind, "review");
    assert.deepEqual(ev.result.openQuestions.map((q) => q.body).sort(), ["why q1?", "why q2?"]);

    // Nothing dribbles in after the round: a bounded await times out (204).
    const after = await fetch(`${handle.url}api/await-send?timeout=1`);
    assert.equal(after.status, 204);
  });
});

test("send survives bodies beyond the old 5 MB cap and merges only the reviewer slice", async () => {
  await withServer(async (handle, _root, st) => {
    // Regression: pre-0.6.2 tabs post the entire ReviewState on Send, and a big PR desk
    // crosses 5 MB — readBody threw before the result was built, so no artifact and no
    // event ("Could not send review") while the slice-only auto-saves kept succeeding.
    const body = {
      ...(await getState(handle.url)),
      rawDiff: "x".repeat(6_000_000), // push the body well past the old cap
      reviewedFiles: ["a.ts"],
      overallNote: "ship it",
    };
    const sent = (await post(handle.url, "api/send", body).then((r) => r.json())) as {
      sent?: boolean;
      resultJson?: string;
    };
    assert.equal(sent.sent, true);
    // Only the reviewer-owned slice merges; server-authoritative fields stay untouched.
    assert.deepEqual(st.reviewedFiles, ["a.ts"]);
    assert.equal(st.rawDiff, "");
    // overallNote rides into the result but never onto the persisted state.
    const result = JSON.parse(await readFile(sent.resultJson!, "utf8")) as {
      overallNote?: string;
    };
    assert.equal(result.overallNote, "ship it");
    assert.equal("overallNote" in st, false);
  });
});

test("save strips transient desk-status keys so they never persist on state", async () => {
  await withServer(async (handle, _root, st) => {
    const payload = await getState(handle.url);
    // The UI posts its copy of the /api/state payload back — transient keys ride along.
    await post(handle.url, "api/save", {
      ...payload,
      agentActivity: { body: "leak", at: "t" },
      queuedQuestions: 9,
    });
    assert.equal("agentActivity" in st, false);
    assert.equal("agentListening" in st, false);
    assert.equal("queuedQuestions" in st, false);
    assert.equal("queuedReviews" in st, false);
  });
});

test("save merges the reviewer-owned slice and leaves server-owned state authoritative", async () => {
  await withServer(async (handle, _root, st) => {
    st.rawDiff = "SERVER DIFF";
    // The real slim wire: only reviewer-owned fields, no rawDiff and no file contents.
    const res = await post(handle.url, "api/save", {
      decisions: [
        {
          key: "a.ts:k1",
          status: "accepted",
          path: "a.ts",
          lineNumber: 1,
          side: "additions",
          title: "t",
        },
      ],
      comments: [],
      reviewedFiles: ["a.ts"],
      reviewedFileHashes: { "a.ts": "H" },
      decisionFiles: ["a.ts"],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(st.reviewedFiles, ["a.ts"]);
    assert.deepEqual(st.decisionFiles, ["a.ts"]);
    assert.equal(st.decisions?.[0]?.status, "accepted");
    // Server-owned fields are untouched — the wire never carried them.
    assert.equal(st.rawDiff, "SERVER DIFF");
    assert.equal(st.files.length, 1);
    assert.equal(st.files[0]?.contentHash, "H");
  });
});

test("save from a stale full-state tab ignores server-owned fields in the body", async () => {
  await withServer(async (handle, _root, st) => {
    const before = st.files[0]!.contentHash;
    // A stale tab POSTs the whole old ReviewState (old shape, contents and all) — the server must
    // pick only the reviewer slice and leave its own files untouched.
    await post(handle.url, "api/save", {
      reviewedFiles: ["a.ts"],
      rawDiff: "CLIENT DIFF SHOULD BE IGNORED",
      baseDiffHash: "client-hash",
      files: [
        {
          path: "evil.ts",
          hunks: [],
          oldFile: { contents: "" },
          newFile: { contents: "x" },
          contentHash: "E",
        },
      ],
      id: "spoofed",
    });
    assert.deepEqual(st.reviewedFiles, ["a.ts"]);
    assert.equal(st.rawDiff, "");
    assert.equal(st.baseDiffHash, "base");
    assert.equal(st.id, "id");
    assert.equal(st.files.length, 1);
    assert.equal(st.files[0]?.contentHash, before);
  });
});

test("/api/stage: paths[] stages a move pair as a rename; legacy {path} still works (issue 02)", async () => {
  await withServer(async (handle, root, st) => {
    const g = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.co"]);
    g(["config", "user.name", "tester"]);
    await writeFile(path.join(root, "old.ts"), "x\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
    // Plain mv: old.ts deleted in the worktree (still in HEAD), new.ts untracked. Plus an
    // unrelated untracked file to exercise the legacy single-path body.
    await rm(path.join(root, "old.ts"));
    await writeFile(path.join(root, "new.ts"), "x\n");
    await writeFile(path.join(root, "extra.ts"), "y\n");
    const post = (body: unknown) =>
      fetch(`${handle.url}api/stage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ path: "extra.ts" })).status, 200); // legacy single-path
    assert.equal((await post({ paths: ["old.ts", "new.ts"] })).status, 200); // move pair
    const porcelain = g(["status", "--porcelain"]);
    assert.match(porcelain, /R\s+old\.ts -> new\.ts/); // a staged rename, not add + delete
    assert.match(porcelain, /A\s+extra\.ts/);
    // stagedFiles records the review path once: the new path for the pair, plus the legacy file.
    assert.ok(st.stagedFiles.includes("new.ts"));
    assert.ok(st.stagedFiles.includes("extra.ts"));
    assert.ok(!st.stagedFiles.includes("old.ts"));
  });
});

test("/api/reload: a guide-declared move merges into a rename entry; a bad one is 422, desk untouched (issue 03)", async () => {
  await withServer(async (handle, root, st) => {
    const g = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.co"]);
    g(["config", "user.name", "tester"]);
    await writeFile(path.join(root, "a.ts"), "l1\nl2\nl3\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
    // Plain mv + edit: a.ts deleted in the worktree, b.ts untracked with one changed line.
    await rm(path.join(root, "a.ts"));
    await writeFile(path.join(root, "b.ts"), "l1\nCHANGED\nl3\n");
    const reload = (guide: unknown) =>
      fetch(`${handle.url}api/reload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guide }),
      });
    // Declared move resolves → one rename-changed entry at b.ts, a.ts gone.
    const ok = await reload({
      overview: "o",
      files: [{ path: "b.ts", orientation: "moved and edited", movedFrom: "a.ts" }],
    });
    assert.equal(ok.status, 200);
    assert.ok(st.files.some((f) => f.path === "b.ts" && f.oldPath === "a.ts"));
    assert.ok(!st.files.some((f) => f.path === "a.ts"));
    // A movedFrom naming a file that isn't a deletion → 422, and the live desk is left as it was.
    const before = st.files.map((f) => f.path).sort();
    const bad = await reload({
      overview: "o",
      files: [{ path: "b.ts", orientation: "x", movedFrom: "ghost.ts" }],
    });
    assert.equal(bad.status, 422);
    assert.deepEqual(st.files.map((f) => f.path).sort(), before);
  });
});

test("/api/file-contents returns contents equal to the embedded copies; rejects escapes + unknown paths (issue 02)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "galley-fc-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const g = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.co"]);
  g(["config", "user.name", "tester"]);
  await writeFile(path.join(root, "a.ts"), "one\ntwo\nthree\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  // Working-tree change: a.ts modified (a real diff), plus b.ts brand-new (untracked → old = "").
  await writeFile(path.join(root, "a.ts"), "one\nCHANGED\nthree\n");
  await writeFile(path.join(root, "b.ts"), "brand new\n");
  const st = await buildReviewState(root, { session: "s" });
  assert.ok(st, "built a review state for the working diff");
  const handle = await startServer({ state: st!, open: false, idleTimeoutMs: 0 });
  try {
    // The state embeds no contents — the resolver reads git (old = committed) / the working tree
    // (new). Assert the exact bytes, plus the OIDs the payload now carries (newOid = the file key).
    const expected: Record<string, { old: string; new: string }> = {
      "a.ts": { old: "one\ntwo\nthree\n", new: "one\nCHANGED\nthree\n" },
      "b.ts": { old: "", new: "brand new\n" }, // untracked → no old side
    };
    for (const rel of ["a.ts", "b.ts"]) {
      const file = st!.files.find((f) => f.path === rel)!;
      const r = (await fetch(`${handle.url}api/file-contents?path=${rel}`).then((res) =>
        res.json(),
      )) as {
        path: string;
        oldContents: string;
        newContents: string;
        oldOid: string;
        newOid: string;
      };
      assert.equal(r.oldContents, expected[rel]!.old, `${rel} old side resolves from git`);
      assert.equal(
        r.newContents,
        expected[rel]!.new,
        `${rel} new side resolves from the working tree`,
      );
      assert.equal(r.newOid, file.contentHash, `${rel} newOid is the file-level key`);
      assert.match(r.oldOid, /^[0-9a-f]{40}$/, `${rel} oldOid is a blob OID`);
    }
    // Path escape → 400 BAD_PATH (same boundary as /api/file).
    const escape = await fetch(
      `${handle.url}api/file-contents?path=${encodeURIComponent("../x.ts")}`,
    );
    assert.equal(escape.status, 400);
    assert.equal(((await escape.json()) as { code?: string }).code, "BAD_PATH");
    // A path not in the review → 404 NOT_FOUND.
    const missing = await fetch(`${handle.url}api/file-contents?path=nope.ts`);
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { code?: string }).code, "NOT_FOUND");
  } finally {
    handle.server.close();
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "/api/file refuses a path that resolves outside the repo via an in-repo symlink (issue 03)",
  // symlink creation is privileged on win32; skip there.
  { skip: process.platform === "win32" },
  async () => {
    await withServer(async (handle, root) => {
      // A secret file outside the repo, plus an in-repo symlink that points at it. The
      // unresolved prefix check passes (leak.txt sits under root) but the resolved target
      // escapes — the route must realpath and refuse to follow the link.
      const outside = await mkdtemp(path.join(tmpdir(), "galley-outside-"));
      const secret = path.join(outside, "secret.txt");
      await writeFile(secret, "TOP SECRET\n");
      await symlink(secret, path.join(root, "leak.txt"));
      try {
        const leak = await fetch(`${handle.url}api/file?path=leak.txt`);
        assert.notEqual(leak.status, 200, "an escaping symlink is never served");
        assert.equal(((await leak.json()) as { code?: string }).code, "BAD_PATH");

        // A plain in-repo file is served unchanged.
        await writeFile(path.join(root, "ok.txt"), "fine\n");
        const ok = await fetch(`${handle.url}api/file?path=ok.txt`);
        assert.equal(ok.status, 200);
        assert.equal(((await ok.json()) as { contents: string }).contents, "fine\n");

        // A symlink that still resolves INSIDE the repo keeps working.
        await symlink(path.join(root, "ok.txt"), path.join(root, "alias.txt"));
        const alias = await fetch(`${handle.url}api/file?path=alias.txt`);
        assert.equal(alias.status, 200);
        assert.equal(((await alias.json()) as { contents: string }).contents, "fine\n");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  },
);

test("/api/state carries no file contents (lean wire, issue 04)", async () => {
  await withServer(async (handle) => {
    const st = (await fetch(`${handle.url}api/state`).then((r) => r.json())) as {
      files: Array<Record<string, unknown>>;
    };
    assert.ok(st.files.length >= 1);
    for (const f of st.files) {
      assert.equal("oldFile" in f, false);
      assert.equal("newFile" in f, false);
    }
    assert.equal(JSON.stringify(st.files).includes('"contents"'), false);
  });
});

test("POST /api/comment anchors a file the tab never opened (issue 04)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "galley-anchor-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const g = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.co"]);
  g(["config", "user.name", "tester"]);
  await writeFile(path.join(root, "a.ts"), "one\ntwo\nthree\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  await writeFile(path.join(root, "a.ts"), "one\nCHANGED\nthree\n");
  const st = await buildReviewState(root, { session: "s" });
  assert.ok(st);
  const handle = await startServer({ state: st!, open: false, idleTimeoutMs: 0 });
  try {
    // Anchoring fetches the file's contents on demand (the state embeds none), so it works even
    // though no tab ever opened a.ts. New-side line 2 is "CHANGED".
    const res = await fetch(`${handle.url}api/comment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "a.ts",
        side: "additions",
        lineNumber: 2,
        body: "why?",
        role: "user",
      }),
    });
    assert.equal(res.status, 200);
    const state = (await fetch(`${handle.url}api/state`).then((r) => r.json())) as {
      comments: Array<{ path: string; anchorText?: string }>;
    };
    const c = state.comments.find((x) => x.path === "a.ts");
    assert.ok(c, "comment persisted");
    assert.equal(c!.anchorText, "CHANGED");
  } finally {
    handle.server.close();
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("POST /api/shutdown acks then triggers shutdown with reason stop", async () => {
  const reasons: string[] = [];
  await withServer(
    async (handle) => {
      const res = await fetch(`${handle.url}api/shutdown`, { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; stopping?: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.stopping, true);
      // Shutdown fires on response finish — give the event loop a beat.
      await sleep(20);
      assert.deepEqual(reasons, ["stop"]);
    },
    { idleTimeoutMs: 0, onShutdown: (reason) => reasons.push(reason) },
  );
});

test("idle timeout shuts the desk down when nothing is connected", async () => {
  const reasons: string[] = [];
  await withServer(
    async () => {
      await sleep(200);
      assert.deepEqual(reasons, ["idle"]);
    },
    { idleTimeoutMs: 50, onShutdown: (reason) => reasons.push(reason) },
  );
});

test("an in-flight await-send long-poll pins the desk past the idle timeout", async () => {
  const reasons: string[] = [];
  await withServer(
    async (handle) => {
      // Holds the connection open well past idleTimeoutMs; activeRequests > 0 must
      // block the idle exit for as long as an agent is parked on await.
      const poll = fetch(`${handle.url}api/await-send?timeout=1`);
      await sleep(200);
      assert.deepEqual(reasons, [], "no idle shutdown while a long-poll is held");
      const res = await poll;
      assert.equal(res.status, 204); // bounded hold expired with no event
    },
    { idleTimeoutMs: 50, onShutdown: (reason) => reasons.push(reason) },
  );
});

// fetch (undici) silently drops the forbidden Host/Origin request headers, so the origin guard
// can only be exercised with a raw http.request that lets us set them verbatim.
function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const u = new URL(url);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: opts.method ?? "GET",
          headers: opts.headers,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
          );
        },
      );
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    },
  );
}

test("origin guard rejects a foreign Host before any route runs", async () => {
  await withServer(async (handle) => {
    const res = await rawRequest(`${handle.url}api/state`, { headers: { host: "evil.example" } });
    assert.equal(res.status, 403);
    assert.equal((JSON.parse(res.body) as { code?: string }).code, "FORBIDDEN_HOST");
  });
});

test("origin guard rejects a cross-site Origin on a mutating POST", async () => {
  await withServer(async (handle) => {
    const res = await rawRequest(`${handle.url}api/status`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ body: "Reading…" }),
    });
    assert.equal(res.status, 403);
    assert.equal((JSON.parse(res.body) as { code?: string }).code, "FORBIDDEN_ORIGIN");
  });
});

test("origin guard accepts a same-origin POST and a POST with no Origin", async () => {
  await withServer(async (handle) => {
    // Same-origin: the desk's own http://127.0.0.1:<port> Origin passes.
    const sameOrigin = await rawRequest(`${handle.url}api/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(handle.url).origin,
      },
      body: JSON.stringify({ body: "Reading…" }),
    });
    assert.equal(sameOrigin.status, 200);
    // No Origin at all (curl / the CLI agent subcommands) is allowed — and no wildcard CORS leaks.
    const noOrigin = await rawRequest(`${handle.url}api/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Working…" }),
    });
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers["access-control-allow-origin"], undefined);
  });
});

test("concurrent /api/reload and /api/save leave the desk internally consistent (issue 05)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "galley-mutex-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const g = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.co"]);
  g(["config", "user.name", "tester"]);
  await writeFile(path.join(root, "a.ts"), "one\ntwo\nthree\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  // A real working-tree diff so /api/reload does its full (git-bound) rebuild each round.
  await writeFile(path.join(root, "a.ts"), "one\nCHANGED\nthree\n");
  const st = await buildReviewState(root, { session: "s" });
  assert.ok(st, "built a review state for the working diff");
  const handle = await startServer({ state: st!, open: false, idleTimeoutMs: 0 });
  try {
    // Fire the two mutating routes concurrently, many rounds. The queue's FIFO/non-poisoning
    // contract is unit-tested in mutex.test.ts; here we assert the end-to-end invariant it exists
    // to protect — that a reload's Object.assign never lands mid-save to stitch a half-applied
    // snapshot. After every round the desk stays internally consistent: baseDiffHash is exactly
    // the hash of the rawDiff it reports, never a value carried over from a different reload's diff.
    for (let i = 0; i < 20; i++) {
      const [reloadRes, saveRes] = await Promise.all([
        post(handle.url, "api/reload", {}),
        post(handle.url, "api/save", { reviewedFiles: ["a.ts"] }),
      ]);
      assert.equal(reloadRes.status, 200, `reload ${i} ok`);
      assert.equal(saveRes.status, 200, `save ${i} ok`);
      const snap = await getState(handle.url);
      assert.equal(
        snap.baseDiffHash,
        hash(snap.rawDiff),
        `baseDiffHash matches rawDiff (round ${i})`,
      );
    }
  } finally {
    handle.server.close();
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("a throwing wrapped route settles the mutex without poisoning the chain (issue 05)", async () => {
  await withServer(async (handle, _root, st) => {
    // Invalid JSON reaches the serialized /api/save body, where JSON.parse throws — the wrapped
    // fn rejects. The chain must swallow that rejection (not wedge behind a permanently-rejected
    // promise) while the caller still sees the 500.
    const bad = await fetch(`${handle.url}api/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json",
    });
    assert.equal(bad.status, 500);
    assert.equal(((await bad.json()) as { code?: string }).code, "INTERNAL");
    // A following mutation still runs to completion — proof the queue kept flowing.
    const ok = await post(handle.url, "api/save", { reviewedFiles: ["a.ts"] });
    assert.equal(ok.status, 200);
    assert.deepEqual(st.reviewedFiles, ["a.ts"]);
  });
});

test("/api/reset unstages every reviewed file in one batched restore and clears the review (issue 13)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "galley-reset-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const g = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.co"]);
  g(["config", "user.name", "tester"]);
  await writeFile(path.join(root, "a.ts"), "one\n");
  await writeFile(path.join(root, "b.ts"), "two\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  // Change both files and stage them, so the index carries two paths for the reset to restore.
  await writeFile(path.join(root, "a.ts"), "one CHANGED\n");
  await writeFile(path.join(root, "b.ts"), "two CHANGED\n");
  const st = await buildReviewState(root, { session: "s" });
  assert.ok(st, "built a review state for the working diff");
  g(["add", "."]);
  assert.deepEqual(
    g(["diff", "--cached", "--name-only"]).trim().split("\n").sort(),
    ["a.ts", "b.ts"],
    "both files staged before reset",
  );
  st!.comments.push({
    id: "c1",
    path: "a.ts",
    side: "additions",
    lineNumber: 1,
    body: "x",
    createdAt: "t",
    updatedAt: "t",
    status: "open",
    role: "user",
  });
  st!.decisions = [
    {
      key: "a.ts:k",
      status: "accepted",
      path: "a.ts",
      lineNumber: 1,
      side: "additions",
      title: "t",
    },
  ];
  const handle = await startServer({ state: st!, open: false, idleTimeoutMs: 0 });
  try {
    const res = await fetch(`${handle.url}api/reset`, { method: "POST" });
    assert.equal(res.status, 200);
    // A single batched `git restore --staged -- a.ts b.ts` cleared the index for BOTH files.
    assert.equal(
      g(["diff", "--cached", "--name-only"]).trim(),
      "",
      "index restored for every file",
    );
    // …and the reviewer-owned slice is wiped.
    assert.deepEqual(st!.comments, []);
    assert.deepEqual(st!.decisions, []);
  } finally {
    handle.server.close();
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("/api/reset in pr mode clears the review without touching the git index (issue 13)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "galley-reset-pr-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const g = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.co"]);
  g(["config", "user.name", "tester"]);
  await writeFile(path.join(root, "a.ts"), "one\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  // A staged change sitting in the index — if reset spawned git in pr mode, it would vanish.
  await writeFile(path.join(root, "a.ts"), "one CHANGED\n");
  g(["add", "."]);
  const st: ReviewState = {
    ...state(root),
    mode: "pr",
    comments: [
      {
        id: "c1",
        path: "a.ts",
        side: "additions",
        lineNumber: 1,
        body: "x",
        createdAt: "t",
        updatedAt: "t",
        status: "open",
        role: "user",
      },
    ],
  };
  const handle = await startServer({ state: st, open: false, idleTimeoutMs: 0 });
  try {
    const res = await fetch(`${handle.url}api/reset`, { method: "POST" });
    assert.equal(res.status, 200);
    // PR mode has no working-tree index to restore — the staged change is left exactly as it was
    // (staging is disabled in pr mode), proving the route never spawned git here.
    assert.equal(
      g(["diff", "--cached", "--name-only"]).trim(),
      "a.ts",
      "index untouched in pr mode",
    );
    // The reviewer-owned slice is still cleared, git or no git.
    assert.deepEqual(st.comments, []);
  } finally {
    handle.server.close();
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("settings API round-trips editorCommand", async () => {
  await withServer(async (handle) => {
    await fetch(`${handle.url}api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { editorCommand: "cursor -g {file}:{line}" } }),
    });
    const loaded = await fetch(`${handle.url}api/settings`).then(
      (r) => r.json() as Promise<{ settings?: { editorCommand?: string } }>,
    );
    assert.equal(loaded.settings?.editorCommand, "cursor -g {file}:{line}");
  });
});

test("stable-port EADDRINUSE falls back to a different port instead of throwing", async () => {
  // A restarted desk's stablePort (deterministic per repo+session) can still be held by another
  // process — startServer must rebind elsewhere rather than crash the launch.
  const root = await mkdtemp(path.join(tmpdir(), "galley-portfallback-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const occupied = http.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  const takenPort = typeof address === "object" && address ? address.port : 0;
  try {
    const handle = await startServer({
      state: state(root),
      open: false,
      idleTimeoutMs: 0,
      port: takenPort,
    });
    try {
      const boundPort = Number(new URL(handle.url).port);
      assert.notEqual(boundPort, takenPort, "rebound to a different, non-zero port");
      assert.ok(boundPort > 0);
      const res = await fetch(`${handle.url}api/state`);
      assert.equal(res.status, 200, "the fallback server actually answers");
    } finally {
      handle.server.close();
    }
  } finally {
    occupied.close();
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});
