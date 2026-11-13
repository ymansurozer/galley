import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";
import { mergeReviewerSave, reviewerFields } from "../state.js";

// Real poll/status/render modules, adapted from the independent starvation probe. HTTP
// snapshots and response ordering are controlled; bundles never write generated output.
const bundle = build({
  stdin: {
    contents:
      'import {S,saver,persist,persistSoon,confirmDesk} from "./store"; import {pollState,adoptDeskStatus} from "./poll"; import {deleteComment,turnComment} from "./comments"; import {acceptChange} from "./decisions"; import {submitUiComposer,placedInApp} from "./uilane"; import {renderMarkdown} from "./markdown"; import {askComment} from "./comments"; import {approveFile} from "./decisions"; import {installCloseWarning,deskReachMessage,deskRestartCommand} from "./reach"; import {send,sendCancel,sendConfirm} from "./send"; window.h={S,saver,persist,persistSoon,confirmDesk,pollState,adoptDeskStatus,deleteComment,turnComment,acceptChange,submitUiComposer,placedInApp,renderMarkdown,askComment,approveFile,installCloseWarning,deskReachMessage,deskRestartCommand,send,sendCancel,sendConfirm};',
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

// The desk a fixture's tab talks to: its review, and the diff it held before its latest reload.
// Two fixtures given one desk are two tabs open on it.
type Desk = { server: any; priorDiff: any };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, shared?: Desk) {
  const win = new Window({
    url: "http://localhost:41000/",
    settings: { disableIframePageLoading: true },
  });
  const pending: Array<{ snapshot: any; release: (payload?: any) => void; fail: () => void }> = [];
  // The desk's failures: it doesn't answer at all, it answers saves and Sends with an error, or a
  // save's request hangs with no answer until the tab gives it up. `holdSend` and `holdSave` park
  // the next Send or save, before the desk applies it, until the test releases it; `holdReview`
  // parks the next read of the review (/api/review) after the desk answered it.
  const desk = {
    down: false,
    failing: false,
    hang: false,
    holdSend: undefined as undefined | Promise<void>,
    holdSave: undefined as undefined | Promise<void>,
    holdReview: undefined as undefined | Promise<void>,
  };
  let h: any;
  const polls: Promise<void>[] = [];
  t.after(async () => {
    // A save the desk never took keeps retrying, and the window waits on its timers: bring the
    // desk back and let it land.
    Object.assign(desk, { down: false, failing: false, hang: false });
    h.saver.retryNow();
    await h.saver.settled();
    for (const request of pending) request.release();
    await Promise.all(polls);
    await win.happyDOM.waitUntilComplete();
    await win.happyDOM.close();
  });
  win.document.body.innerHTML = ids.map((id) => `<div id="${id}"></div>`).join("");
  win.eval((await bundle).outputFiles[0]!.text);
  h = (win as any).h;
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
  S.lastBaseDiffHash = "base";
  const deskState: Desk = shared ?? {
    priorDiff: JSON.parse(JSON.stringify(S.state)),
    server: {
      ...JSON.parse(JSON.stringify(S.state)),
      uiProxy: { port: 41001, token: "first" },
      reloadGeneration: 0,
      uiRefreshGeneration: 0,
      agentRecentlyActive: false,
      queuedQuestions: 0,
    },
  };
  h.adoptDeskStatus(deskState.server);
  h.confirmDesk(S.state);
  const saves: any[] = [];
  const asks: any[] = [];
  // Every request the tab made, by path, in order.
  const requests: string[] = [];
  win.fetch = (async (url: string, options: any) => {
    requests.push(url);
    if (desk.down) throw new TypeError("Failed to fetch");
    if (desk.failing && (url === "/api/save" || url === "/api/send"))
      return { ok: false, status: 500, json: async () => ({ ok: false, code: "INTERNAL" }) };
    if (url === "/api/save" && desk.hang)
      return new Promise((_resolve, reject) =>
        options.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    if (url === "/api/send" && desk.holdSend) {
      const hold = desk.holdSend;
      desk.holdSend = undefined;
      await hold;
    }
    if (url === "/api/save" && desk.holdSave) {
      const hold = desk.holdSave;
      desk.holdSave = undefined;
      await hold;
    }
    if (url === "/api/save" || url === "/api/send") {
      const body = JSON.parse(options.body);
      saves.push(body);
      const server = deskState.server;
      const { unplaced, saveNumber, merged } = await mergeReviewerSave(
        server,
        body,
        {
          token: server.uiProxy.token,
          reloadGeneration: server.reloadGeneration,
        },
        deskState.priorDiff,
      );
      // As the wire carries it: plain JSON, out of the desk's realm.
      const answer = JSON.parse(
        JSON.stringify({
          ok: true,
          saveNumber,
          ...(url === "/api/send" && { sent: true }),
          ...(unplaced && { unplaced }),
          ...(merged && { merged }),
        }),
      );
      return { ok: true, json: async () => answer };
    }
    if (url === "/api/ask") {
      asks.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    const snapshot = structuredClone(deskState.server);
    if (url === "/api/review") {
      const read = JSON.parse(
        JSON.stringify({
          saveNumber: snapshot.saveNumber ?? 0,
          baseDiffHash: snapshot.baseDiffHash,
          review: reviewerFields(snapshot),
        }),
      );
      const hold = desk.holdReview;
      desk.holdReview = undefined;
      return { ok: true, json: async () => (await hold, read) };
    }
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
                : Object.fromEntries([
                    ["saveNumber", snapshot.saveNumber ?? 0],
                    ...[
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
                  ]),
            ),
    };
  }) as any;
  // The tab's clock (the window has its own Date), moved by hand for the three-second rule.
  let clock = Date.now();
  win.Date.now = () => clock;
  return {
    S,
    h,
    win,
    saves,
    asks,
    requests,
    desk,
    pending,
    advance: (ms: number) => (clock += ms),
    deskState,
    server: () => deskState.server,
    update: (patch: any) => (deskState.server = { ...deskState.server, ...patch }),
    // The tab and the desk were both given the same records by hand: they're the confirmed copy.
    confirm: () => h.confirmDesk({ ...S.state, saveNumber: deskState.server.saveNumber }),
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
      f.confirm();
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
    f.confirm();
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
      f.confirm();
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
    f.confirm();
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

// The desk unreachable: what the tab keeps, what it shows, and how it recovers.
const reviewFile = {
  path: "a.ts",
  hunks: [],
  contentHash: "H",
  changeKind: "modified",
  added: 1,
  removed: 0,
};
// The window's objects come from its own realm: compare them as plain data.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
async function outageFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  Object.assign(f.S.state, { session: "review", target: "feature" });
  f.S.state.files = [structuredClone(reviewFile)];
  f.update({ files: [structuredClone(reviewFile)], session: "review", target: "feature" });
  f.h.installCloseWarning();
  return f;
}

test("an approval made while the desk is down is kept, shown as unsaved, and saved once it answers", async (t) => {
  const f = await outageFixture(t);
  f.desk.down = true;
  await f.poll();
  await f.h.approveFile("a.ts", { advance: false });
  assert.equal(await f.h.saver.settled(), false, "the save did not land");
  assert.deepEqual(plain(f.S.state.reviewedFiles), ["a.ts"], "the tab keeps the approval");
  assert.deepEqual(f.server().reviewedFiles, []);
  assert.equal(f.S.reach, null, "a desk silent for under three seconds shows nothing");
  f.advance(3000);
  await f.poll();
  assert.deepEqual(plain(f.S.reach), { kind: "unreachable", unsaved: true });
  assert.match(f.h.deskReachMessage().detail, /unsaved changes/);
  assert.equal(f.h.deskRestartCommand(), "galley pr feature --session review");
  f.desk.down = false;
  await f.poll();
  assert.ok(f.S.reach, "the banner stays until the held save has landed");
  assert.equal(await f.h.saver.settled(), true);
  assert.deepEqual(f.server().reviewedFiles, ["a.ts"], "saved with no action from the reviewer");
  await f.poll();
  assert.equal(f.S.reach, null);
});

test("a failed save whose retry lands within three seconds shows no banner", async (t) => {
  const f = await outageFixture(t);
  f.desk.down = true;
  await f.h.approveFile("a.ts", { advance: false });
  assert.equal(await f.h.saver.settled(), false);
  f.advance(2000);
  f.desk.down = false;
  await f.poll();
  assert.equal(await f.h.saver.settled(), true);
  await f.poll();
  assert.equal(f.S.reach, null);
  assert.deepEqual(f.server().reviewedFiles, ["a.ts"]);
});

test("a desk that answers saves with an error can't save, and the tab keeps retrying", async (t) => {
  const f = await outageFixture(t);
  f.desk.failing = true;
  await f.h.approveFile("a.ts", { advance: false });
  assert.equal(await f.h.saver.settled(), false, "an error answer is not saved");
  f.advance(3000);
  await f.poll();
  await f.h.saver.settled();
  await f.poll();
  assert.deepEqual(
    plain(f.S.reach),
    { kind: "unsaved", unsaved: true },
    "not unreachable: it answers",
  );
  assert.deepEqual(f.server().reviewedFiles, []);
  await f.h.saver.settled(); // the retry that poll started, still answered with an error
  f.desk.failing = false;
  await f.poll();
  assert.equal(await f.h.saver.settled(), true);
  await f.poll();
  assert.equal(f.S.reach, null);
  assert.deepEqual(f.server().reviewedFiles, ["a.ts"]);
});

test("held changes wait out a desk restart with a changed diff, then ride onto it", async (t) => {
  const f = await outageFixture(t);
  f.desk.down = true;
  await f.h.approveFile("a.ts", { advance: false });
  assert.equal(await f.h.saver.settled(), false);
  // The desk comes back on a new diff with a new file; it remembers the one the tab is on.
  const added = { ...reviewFile, path: "b.ts", contentHash: "B" };
  f.update({
    baseDiffHash: "next",
    files: [structuredClone(reviewFile), added],
    uiProxy: { port: 41001, token: "restart" },
  });
  f.desk.down = false;
  await f.poll();
  assert.equal(f.pending.length, 0, "the changed diff waits for the held save");
  assert.equal(f.S.lastBaseDiffHash, "base");
  assert.equal(await f.h.saver.settled(), true);
  assert.deepEqual(f.server().reviewedFiles, ["a.ts"], "the desk carried the approval");
  const adopt = f.poll();
  await until(() => f.pending.length === 1);
  f.pending[0]!.release();
  await adopt;
  assert.equal(f.S.lastBaseDiffHash, "next");
  assert.deepEqual(
    f.S.state.files.map((file: { path: string }) => file.path),
    ["a.ts", "b.ts"],
  );
  assert.deepEqual(
    plain(f.S.state.reviewedFiles),
    ["a.ts"],
    "the approval is there on the new diff",
  );
});

test("a save the desk can't place says so, lands its comments, and the tab takes the desk's review", async (t) => {
  const f = await outageFixture(t);
  // The tab is on a diff older than the one before the desk's.
  f.S.state.baseDiffHash = f.S.lastBaseDiffHash = "ancient";
  f.S.state.comments = [structuredClone(reviewerComment)];
  await f.h.approveFile("a.ts", { advance: false });
  assert.equal(await f.h.saver.settled(), true);
  assert.match(f.S.toastMsg, /couldn't be carried over/);
  assert.deepEqual(f.server().reviewedFiles, [], "the desk kept its own verdicts");
  assert.deepEqual(
    f.server().comments.map((c: { id: string }) => c.id),
    ["reviewer"],
  );
  const adopt = f.poll();
  await until(() => f.pending.length === 1);
  f.pending[0]!.release();
  await adopt;
  assert.equal(f.S.lastBaseDiffHash, "base");
  assert.deepEqual(plain(f.S.state.reviewedFiles), []);
  assert.match(f.S.toastMsg, /couldn't be carried over/, "the notice stays long enough to read");
  assert.deepEqual(
    f.S.state.comments.map((c: { id: string }) => c.id),
    ["reviewer"],
  );
});

test("closing a tab asks first only while it holds unsaved changes", async (t) => {
  const f = await outageFixture(t);
  const closing = () => {
    const event = new f.win.Event("beforeunload", { cancelable: true });
    f.win.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(closing(), false);
  f.desk.down = true;
  await f.h.approveFile("a.ts", { advance: false });
  await f.h.saver.settled();
  assert.equal(closing(), true);
  f.desk.down = false;
  await f.poll();
  await f.h.saver.settled();
  assert.equal(closing(), false);
});

for (const failure of ["down", "failing"] as const) {
  test(`a Send the desk doesn't take (${failure}) keeps its dialog open with the note`, async (t) => {
    const f = await outageFixture(t);
    f.S.send = f.h.send;
    f.S.sendOpen = true;
    f.S.sendNote = "Ship it after the rename";
    f.desk[failure] = true;
    await f.h.sendConfirm();
    assert.equal(f.S.sendOpen, true);
    assert.equal(f.S.sendNote, "Ship it after the rename");
    assert.equal(f.S.sendFailed, true);
    assert.equal(f.S.awaitingAgent, false);
    f.desk[failure] = false;
    await f.h.sendConfirm();
    assert.equal(f.S.sendOpen, false);
    assert.equal(f.S.sendFailed, false);
    assert.equal(f.S.awaitingAgent, true);
    assert.equal(f.saves.at(-1).overallNote, "Ship it after the rename");
  });
}

test("an Ask whose save has not landed is marked undelivered and returns", async (t) => {
  const f = await outageFixture(t);
  f.desk.down = true;
  f.S.state.comments = [structuredClone(reviewerComment)];
  f.h.persist();
  await f.h.askComment("reviewer");
  assert.equal(f.S.undeliveredAsks.has("reviewer"), true);
  assert.match(f.S.toastMsg, /goes with the next Send/);
  assert.equal(f.asks.length, 0, "nothing asked of a desk that has no copy of the question");
  f.desk.down = false;
  await f.poll();
  assert.equal(await f.h.saver.settled(), true);
});

test("a save the desk never answers is given up after its time limit, then retried until it lands", async (t) => {
  const f = await outageFixture(t);
  // Catch the attempt's time limit, so the test can run it out without waiting.
  const originalTimeout = f.win.setTimeout.bind(f.win);
  let expire: (() => void) | undefined;
  f.win.setTimeout = ((callback: () => void, ms: number, ...args: any[]) => {
    if (ms === 25_000) expire = callback;
    return originalTimeout(callback, ms, ...args);
  }) as any;
  t.after(() => (f.win.setTimeout = originalTimeout));
  f.desk.hang = true;
  await f.h.approveFile("a.ts", { advance: false });
  const outcome = f.h.saver.settled();
  await f.poll();
  assert.ok(expire, "the attempt has a time limit");
  f.desk.hang = false;
  expire!();
  assert.equal(await outcome, false, "a hung attempt counts as failed");
  await f.poll();
  assert.equal(await f.h.saver.settled(), true, "the desk's answer retries it");
  assert.deepEqual(plain(f.server().reviewedFiles), ["a.ts"]);
});

test("a Send that lands after its dialog was cancelled leaves a newer dialog and its note alone", async (t) => {
  const f = await outageFixture(t);
  f.S.send = f.h.send;
  f.S.sendOpen = true;
  f.S.sendNote = "First note";
  let release!: () => void;
  f.desk.holdSend = new Promise<void>((resolve) => (release = resolve));
  const first = f.h.sendConfirm();
  f.h.sendCancel();
  // The reviewer opens Send again and starts a new note while the first request is out.
  f.S.sendOpen = true;
  f.S.sendNote = "Second note";
  release();
  await first;
  assert.equal(f.S.sendOpen, true, "the newer dialog stays open");
  assert.equal(f.S.sendNote, "Second note");
  assert.equal(f.S.sendFailed, false);
  assert.match(f.S.toastMsg, /sent/i, "the reviewer learns the first review went");
  assert.equal(f.saves.at(-1).overallNote, "First note");
  await f.h.sendConfirm();
  assert.equal(f.S.sendOpen, false);
  assert.equal(f.saves.at(-1).overallNote, "Second note");
});

// Two tabs open on one desk, with a.ts and b.ts in the review, each with one block.
async function twoTabs(t: Parameters<typeof fixture>[0]) {
  const a = await fixture(t);
  const b = await fixture(t, a.deskState);
  const files = ["a.ts", "b.ts"].map((path) => ({ ...structuredClone(reviewFile), path }));
  const blockB = { ...plain(a.S.state.changes[0]), id: "b-change", path: "b.ts" };
  const changes = [...plain(a.S.state.changes), blockB];
  a.update({ files: structuredClone(files), changes: structuredClone(changes) });
  for (const f of [a, b]) {
    f.S.state.files = structuredClone(files);
    f.S.state.changes = structuredClone(changes);
    f.confirm();
  }
  return { a, b };
}
const decisionsOf = (s: { decisions?: Array<{ key: string; status: string }> }) =>
  plain((s.decisions ?? []).map((d) => [d.key, d.status]));

test("tab A approves one file, older tab B another: the desk keeps both, and B then shows both", async (t) => {
  const { a, b } = await twoTabs(t);
  await a.h.approveFile("a.ts", { advance: false });
  assert.equal(await a.h.saver.settled(), true);
  assert.deepEqual(a.server().reviewedFiles, ["a.ts"]);
  // B never saw A's save.
  await b.h.approveFile("b.ts", { advance: false });
  assert.equal(await b.h.saver.settled(), true);
  assert.deepEqual(a.server().reviewedFiles, ["a.ts", "b.ts"], "the desk holds both approvals");
  assert.deepEqual(decisionsOf(a.server()), [
    ["a.ts:key", "accepted"],
    ["b.ts:key", "accepted"],
  ]);
  assert.deepEqual(plain(b.S.state.reviewedFiles), ["a.ts", "b.ts"], "B shows A's approval too");
  assert.deepEqual(decisionsOf(b.S.state), [
    ["a.ts:key", "accepted"],
    ["b.ts:key", "accepted"],
  ]);
  assert.equal(b.S.state.changes[0].status, "accepted", "A's block reads accepted in B");
});

test("a change made while a save is out survives the merged review its answer brings", async (t) => {
  const { a, b } = await twoTabs(t);
  await a.h.approveFile("a.ts", { advance: false });
  await a.h.saver.settled();
  let release!: () => void;
  b.desk.holdSave = new Promise<void>((resolve) => (release = resolve));
  await b.h.approveFile("b.ts", { advance: false });
  assert.equal(b.h.saver.inFlight(), true, "B's save is out");
  // Meanwhile, the reviewer in B rejects the block A accepted.
  await b.h.acceptChange("change", "rejected");
  release();
  assert.equal(await b.h.saver.settled(), true);
  assert.deepEqual(decisionsOf(b.S.state), [
    ["a.ts:key", "rejected"],
    ["b.ts:key", "accepted"],
  ]);
  assert.deepEqual(plain(b.S.state.reviewedFiles), ["a.ts", "b.ts"]);
  assert.deepEqual(decisionsOf(a.server()), [
    ["a.ts:key", "rejected"],
    ["b.ts:key", "accepted"],
  ]);
  assert.deepEqual(a.server().reviewedFiles, ["a.ts", "b.ts"]);
});

test("what the tab took from the desk by poll is not sent back as the reviewer's changes", async (t) => {
  const f = await outageFixture(t);
  f.S.state.annotations = [structuredClone(reviewerAnnotation)];
  f.update({ annotations: [structuredClone(reviewerAnnotation)] });
  f.confirm();
  // The agent replies to a comment and in the annotation's thread.
  const reply = (id: string) => ({ ...reviewerComment, id, role: "agent", body: "Done" });
  const annotations = structuredClone(f.server().annotations);
  annotations[0].comments.push(reply("ui-reply"));
  f.update({ comments: [...f.server().comments, reply("code-reply")], annotations });
  await f.poll();
  assert.equal(f.S.state.comments.length, 1, "the reply reached the tab");
  assert.equal(f.S.state.annotations[0].comments.length, 2);
  await f.h.approveFile("a.ts", { advance: false });
  assert.equal(await f.h.saver.settled(), true);
  const { changes } = f.saves.at(-1);
  assert.deepEqual(Object.keys(changes).sort(), [
    "decisionFiles",
    "decisions",
    "fileSignOffs",
    "signedOffBlocks",
  ]);
  assert.deepEqual(changes.fileSignOffs, { changed: [{ path: "a.ts", hash: "H" }], removed: [] });
  assert.deepEqual(
    changes.decisions.changed.map((d: { key: string }) => d.key),
    ["a.ts:key"],
  );
});

test("a save with nothing changed sends nothing and counts as landed; Send always posts", async (t) => {
  const f = await fixture(t);
  f.h.persist();
  assert.equal(await f.h.saver.settled(), true);
  assert.equal(f.saves.length, 0);
  assert.equal(f.server().saveNumber, undefined, "the save number didn't move");
  assert.equal(await f.h.send(""), true);
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.saves[0].changes, {});
  assert.equal(f.server().saveNumber, 1);
});

test("a record a merged answer brought in is the desk's, not the reviewer's, to a Send out meanwhile", async (t) => {
  const { a, b } = await twoTabs(t);
  a.update({ comments: [structuredClone(reviewerComment)] });
  for (const f of [a, b]) {
    f.S.state.comments = [structuredClone(reviewerComment)];
    f.confirm();
  }
  const edit = async (f: typeof a, body: string) => {
    f.S.state.comments[0].body = body;
    f.h.persist();
    assert.equal(await f.h.saver.settled(), true);
  };
  // Tab B edits the comment; tab A, behind, has an autosave and a Send out together.
  await edit(b, "Text A");
  let releaseSave!: () => void;
  let releaseSend!: () => void;
  a.desk.holdSave = new Promise<void>((resolve) => (releaseSave = resolve));
  a.desk.holdSend = new Promise<void>((resolve) => (releaseSend = resolve));
  await a.h.approveFile("a.ts", { advance: false });
  const sent = a.h.send("");
  // The autosave lands first, and its merged answer brings B's text into A.
  releaseSave();
  assert.equal(await a.h.saver.settled(), true);
  assert.equal(a.S.state.comments[0].body, "Text A");
  // B edits again before A's Send lands, with B's newer text in its merged answer.
  await edit(b, "Text B");
  releaseSend();
  assert.equal(await sent, true);
  assert.equal(a.S.state.comments[0].body, "Text B", "A shows B's latest text");
  // A's next save, about something else, leaves B's text alone.
  await a.h.acceptChange("b-change", "rejected");
  assert.equal(await a.h.saver.settled(), true);
  assert.equal(a.server().comments[0].body, "Text B");
  assert.equal(a.S.state.comments[0].body, "Text B");
});

// Another tab's save reaching an idle tab by itself, on the poll (Behaviors 12, 17).
const reads = (f: { requests: string[] }) => f.requests.filter((r) => r === "/api/review").length;
const addComment = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => {
  f.S.state.comments.push({ ...structuredClone(reviewerComment), id, body: `From ${id}` });
  f.h.persist();
  assert.equal(await f.h.saver.settled(), true);
};

test("tab A's save shows in idle tab B after B's next poll, with no action in B", async (t) => {
  const { a, b } = await twoTabs(t);
  await a.h.approveFile("a.ts", { advance: false });
  assert.equal(await a.h.saver.settled(), true);
  await addComment(a, "from-a");
  await b.poll();
  assert.deepEqual(plain(b.S.state.reviewedFiles), ["a.ts"], "B shows A's approval");
  assert.deepEqual(decisionsOf(b.S.state), [["a.ts:key", "accepted"]]);
  assert.equal(b.S.state.changes[0].status, "accepted", "A's block reads accepted in B");
  assert.deepEqual(
    b.S.state.comments.map((c: { id: string }) => c.id),
    ["from-a"],
  );
  assert.equal(b.saves.length, 0, "B saved nothing");
  assert.equal(reads(b), 1);
  assert.ok(!b.requests.includes("/api/state"), "B never fetched the full state for it");
  // What B took is the desk's: B's next save, about something else, carries none of it.
  await b.h.acceptChange("b-change", "rejected");
  assert.equal(await b.h.saver.settled(), true);
  assert.equal(b.saves[0].base, 2, "B's copy is at A's save number");
  assert.deepEqual(Object.keys(b.saves[0].changes).sort(), ["decisionFiles", "decisions"]);
  assert.deepEqual(a.server().reviewedFiles, ["a.ts"]);
  assert.equal(a.server().comments.length, 1);
});

test("a poll that carries the tab's own save number reads nothing", async (t) => {
  const { a, b } = await twoTabs(t);
  await a.h.approveFile("a.ts", { advance: false });
  assert.equal(await a.h.saver.settled(), true);
  await a.poll();
  await a.poll();
  assert.equal(reads(a), 0, "A's own save's answer already moved its copy");
  await b.poll();
  await b.poll();
  assert.equal(reads(b), 1, "B reads A's save once, then holds its number");
});

test("a tab holding unsaved changes doesn't take another tab's save on a poll; its own save brings it", async (t) => {
  const { a, b } = await twoTabs(t);
  await a.h.approveFile("a.ts", { advance: false });
  assert.equal(await a.h.saver.settled(), true);
  let release!: () => void;
  b.desk.holdSave = new Promise<void>((resolve) => (release = resolve));
  await b.h.approveFile("b.ts", { advance: false });
  assert.equal(b.h.saver.isBusy(), true, "B's save hasn't landed");
  await b.poll();
  assert.equal(reads(b), 0, "B read nothing while it held unsaved changes");
  assert.deepEqual(plain(b.S.state.reviewedFiles), ["b.ts"]);
  release();
  assert.equal(await b.h.saver.settled(), true);
  assert.deepEqual(plain(b.S.state.reviewedFiles), ["a.ts", "b.ts"], "the merged review");
  await b.poll();
  assert.equal(reads(b), 0, "the answer brought B to the desk's number");
});

test("another tab's save waits while a composer is open, and comes in once it closes", async (t) => {
  const { a, b } = await twoTabs(t);
  b.S.composerOpen = true;
  b.S.composerBody = "Half a thought";
  await a.h.approveFile("a.ts", { advance: false });
  await addComment(a, "from-a");
  await b.poll();
  await b.poll();
  assert.equal(reads(b), 0);
  assert.deepEqual(plain(b.S.state.comments), [], "B's threads didn't change under its composer");
  assert.deepEqual(plain(b.S.state.reviewedFiles), []);
  assert.equal(b.S.composerOpen, true, "the composer stays open");
  assert.equal(b.S.composerBody, "Half a thought");
  b.S.composerOpen = false;
  await b.poll();
  assert.deepEqual(
    b.S.state.comments.map((c: { id: string }) => c.id),
    ["from-a"],
  );
  assert.deepEqual(plain(b.S.state.reviewedFiles), ["a.ts"]);
});

test("a composer opened while the read is out cancels the take; the next poll tries again", async (t) => {
  const { a, b } = await twoTabs(t);
  await a.h.approveFile("a.ts", { advance: false });
  assert.equal(await a.h.saver.settled(), true);
  let release!: () => void;
  b.desk.holdReview = new Promise<void>((resolve) => (release = resolve));
  const poll = b.poll();
  await until(() => reads(b) === 1);
  // A second poll while the read is out doesn't read the same number again.
  await b.poll();
  assert.equal(reads(b), 1);
  b.S.composerOpen = true;
  release();
  await poll;
  assert.deepEqual(plain(b.S.state.reviewedFiles), [], "B took nothing under its composer");
  b.S.composerOpen = false;
  await b.poll();
  assert.equal(reads(b), 2);
  assert.deepEqual(plain(b.S.state.reviewedFiles), ["a.ts"]);
});

test("a reviewer change made while the read is out cancels the take; the save brings the merge", async (t) => {
  const { a, b } = await twoTabs(t);
  await a.h.approveFile("a.ts", { advance: false });
  assert.equal(await a.h.saver.settled(), true);
  let release!: () => void;
  b.desk.holdReview = new Promise<void>((resolve) => (release = resolve));
  const poll = b.poll();
  await until(() => reads(b) === 1);
  let releaseSave!: () => void;
  b.desk.holdSave = new Promise<void>((resolve) => (releaseSave = resolve));
  await b.h.acceptChange("b-change", "rejected");
  release();
  await poll;
  assert.deepEqual(decisionsOf(b.S.state), [["b.ts:key", "rejected"]], "the read was dropped");
  releaseSave();
  assert.equal(await b.h.saver.settled(), true);
  assert.deepEqual(decisionsOf(b.S.state), [
    ["a.ts:key", "accepted"],
    ["b.ts:key", "rejected"],
  ]);
});

test("another tab's save doesn't move the open file, part, cursor or scroll", async (t) => {
  const { a, b } = await twoTabs(t);
  b.S.fileIndex = 1;
  b.S.stepPart = 2;
  b.S.selected = { side: "additions", lineNumber: 7 };
  const diff = b.win.document.getElementById("diff")!;
  diff.scrollTop = 140;
  await a.h.approveFile("a.ts", { advance: false });
  assert.equal(await a.h.saver.settled(), true);
  await b.poll();
  assert.deepEqual(plain(b.S.state.reviewedFiles), ["a.ts"], "B took A's save");
  assert.equal(b.S.fileIndex, 1);
  assert.equal(b.S.stepPart, 2);
  assert.deepEqual(plain(b.S.selected), { side: "additions", lineNumber: 7 });
  assert.equal(diff.scrollTop, 140);
  assert.equal(b.S.toastMsg, "", "quiet: no toast");
});

test("taking another tab's save keeps the tab's own annotation placements", async (t) => {
  const { a, b } = await twoTabs(t);
  a.update({ annotations: [structuredClone(reviewerAnnotation)] });
  for (const f of [a, b]) {
    f.S.state.annotations = [structuredClone(reviewerAnnotation)];
    f.confirm();
  }
  // B's page found the annotation; B's report hasn't gone out yet.
  b.S.state.annotations[0].placement = "placed";
  await a.h.approveFile("a.ts", { advance: false });
  assert.equal(await a.h.saver.settled(), true);
  await b.poll();
  assert.deepEqual(plain(b.S.state.reviewedFiles), ["a.ts"]);
  assert.equal(b.S.state.annotations[0].placement, "placed", "B's own placement stays");
  b.h.persist();
  assert.equal(await b.h.saver.settled(), true);
  assert.equal(a.server().annotations[0].placement, "placed", "and goes out as B's report");
});
