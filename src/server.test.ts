import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { resolveBinding, startServer } from "./server.js";
import { buildReviewState, hash, reviewDir, writeGlobalSettings } from "./state.js";
import type { ReviewState } from "./types.js";
import { SHOT_CAP } from "./uishots.js";

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
    host?: string;
    allowedHosts?: string[];
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

test("open-editor opens only a file that exists inside the repo, symlinks followed", async () => {
  const calls: string[][] = [];
  const outside = await mkdtemp(path.join(tmpdir(), "galley-outside-"));
  try {
    await withServer(
      async (handle, root) => {
        await writeFile(path.join(outside, "secret.ts"), "x\n", "utf8");
        await symlink(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
        await mkdir(path.join(root, "src"));
        // A UI annotation's source names whatever the app page said: here, a file that isn't there.
        for (const [rel, status] of [
          ["src/x&calc.vue", 404],
          ["link.ts", 400],
          ["src", 404],
        ] as const) {
          const res = await fetch(`${handle.url}api/open-editor`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: rel, lineNumber: 1 }),
          });
          assert.equal(res.status, status, rel);
        }
        assert.deepEqual(calls, [], "the editor never ran");
      },
      { runEditorCommand: async (command, args) => void calls.push([command, ...args]) },
    );
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("open-editor rejects a non-allowlisted editor command", async () => {
  await withServer(async (handle, root) => {
    await writeFile(path.join(root, "a.ts"), "hello\n", "utf8");
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
      // The file as resolved, symlinks followed (macOS's tmpdir is under one).
      assert.deepEqual(calls[0]!.args, ["-g", `${await realpath(path.join(root, "a.ts"))}:9`]);
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

test("UI annotations ride the save slice into the poll and the Send result; reset clears them", async () => {
  await withServer(async (handle, _root, st) => {
    // A UI-only desk: an app and no diff.
    st.files = [];
    st.ui = { target: "http://localhost:3000/" };
    const annotation = {
      id: "a1",
      number: 1,
      intent: "change",
      status: "open",
      placement: "placed",
      page: {
        url: "http://localhost:3000/app",
        route: "/app",
        title: "App",
        viewport: { width: 1280, height: 800, dpr: 1 },
      },
      target: {
        kind: "element",
        elements: [
          {
            selector: "#save",
            tag: "button",
            text: "y".repeat(5000),
            rect: { x: 1, y: 2, width: 3, height: 4 },
          },
        ],
      },
      comments: [
        {
          id: "m1",
          role: "user",
          intent: "action",
          body: "Rename to Save",
          createdAt: "t",
          updatedAt: "t",
        },
      ],
    };
    const malformed = { ...annotation, id: "a2", page: { ...annotation.page, route: "//evil" } };
    await post(handle.url, "api/save", { annotations: [annotation, malformed] });
    const poll = (await fetch(`${handle.url}api/poll`).then((r) => r.json())) as {
      annotations?: Array<{ id: string; target: { elements: Array<{ text: string }> } }>;
    };
    assert.deepEqual(
      poll.annotations?.map((a) => a.id),
      ["a1"],
      "the malformed entry was dropped on save",
    );
    assert.equal(poll.annotations![0]!.target.elements[0]!.text.length, 300, "text capped");
    const sent = (await post(handle.url, "api/send", {}).then((r) => r.json())) as {
      resultJson: string;
    };
    const result = JSON.parse(await readFile(sent.resultJson, "utf8")) as {
      uiTarget?: string;
      uiAnnotations: Array<{ id: string; body: string }>;
      codeChangeRequests: unknown[];
    };
    assert.equal(result.uiTarget, "http://localhost:3000/");
    assert.deepEqual(
      result.uiAnnotations.map((a) => [a.id, a.body]),
      [["a1", "Rename to Save"]],
    );
    assert.deepEqual(result.codeChangeRequests, []);
    assert.equal(st.lastAnnotationNumber, 1, "the save raised the number mark");
    await post(handle.url, "api/reset", {});
    assert.deepEqual(st.annotations, [], "reset clears annotations along with comments");
    assert.equal(st.lastAnnotationNumber, 0, "and starts the numbers over");
  });
});

// ── Annotation screenshots ──────────────────────────────────────────────────────────────────────
// A 1×1 PNG, the smallest real image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function uiAnnotation(id: string) {
  return {
    id,
    number: 1,
    intent: "change",
    status: "open",
    placement: "placed",
    page: { route: "/app", viewport: { width: 1280, height: 800, dpr: 1 } },
    target: {
      kind: "element",
      elements: [{ selector: "#save", tag: "button", rect: { x: 1, y: 2, width: 3, height: 4 } }],
    },
    comments: [
      {
        id: `${id}-m1`,
        role: "user",
        intent: "action",
        body: "Rename",
        createdAt: "t",
        updatedAt: "t",
      },
    ],
  };
}

// A UI-only desk with annotations a1 and a2 saved, as the tab saves them before it uploads.
async function withShotDesk(
  run: (
    handle: Awaited<ReturnType<typeof startServer>>,
    st: ReviewState,
    shots: string,
  ) => Promise<void>,
) {
  await withServer(async (handle, root, st) => {
    st.files = [];
    st.ui = { target: "http://localhost:3000/" };
    await post(handle.url, "api/save", { annotations: [uiAnnotation("a1"), uiAnnotation("a2")] });
    await run(handle, st, path.join(await reviewDir(root, st.session), "ui-shots"));
  });
}

const upload = (base: string, query: string, body: Uint8Array) =>
  fetch(`${base}api/ui-shot?${query}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body,
  });

test("screenshot upload stores a PNG pair beside the review, never in the state, and the Send gives its paths", async () => {
  await withShotDesk(async (handle, st, shots) => {
    const crop = await upload(handle.url, "annotation=a1&kind=crop", PNG);
    assert.equal(crop.status, 200);
    assert.deepEqual(await crop.json(), { ok: true, screenshots: false });
    assert.equal(st.annotations![0]!.screenshots, undefined, "half a pair isn't marked");
    const viewport = await upload(handle.url, "annotation=a1&kind=viewport", PNG);
    assert.deepEqual(await viewport.json(), { ok: true, screenshots: true });
    assert.deepEqual(await readFile(path.join(shots, "a1-crop.png")), PNG);
    assert.deepEqual(await readFile(path.join(shots, "a1-viewport.png")), PNG);

    // The stored review and the poll carry the mark, never the bytes.
    const stateFile = await readFile(path.join(path.dirname(shots), st.persistFile!), "utf8");
    const poll = await fetch(`${handle.url}api/poll`).then((r) => r.text());
    for (const text of [stateFile, poll]) {
      assert.ok(text.includes('"screenshots":'));
      assert.ok(!text.includes("PNG") && !text.includes(PNG.toString("base64").slice(0, 12)));
    }

    // A later save from the tab (which never sends the mark) keeps it.
    await post(handle.url, "api/save", { annotations: [uiAnnotation("a1"), uiAnnotation("a2")] });
    const sent = (await post(handle.url, "api/send", {}).then((r) => r.json())) as {
      resultJson: string;
    };
    const result = JSON.parse(await readFile(sent.resultJson, "utf8")) as {
      uiAnnotations: Array<{ id: string; screenshots?: Record<string, unknown> }>;
    };
    const [a1, a2] = result.uiAnnotations;
    assert.deepEqual(a1!.screenshots, {
      crop: path.join(shots, "a1-crop.png"),
      viewport: path.join(shots, "a1-viewport.png"),
      exact: false,
    });
    assert.equal(a2!.screenshots, undefined);

    const served = await fetch(`${handle.url}api/ui-shot?annotation=a1&kind=viewport`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  });
});

test("screenshot upload takes a PNG up to the cap and refuses a bigger, non-PNG, unknown or escaping one", async () => {
  await withShotDesk(async (handle, _st, shots) => {
    const atCap = Buffer.alloc(SHOT_CAP);
    PNG.copy(atCap);
    assert.equal((await upload(handle.url, "annotation=a1&kind=crop", atCap)).status, 200);
    const over = Buffer.alloc(SHOT_CAP + 1);
    PNG.copy(over);
    const cases: Array<[string, Uint8Array, number]> = [
      ["annotation=a2&kind=crop", over, 413],
      ["annotation=a2&kind=crop", Buffer.from("<svg onload=alert(1)>"), 415],
      ["annotation=nope&kind=crop", PNG, 404],
      ["annotation=..%2F..%2Fx&kind=crop", PNG, 400],
      ["annotation=a2&kind=..%2Fx", PNG, 400],
      ["annotation=a2&kind=thumb", PNG, 400],
      ["kind=crop", PNG, 400],
    ];
    for (const [query, body, status] of cases)
      assert.equal((await upload(handle.url, query, body)).status, status, query);
    assert.deepEqual(await readdir(shots), ["a1-crop.png"], "nothing else was written");
  });
});

test("screenshots are served only from the session's screenshot directory", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "galley-outside-"));
  try {
    await withShotDesk(async (handle, _st, shots) => {
      await upload(handle.url, "annotation=a1&kind=crop", PNG);
      await writeFile(path.join(outside, "secret.png"), PNG);
      // A link planted in the directory still can't reach outside it.
      await symlink(path.join(outside, "secret.png"), path.join(shots, "a2-crop.png"));
      const get = (query: string) => fetch(`${handle.url}api/ui-shot?${query}`);
      assert.equal((await get("annotation=a1&kind=crop")).status, 200);
      assert.equal((await get("annotation=a2&kind=crop")).status, 400, "symlink out");
      assert.equal((await get("annotation=a1&kind=viewport")).status, 404, "not uploaded");
      assert.equal((await get("annotation=..%2Fdesk&kind=crop")).status, 400);
      assert.equal((await get("annotation=a1&kind=..%2F..%2Fx")).status, 400);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("deleting an annotation deletes its screenshots, and a reset deletes them all", async () => {
  await withShotDesk(async (handle, _st, shots) => {
    for (const id of ["a1", "a2"])
      for (const kind of ["crop", "viewport"])
        await upload(handle.url, `annotation=${id}&kind=${kind}`, PNG);
    // The tab deletes a1 and saves; the save drops its files.
    await post(handle.url, "api/save", { annotations: [uiAnnotation("a2")] });
    assert.deepEqual((await readdir(shots)).sort(), ["a2-crop.png", "a2-viewport.png"]);
    // A Send that drops one does the same.
    await post(handle.url, "api/send", { annotations: [] });
    assert.deepEqual(await readdir(shots), []);
    await post(handle.url, "api/save", { annotations: [uiAnnotation("a1")] });
    await upload(handle.url, "annotation=a1&kind=crop", PNG);
    await post(handle.url, "api/reset", {});
    await assert.rejects(readdir(shots), { code: "ENOENT" }, "reset removes the directory");
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

test("resolveBinding: the loopback default widens nothing and keeps both URLs on 127.0.0.1", () => {
  for (const h of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    const b = resolveBinding(h, "devbox", ["exotic.example"]);
    assert.equal(b.browserHost, "127.0.0.1", `${h} browserHost`);
    assert.equal(b.lockHost, "127.0.0.1", `${h} lockHost`);
    // The property to guard jealously: a loopback bind trusts ONLY the loopback authorities — the
    // machine hostname and GALLEY_ALLOWED_HOSTS never leak in.
    assert.deepEqual(b.allowedHosts, ["127.0.0.1", "localhost", "[::1]"], `${h} allowedHosts`);
  }
});

test("resolveBinding: a wildcard bind advertises the hostname but locks over loopback", () => {
  for (const h of ["0.0.0.0", "::", "[::]"]) {
    const b = resolveBinding(h, "devbox", ["dev.tail1234.ts.net"]);
    assert.equal(b.browserHost, "devbox", `${h} browserHost is the hostname`);
    assert.equal(b.lockHost, "127.0.0.1", `${h} lockHost stays loopback (still reachable)`);
    // Loopback set + hostname + env hosts; no single bound address to add for a wildcard.
    assert.deepEqual(b.allowedHosts, [
      "127.0.0.1",
      "localhost",
      "[::1]",
      "devbox",
      "dev.tail1234.ts.net",
    ]);
  }
});

test("resolveBinding: a specific non-loopback bind uses that address for both URLs and the guard", () => {
  const b = resolveBinding("100.64.1.5", "devbox", []);
  // Loopback can't reach a socket bound only to a specific address, so the lock must use it too.
  assert.equal(b.browserHost, "100.64.1.5");
  assert.equal(b.lockHost, "100.64.1.5");
  assert.deepEqual(b.allowedHosts, ["127.0.0.1", "localhost", "[::1]", "devbox", "100.64.1.5"]);
});

test("resolveBinding: an IPv6 literal bind is bracket-wrapped for URLs and authorities", () => {
  const b = resolveBinding("fd7a:115c:a1e0::1", "devbox", ["dev.tail1234.ts.net"]);
  assert.equal(b.browserHost, "[fd7a:115c:a1e0::1]");
  assert.equal(b.lockHost, "[fd7a:115c:a1e0::1]");
  assert.deepEqual(b.allowedHosts, [
    "127.0.0.1",
    "localhost",
    "[::1]",
    "devbox",
    "[fd7a:115c:a1e0::1]",
    "dev.tail1234.ts.net",
  ]);
});

// Connect over loopback (portable on CI) but present an arbitrary Host header — the only way to
// exercise the origin guard, since undici drops a forbidden Host on fetch (see rawRequest).
const withHost = (loopbackUrl: string, host: string, method = "GET") =>
  rawRequest(loopbackUrl, {
    method,
    headers: {
      host,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ body: "x" }) } : {}),
  });

test("default bind (loopback) still 403s the machine hostname — no widening", async () => {
  await withServer(async (handle) => {
    // handle.url is loopback by default; lockUrl equals it.
    assert.equal(handle.lockUrl, handle.url);
    const port = new URL(handle.url).port;
    const res = await withHost(`${handle.url}api/state`, `${hostname()}:${port}`);
    assert.equal(res.status, 403);
    assert.equal((JSON.parse(res.body) as { code?: string }).code, "FORBIDDEN_HOST");
  });
});

test("--host 0.0.0.0 accepts the hostname authority and loopback; lock stays loopback", async () => {
  await withServer(
    async (handle) => {
      // The browser URL advertises the hostname; the lock (agent-side) stays on 127.0.0.1.
      assert.match(handle.url, new RegExp(`^http://${hostname()}:\\d+/$`));
      assert.match(handle.lockUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      const port = new URL(handle.lockUrl).port;
      // Reach the desk over loopback (the wildcard bind includes it) with the hostname in Host.
      const named = await withHost(`${handle.lockUrl}api/state`, `${hostname()}:${port}`);
      assert.equal(named.status, 200);
      // Loopback authority still works.
      const loop = await withHost(`${handle.lockUrl}api/state`, `127.0.0.1:${port}`);
      assert.equal(loop.status, 200);
      // A foreign Host is still refused — the guard is extended, not defeated.
      const evil = await withHost(`${handle.lockUrl}api/state`, `evil.example:${port}`);
      assert.equal(evil.status, 403);
      assert.equal((JSON.parse(evil.body) as { code?: string }).code, "FORBIDDEN_HOST");
    },
    { host: "0.0.0.0", idleTimeoutMs: 0 },
  );
});

test("GALLEY_ALLOWED_HOSTS entries pass the guard; a non-member 403s", async () => {
  await withServer(
    async (handle) => {
      const port = new URL(handle.lockUrl).port;
      const allowed = await withHost(`${handle.lockUrl}api/state`, `dev.tail1234.ts.net:${port}`);
      assert.equal(allowed.status, 200);
      const other = await withHost(`${handle.lockUrl}api/state`, `nope.example:${port}`);
      assert.equal(other.status, 403);
    },
    { host: "0.0.0.0", allowedHosts: ["dev.tail1234.ts.net"], idleTimeoutMs: 0 },
  );
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

type PollWithUi = {
  ui?: { target: string };
  uiProxy: { port: number; token: string } | null;
  reloadGeneration: number;
};
const getPoll = (url: string) =>
  fetch(`${url}api/poll`).then((r) => r.json() as Promise<PollWithUi>);

test("POST /api/ui sets the UI target, starts the proxy once, and the poll carries both", async () => {
  await withServer(async (handle, root, st) => {
    const before = await getPoll(handle.url);
    assert.equal(before.ui, undefined);
    assert.equal(before.uiProxy, null, "no proxy until a UI target exists");

    const res = await post(handle.url, "api/ui", { target: "http://localhost:3000/sign-in?as=x" });
    assert.equal(res.status, 200);
    assert.deepEqual(st.ui, { target: "http://localhost:3000/sign-in?as=x" });
    const poll = await getPoll(handle.url);
    assert.deepEqual(poll.ui, { target: "http://localhost:3000/sign-in?as=x" });
    assert.ok(poll.uiProxy && poll.uiProxy.port > 0);
    assert.match(poll.uiProxy.token, /^[0-9a-f]{32}$/);
    const bridge = await fetch(`http://127.0.0.1:${poll.uiProxy.port}/__galley/bridge.js`);
    assert.notEqual(bridge.status, 403, "the proxy answers on the advertised port");
    await bridge.arrayBuffer();

    // Replacing the target keeps the same proxy — the open tab's iframe origin doesn't move.
    await post(handle.url, "api/ui", { target: "http://127.0.0.1:4000/" });
    const replaced = await getPoll(handle.url);
    assert.deepEqual(replaced.ui, { target: "http://127.0.0.1:4000/" });
    assert.deepEqual(replaced.uiProxy, poll.uiProxy);
    // Persisted with the review, so a restart keeps it.
    const saved = JSON.parse(
      await readFile(path.join(root, ".galley", hash(root), "s", st.persistFile!), "utf8"),
    ) as ReviewState;
    assert.deepEqual(saved.ui, { target: "http://127.0.0.1:4000/" });
  });
});

test("POST /api/ui refuses a non-loopback or https target with 422", async () => {
  await withServer(async (handle, _root, st) => {
    for (const target of ["http://example.com:3000/", "https://localhost:3000/"]) {
      const res = await post(handle.url, "api/ui", { target });
      assert.equal(res.status, 422, target);
      assert.equal(((await res.json()) as { code?: string }).code, "INVALID_UI_TARGET");
    }
    assert.equal(st.ui, undefined, "nothing was set");
    assert.equal((await getPoll(handle.url)).uiProxy, null, "no proxy was started");
  });
});

test("a page on the proxy origin cannot call the desk's mutating routes", async () => {
  await withServer(async (handle) => {
    await post(handle.url, "api/ui", { target: "http://localhost:3000/" });
    const { uiProxy } = await getPoll(handle.url);
    const proxyOrigin = `http://127.0.0.1:${uiProxy!.port}`;
    for (const route of ["api/reset", "api/ui", "api/shutdown"]) {
      const res = await rawRequest(`${handle.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: proxyOrigin },
        body: JSON.stringify({ target: "http://localhost:4000/" }),
      });
      assert.equal(res.status, 403, route);
      assert.equal((JSON.parse(res.body) as { code?: string }).code, "FORBIDDEN_ORIGIN");
    }
  });
});

test("a desk started with a UI target serves it at once; proxy traffic never keeps it alive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "galley-uiidle-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const reasons: string[] = [];
  const st = { ...state(root), ui: { target: "http://localhost:3000/" } };
  const handle = await startServer({
    state: st,
    open: false,
    idleTimeoutMs: 150,
    onShutdown: (reason) => reasons.push(reason),
  });
  try {
    const { uiProxy } = await getPoll(handle.url);
    assert.ok(uiProxy, "the proxy started with the desk");
    // Hammer the proxy well past the idle timeout: a desk nobody but the app's own traffic touches
    // is still abandoned.
    const until = Date.now() + 500;
    while (Date.now() < until && !reasons.length) {
      await fetch(`http://127.0.0.1:${uiProxy.port}/__galley/health`).then((r) => r.arrayBuffer());
      await sleep(20);
    }
    assert.deepEqual(reasons, ["idle"]);
    // The proxy closes with the desk.
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    const after = await fetch(`http://127.0.0.1:${uiProxy.port}/__galley/health`).then(
      () => "answered",
      () => "refused",
    );
    assert.equal(after, "refused");
  } finally {
    handle.server.close();
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("every /api/reload bumps reloadGeneration, even when the diff doesn't move", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "galley-reloadgen-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const g = (args: string[]) => execFileSync("git", args, { cwd: root }).toString();
  g(["init", "-q"]);
  g(["config", "user.email", "t@t.co"]);
  g(["config", "user.name", "tester"]);
  await writeFile(path.join(root, "a.ts"), "one\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  // A clean tree: the UI-only desk shape, where the diff never moves on reload.
  const st = await buildReviewState(root, { session: "s", allowEmpty: true });
  const handle = await startServer({ state: st!, open: false, idleTimeoutMs: 0 });
  try {
    assert.equal((await getPoll(handle.url)).reloadGeneration, 0);
    const hashBefore = (await getPoll(handle.url)) as unknown as { baseDiffHash: string };
    await post(handle.url, "api/reload", {});
    const once = (await getPoll(handle.url)) as PollWithUi & { baseDiffHash: string };
    assert.equal(once.reloadGeneration, 1);
    assert.equal(once.baseDiffHash, hashBefore.baseDiffHash, "the diff didn't move");
    await writeFile(path.join(root, "a.ts"), "two\n");
    await post(handle.url, "api/reload", {});
    assert.equal((await getPoll(handle.url)).reloadGeneration, 2);
  } finally {
    handle.server.close();
    process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});
