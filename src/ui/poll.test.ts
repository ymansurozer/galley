import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

// Real poll/status/render modules, adapted from the independent starvation probe. HTTP
// snapshots and response ordering are controlled; bundles never write generated output.
const bundle = build({
  stdin: {
    contents:
      'import {S} from "./store"; import {pollState,adoptDeskStatus} from "./poll"; import {renderMarkdown} from "./markdown"; window.h={S,pollState,adoptDeskStatus,renderMarkdown};',
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  logLevel: "silent",
});
const ids = [
  ...readFileSync(new URL("index.html", import.meta.url), "utf8").matchAll(/\bid="([^"]+)"/g),
].map((m) => m[1]);

async function until(check: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "bounded poll wait");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const win = new Window({
    url: "http://localhost:41000/",
    settings: { disableIframePageLoading: true },
  });
  const pending: Array<{ snapshot: any; release: (payload?: any) => void; fail: () => void }> = [];
  const polls: Promise<void>[] = [];
  t.after(async () => {
    for (const request of pending) request.release();
    await Promise.all(polls);
    await win.happyDOM.waitUntilComplete();
    await win.happyDOM.close();
  });
  win.document.body.innerHTML = ids.map((id) => `<div id="${id}"></div>`).join("");
  win.eval((await bundle).outputFiles[0]!.text);
  const h = (win as any).h;
  await until(() => h.renderMarkdown("**ready**").includes("<strong>"));
  const { S } = h;
  S.state = {
    root: "/repo",
    project: "project",
    branch: "branch",
    ui: { target: "http://localhost:3000/entry" },
    files: [],
    changes: [{ id: "change", path: "a.ts", status: "pending" }],
    comments: [],
    annotations: [],
    baseDiffHash: "base",
  };
  S.lastBaseDiffHash = "base";
  let server: any = {
    ...JSON.parse(JSON.stringify(S.state)),
    uiProxy: { port: 41001, token: "first" },
    reloadGeneration: 0,
    uiRefreshGeneration: 0,
    agentRecentlyActive: false,
    queuedQuestions: 0,
  };
  h.adoptDeskStatus(server);
  win.fetch = (async (url: string) => {
    const snapshot = structuredClone(server);
    return {
      ok: true,
      json: () =>
        url === "/api/state"
          ? new Promise((resolve, reject) =>
              pending.push({
                snapshot,
                release: (payload = snapshot) => resolve(payload),
                fail: () => reject(new Error("transfer failed")),
              }),
            )
          : Promise.resolve(url === "/api/tree" ? { files: [] } : snapshot),
    };
  }) as any;
  return {
    S,
    pending,
    server: () => server,
    update: (patch: any) => (server = { ...server, ...patch }),
    poll: () => {
      const poll = h.pollState();
      polls.push(poll);
      return poll;
    },
  };
}

const updateFor = (branch: "diff" | "guide", label: string) =>
  branch === "diff"
    ? { baseDiffHash: label }
    : {
        guide: { title: label, overview: label, files: [] },
        changes: [
          { id: "change", path: "a.ts", status: "pending", part: 2, skim: { reason: label } },
        ],
      };
const adopted = (f: Awaited<ReturnType<typeof fixture>>, branch: "diff" | "guide") =>
  branch === "diff" ? f.S.lastBaseDiffHash : f.S.state.guide?.title;

for (const branch of ["diff", "guide"] as const) {
  test(`${branch} adoption progresses through repeated identical-revision lite polls`, async (t) => {
    const f = await fixture(t);
    f.update({ ...updateFor(branch, "updated"), reloadGeneration: 1 });
    const owner = f.poll();
    await until(() => f.pending.length === 1);
    const ticks: Promise<void>[] = [];
    for (let i = 1; i <= 5; i++) {
      f.update({
        agentRecentlyActive: true,
        queuedQuestions: i,
        branch: `latest-${i}`,
        comments: [
          {
            id: "reply",
            role: "agent",
            path: "a.ts",
            side: "additions",
            lineNumber: 1,
            body: "Latest reply",
            status: "open",
            createdAt: "2026-10-23T12:00:00Z",
            updatedAt: "2026-10-23T12:00:00Z",
          },
        ],
      });
      ticks.push(f.poll());
      await until(() => f.S.queuedQuestions === i);
    }
    f.pending[0]!.release();
    await owner;
    assert.equal(
      adopted(f, branch),
      "updated",
      "a completed matching full snapshot makes progress",
    );
    assert.equal(f.pending.length, 1, "unchanged ticks share the pending full-state work");
    await Promise.all(ticks);
    assert.equal(
      f.S.agentRecentlyActive,
      true,
      "old full-state liveness never overrides a newer lite poll",
    );
    assert.equal(f.S.queuedQuestions, 5);
    assert.equal(f.S.state.branch, "latest-5", "names come from the newest lite snapshot");
    assert.equal(f.S.state.comments[0].body, "Latest reply");
    assert.equal(f.S.reloadGeneration, 1);
    assert.equal("reloadGeneration" in f.S.state, false);
    assert.equal("agentRecentlyActive" in f.S.state, false);
    if (branch === "guide") {
      assert.equal(f.S.state.changes[0].part, 2);
      assert.equal(f.S.state.changes[0].skim.reason, "updated");
    }
    await f.poll();
    assert.equal(f.pending.length, 1, "adoption prevents another unchanged full fetch");
  });

  test(`${branch} full-state work rejects obsolete revisions, targets and process tokens`, async (t) => {
    const f = await fixture(t);
    for (const invalidation of ["revision", "token", "target", "counter"] as const) {
      const firstLabel = `${invalidation}-old`;
      f.update({
        ...updateFor(branch, firstLabel),
        reloadGeneration: f.server().reloadGeneration + 1,
      });
      const start = f.pending.length;
      const old = f.poll();
      await until(() => f.pending.length === start + 1);
      const before = adopted(f, branch);
      const latestLabel = invalidation === "revision" ? `${invalidation}-new` : firstLabel;
      f.update({
        ...updateFor(branch, latestLabel),
        ...(invalidation === "token"
          ? {
              uiProxy: { port: 41001, token: "restart" },
              reloadGeneration: 0,
              uiRefreshGeneration: 0,
            }
          : {}),
        ...(invalidation === "target"
          ? { ui: { target: "http://localhost:3000/replacement" } }
          : {}),
        ...(invalidation === "counter"
          ? {
              reloadGeneration: f.server().reloadGeneration + 1,
              uiRefreshGeneration: f.server().uiRefreshGeneration + 1,
            }
          : {}),
      });
      const current = f.poll();
      await until(() => f.pending.length === start + 2);
      const token = f.S.uiProxy.token;
      const generation = f.S.reloadGeneration;
      if (invalidation === "token") {
        f.pending[start + 1]!.release();
        await current;
      }
      f.pending[start]!.release();
      await old;
      assert.equal(
        adopted(f, branch),
        invalidation === "token" ? latestLabel : before,
        `${invalidation}: old full snapshot is discarded, even after newer adoption`,
      );
      assert.equal(f.S.uiProxy.token, token);
      assert.equal(f.S.reloadGeneration, generation);
      f.pending[start + 1]!.release();
      await current;
      assert.equal(adopted(f, branch), latestLabel);
      await f.poll();
      assert.equal(f.pending.length, start + 2);
    }
  });

  test(`${branch} validates returned revisions and retries rejected or failed full-state work`, async (t) => {
    const f = await fixture(t);
    for (const failure of ["revision", "token", "refresh counter", "network"] as const) {
      const start = f.pending.length;
      f.update({
        ...updateFor(branch, failure),
        reloadGeneration: f.server().reloadGeneration + 1,
        ...(failure === "refresh counter"
          ? { uiRefreshGeneration: f.server().uiRefreshGeneration + 1 }
          : {}),
      });
      const stale = f.poll();
      await until(() => f.pending.length === start + 1);
      const request = f.pending[start]!;
      if (failure === "network") request.fail();
      else
        request.release({
          ...request.snapshot,
          ...(failure === "revision" ? updateFor(branch, "obsolete") : {}),
          ...(failure === "token" ? { uiProxy: { port: 41001, token: "obsolete" } } : {}),
          ...(failure === "refresh counter"
            ? { uiRefreshGeneration: request.snapshot.uiRefreshGeneration - 1 }
            : {}),
        });
      await stale;
      assert.notEqual(adopted(f, branch), "obsolete");
      assert.notEqual(adopted(f, branch), failure);
      const retry = f.poll();
      await until(() => f.pending.length === start + 2);
      request.release();
      f.pending[start + 1]!.release();
      await retry;
      assert.equal(adopted(f, branch), failure);
    }
  });
}
