import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "./server.js";
import { writeGlobalSettings } from "./state.js";
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
      {
        path: "a.ts",
        hunks: [],
        oldFile: { name: "a.ts", contents: "" },
        newFile: { name: "a.ts", contents: "hello\n" },
        contentHash: "H",
      },
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

test("an unconsumed question surfaces as queuedQuestions", async () => {
  await withServer(async (handle) => {
    await post(handle.url, "api/ask", { path: "a.ts", lineNumber: 1, body: "why?" });
    const st = await getState(handle.url);
    assert.equal(st.queuedQuestions, 1);
    assert.equal(st.agentListening, false);
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
    assert.equal(st.files[0]?.newFile.contents, "hello\n");
  });
});

test("save from a stale full-state tab ignores server-owned fields in the body", async () => {
  await withServer(async (handle, _root, st) => {
    const before = st.files[0]!.newFile.contents;
    // A stale tab POSTs the whole old ReviewState — the server must pick only the slice.
    await post(handle.url, "api/save", {
      reviewedFiles: ["a.ts"],
      rawDiff: "CLIENT DIFF SHOULD BE IGNORED",
      baseDiffHash: "client-hash",
      files: [
        {
          path: "evil.ts",
          hunks: [],
          oldFile: { name: "evil.ts", contents: "" },
          newFile: { name: "evil.ts", contents: "x" },
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
    assert.equal(st.files[0]?.newFile.contents, before);
  });
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
