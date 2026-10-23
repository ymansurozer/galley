import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";
import { mergeReviewerSave } from "../state.js";

// Real poll/status/render modules, adapted from the independent starvation probe. HTTP
// snapshots and response ordering are controlled; bundles never write generated output.
const bundle = build({
  stdin: {
    contents:
      'import {S,saver,persist,persistSoon} from "./store"; import {pollState,adoptDeskStatus} from "./poll"; import {deleteComment,turnComment} from "./comments"; import {acceptChange} from "./decisions"; import {submitUiComposer,placedInApp} from "./uilane"; import {renderMarkdown} from "./markdown"; window.h={S,saver,persist,persistSoon,pollState,adoptDeskStatus,deleteComment,turnComment,acceptChange,submitUiComposer,placedInApp,renderMarkdown};',
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
    mode: "pr",
    changes: [
      {
        id: "change",
        path: "a.ts",
        status: "pending",
        stableKey: "key",
        contentHash: "content",
        hunkIndex: 0,
        side: "additions",
        lineNumber: 1,
        title: "Change",
      },
    ],
    comments: [],
    annotations: [],
    baseDiffHash: "base",
    decisions: [],
    decisionFiles: [],
    reviewedFiles: [],
    reviewedFileHashes: {},
    signedOffBlocks: {},
  };
  const priorDiff = JSON.parse(JSON.stringify(S.state));
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
  const saves: any[] = [];
  win.fetch = (async (url: string, options: any) => {
    if (url === "/api/save") {
      const body = JSON.parse(options.body);
      saves.push(body);
      await mergeReviewerSave(
        server,
        body,
        {
          token: server.uiProxy.token,
          reloadGeneration: server.reloadGeneration,
        },
        priorDiff,
      );
      return { ok: true, json: async () => ({ ok: true }) };
    }
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
          : Promise.resolve(
              url === "/api/tree"
                ? { files: [] }
                : Object.fromEntries(
                    [
                      "baseDiffHash",
                      "guide",
                      "comments",
                      "ui",
                      "annotations",
                      "project",
                      "branch",
                      "uiProxy",
                      "reloadGeneration",
                      "uiRefreshGeneration",
                      "agentActivity",
                      "agentListening",
                      "agentRecentlyActive",
                      "queuedQuestions",
                      "queuedReviews",
                    ]
                      .filter((key) => key in snapshot)
                      .map((key) => [key, snapshot[key]]),
                  ),
            ),
    };
  }) as any;
  return {
    S,
    h,
    win,
    saves,
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

const reviewerComment = {
  id: "reviewer",
  role: "user",
  path: "a.ts",
  side: "additions",
  lineNumber: 1,
  body: "Original objection",
  intent: "question",
  status: "open",
  createdAt: "2026-10-23T12:00:00Z",
  updatedAt: "2026-10-23T12:00:00Z",
};
const reviewerAnnotation = {
  id: "pin",
  number: 1,
  intent: "question",
  status: "open",
  placement: "unvisited",
  page: {
    url: "http://localhost:3000/",
    route: "/",
    viewport: { width: 1000, height: 700, dpr: 1 },
  },
  target: { kind: "page" },
  comments: [{ ...reviewerComment, id: "annotation-message" }],
};

for (const branch of ["diff", "guide"] as const) {
  for (const newerLite of [true, false]) {
    test(`${branch} rejects a completed reviewer deletion's old snapshot (${newerLite ? "with" : "without"} a newer lite tick)`, async (t) => {
      const f = await fixture(t);
      f.S.state.comments = [structuredClone(reviewerComment)];
      f.update({ comments: [structuredClone(reviewerComment)], ...updateFor(branch, "updated") });
      const owner = f.poll();
      await until(() => f.pending.length === 1);
      const originalState = f.S.state;
      await f.h.deleteComment("reviewer");
      await f.h.saver.settled();
      assert.equal(
        f.h.saver.isBusy(),
        false,
        "the save has fully completed before old data arrives",
      );
      assert.equal(f.S.state, originalState, "the mutation did not replace ReviewState");
      assert.equal(f.server().comments.length, 0, "real backend save merging stored the deletion");
      if (newerLite) await f.poll();
      f.pending[0]!.release();
      await owner;
      assert.equal(
        f.S.state.comments.length,
        0,
        "the old transfer cannot resurrect a deleted comment",
      );
      assert.notEqual(adopted(f, branch), "updated", "outdated work waits for a fresh snapshot");
      f.h.persist();
      await f.h.saver.settled();
      assert.equal(f.server().comments.length, 0, "the next save cannot persist a resurrection");
      const retry = f.poll();
      await until(() => f.pending.length === 2);
      f.pending[1]!.release();
      await retry;
      assert.equal(adopted(f, branch), "updated");
      assert.equal(f.S.state.comments.length, 0);
    });
  }

  test(`${branch} preserves saved in-place modifications and decisions across an old transfer`, async (t) => {
    const f = await fixture(t);
    f.S.state.comments = [structuredClone(reviewerComment)];
    f.S.state.annotations = [structuredClone(reviewerAnnotation)];
    f.update({
      comments: [structuredClone(reviewerComment)],
      annotations: [structuredClone(reviewerAnnotation)],
      ...updateFor(branch, "updated"),
    });
    const owner = f.poll();
    await until(() => f.pending.length === 1);
    f.h.turnComment("reviewer"); // question -> change request: same record, no agent Ask
    await f.h.acceptChange("change", "rejected");
    f.S.composerOpen = true;
    f.S.composerAnnotation = "pin";
    f.S.editingCommentId = "annotation-message";
    f.S.composerBody = "Revised annotation text";
    f.h.submitUiComposer("action");
    await f.h.saver.settled();
    assert.equal(f.S.state.comments[0].intent, "action");
    assert.equal(f.server().comments[0].intent, "action");
    assert.equal(f.S.state.decisions[0].status, "rejected");
    assert.equal(f.server().decisions[0].status, "rejected");
    assert.equal(f.server().annotations[0].comments[0].body, "Revised annotation text");
    await f.poll();
    f.pending[0]!.release();
    await owner;
    assert.equal(f.S.state.comments[0].intent, "action");
    assert.equal(f.S.state.decisions[0].status, "rejected");
    assert.equal(f.S.state.annotations[0].comments[0].body, "Revised annotation text");
    assert.notEqual(adopted(f, branch), "updated");
    const retry = f.poll();
    await until(() => f.pending.length === 2);
    f.pending[1]!.release();
    await retry;
    assert.equal(adopted(f, branch), "updated");
    assert.equal(f.S.state.comments[0].intent, "action");
    assert.equal(f.S.state.decisions[0].status, "rejected");
    assert.equal(f.S.state.annotations[0].comments[0].body, "Revised annotation text");
  });

  test(`${branch} invalidates old work when a real placement callback requests a deferred save`, async (t) => {
    const f = await fixture(t);
    for (const phase of ["waiting", "completed"] as const) {
      const annotation = structuredClone(reviewerAnnotation);
      annotation.page.route = f.S.app.route;
      annotation.page.url = new URL(f.S.app.route, "http://localhost:3000").href;
      f.S.state.annotations = [annotation];
      f.update({ annotations: [structuredClone(annotation)], ...updateFor(branch, phase) });
      const start = f.pending.length;
      const owner = f.poll();
      await until(() => f.pending.length === start + 1);
      const generation = f.h.saver.generation();
      const saved = f.saves.length;
      const originalTimeout = f.win.setTimeout.bind(f.win);
      let dispatch: (() => void) | undefined;
      f.win.setTimeout = ((callback: () => void, ms: number, ...args: any[]) => {
        if (ms === 1000) dispatch = callback;
        return originalTimeout(callback, ms, ...args);
      }) as any;
      f.h.placedInApp([{ id: "pin", placement: "placed" }]);
      f.win.setTimeout = originalTimeout;
      assert.ok(dispatch, "the real placement callback requested persistSoon");
      assert.ok(
        f.h.saver.generation() > generation,
        "deferred mutation is visible before dispatch",
      );
      assert.equal(f.h.saver.isBusy(), false);
      assert.equal(f.saves.length, saved);
      if (phase === "completed") {
        dispatch!();
        await f.h.saver.settled();
      }
      await f.poll();
      f.pending[start]!.release();
      await owner;
      assert.notEqual(
        adopted(f, branch),
        phase,
        "even an idle or unsent save invalidates the snapshot",
      );
      assert.equal(f.S.state.annotations[0].placement, "placed");
      if (phase === "waiting") {
        dispatch!();
        await f.h.saver.settled();
      }
      assert.equal(f.server().annotations[0].placement, "placed");
      const retry = f.poll();
      await until(() => f.pending.length === start + 2);
      f.pending[start + 1]!.release();
      await retry;
      assert.equal(adopted(f, branch), phase);
      assert.equal(f.S.state.annotations[0].placement, "placed");
    }
  });
}

for (const branch of ["diff", "guide"] as const) {
  test(`${branch} adoption progresses through repeated identical-revision lite polls`, async (t) => {
    const f = await fixture(t);
    f.S.state.annotations = [structuredClone(reviewerAnnotation)];
    f.update({
      ...updateFor(branch, "updated"),
      reloadGeneration: 1,
      annotations: [structuredClone(reviewerAnnotation)],
    });
    const owner = f.poll();
    await until(() => f.pending.length === 1);
    const saveGeneration = f.h.saver.generation();
    const ticks: Promise<void>[] = [];
    for (let i = 1; i <= 5; i++) {
      const annotations = structuredClone(f.server().annotations);
      annotations[0].comments.push({
        ...reviewerComment,
        id: `agent-${i}`,
        role: "agent",
        body: `Reply ${i}`,
      });
      f.update({
        annotations,
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
    assert.equal(f.S.state.annotations[0].comments.length, 6);
    assert.equal(
      f.h.saver.generation(),
      saveGeneration,
      "agent-only reply polling is not reviewer save activity",
    );
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
