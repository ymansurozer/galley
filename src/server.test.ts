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
  run: (handle: Awaited<ReturnType<typeof startServer>>, root: string) => Promise<void>,
  options: { runEditorCommand?: (command: string, args: string[]) => Promise<void> } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "galley-server-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const handle = await startServer({ state: state(root), open: false, ...options });
  try {
    await run(handle, root);
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
