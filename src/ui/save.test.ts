import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createSaver, reviewerSlice } from "./save";
import type { ReviewState } from "./types";

test("reviewerSlice carries only reviewer-owned fields — no rawDiff, no file contents", () => {
  // A full state with the heavy server-owned fields the save must NOT ship.
  const full = {
    id: "id",
    session: "s",
    root: "/r",
    repoHash: "h",
    mode: "repo",
    staged: false,
    head: null,
    baseDiffHash: "base",
    createdAt: "t",
    rawDiff: "diff --git a/a.ts …\n(huge)\n",
    files: [{ path: "a.ts", hunks: [], contentHash: "H", changeKind: "modified" }],
    comments: [],
    changes: [
      {
        id: "a.ts:k1",
        hunkIndex: 0,
        side: "additions",
        lineNumber: 1,
        title: "",
        status: "pending",
        stableKey: "k1",
        contentHash: "H",
      },
    ],
    reviewedFiles: ["a.ts"],
    reviewedFileHashes: { "a.ts": "H" },
    signedOffBlocks: { "a.ts:k1": "H" },
    stagedFiles: ["a.ts"],
    stagedChangeKeys: ["a.ts:k1"],
    decisionFiles: ["a.ts"],
    decisions: [
      {
        key: "a.ts:k1",
        status: "accepted" as const,
        path: "a.ts",
        lineNumber: 1,
        side: "additions" as const,
        title: "",
      },
    ],
  } as unknown as ReviewState;

  const slice = reviewerSlice(full);
  assert.deepEqual(Object.keys(slice).sort(), [
    "annotations",
    "comments",
    "decisionFiles",
    "decisions",
    "lastAnnotationNumber",
    "reviewedFileHashes",
    "reviewedFiles",
    "settledTopics",
    "signedOffBlocks",
  ]);
  // The heavy/server-owned fields are absent from the wire.
  const wire = slice as Record<string, unknown>;
  assert.equal("rawDiff" in wire, false);
  assert.equal("files" in wire, false);
  assert.equal("changes" in wire, false);
  assert.equal("stagedFiles" in wire, false);
  assert.equal("stagedChangeKeys" in wire, false);
  assert.equal("topics" in wire, false, "the desk's topic stamps are its own");
  // The serialized body carries none of the heavy server-owned state.
  const body = JSON.stringify(slice);
  assert.equal(body.includes("diff --git"), false);
});

// Drain the microtask queue (settling a send takes several ticks): a macrotask flushes everything
// queued before it. setImmediate, since the backoff tests mock setTimeout.
const flush = () => new Promise((r) => setImmediate(r));

// A controllable fake send: each call parks a deferred so the test drives when the save
// "completes", and records the payload it was handed at send time. resolve() is a save the desk
// took; answer(false) is the desk answering with an error; reject() is no answer at all.
function fakeSend<T>() {
  const calls: {
    payload: T;
    resolve: () => void;
    answer: (landed: boolean) => void;
    reject: () => void;
  }[] = [];
  const send = (payload: T) =>
    new Promise<boolean>((resolve, reject) => {
      calls.push({
        payload,
        resolve: () => resolve(true),
        answer: (landed) => resolve(landed),
        reject: () => reject(new Error("x")),
      });
    });
  return { send, calls };
}

test("createSaver sends immediately when idle", () => {
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  saver.trigger();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.payload, 1);
  assert.equal(saver.isBusy(), true);
});

test("createSaver coalesces N rapid triggers into one in-flight + one trailing send", async () => {
  const { send, calls } = fakeSend<number>();
  let payload = 0;
  const saver = createSaver(() => payload, send);

  payload = 1;
  saver.trigger(); // sends immediately (payload 1)
  payload = 2;
  saver.trigger(); // queued
  payload = 3;
  saver.trigger(); // collapses into the same single trailing save
  payload = 4;
  saver.trigger();

  assert.equal(calls.length, 1, "only one save in flight");
  assert.equal(calls[0]!.payload, 1);
  assert.equal(saver.isBusy(), true);

  // Complete the in-flight save → exactly one trailing save fires, snapshotting the LATEST
  // payload at send time (4), not the value when any intermediate trigger was requested.
  calls[0]!.resolve();
  await flush();
  assert.equal(calls.length, 2, "one trailing save");
  assert.equal(calls[1]!.payload, 4, "trailing save snapshots fresh payload at send time");
  assert.equal(saver.isBusy(), true);

  // Nothing was requested while the trailing save ran → it drains and goes quiet.
  calls[1]!.resolve();
  await flush();
  assert.equal(calls.length, 2, "no further saves");
  assert.equal(saver.isBusy(), false);
});

test("createSaver: a rejected in-flight save still drains the trailing save", async () => {
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 9, send);
  saver.trigger();
  saver.trigger(); // trailing queued

  calls[0]!.reject(); // in-flight save fails
  await flush();

  assert.equal(calls.length, 2, "trailing save is not stranded by the failure");

  calls[1]!.resolve();
  await flush();
  assert.equal(saver.isBusy(), false);
});

test("createSaver: a failed save stays unsaved and retries on a 1, 2, 4, then 5 second backoff", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const { send, calls } = fakeSend<number>();
  let payload = 1;
  const saver = createSaver(() => payload, send);
  saver.trigger();
  calls[0]!.reject();
  await flush();
  assert.equal(saver.unsaved(), true);
  assert.equal(saver.isBusy(), true, "the poll's guards hold the tab's review");
  for (const [n, wait] of [
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 5000],
    [5, 5000],
  ] as const) {
    mock.timers.tick(wait - 1);
    assert.equal(calls.length, n, `no retry before ${wait} ms`);
    payload = n + 1;
    mock.timers.tick(1);
    assert.equal(calls.length, n + 1, `retry ${n} after ${wait} ms`);
    assert.equal(calls[n]!.payload, n + 1, "a retry snapshots the latest state");
    calls[n]!.reject();
    await flush();
  }
  mock.timers.tick(5000);
  calls[6]!.resolve();
  await flush();
  assert.equal(saver.unsaved(), false);
  assert.equal(saver.isBusy(), false);
  mock.timers.tick(60_000);
  assert.equal(calls.length, 7, "a landed save stops the retries");
});

test("createSaver: an error answer from the desk counts as not saved", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  saver.trigger();
  calls[0]!.answer(false);
  await flush();
  assert.equal(saver.unsaved(), true);
  mock.timers.tick(1000);
  assert.equal(calls.length, 2, "retried as a failure");
});

test("createSaver: failingSince marks the first failure of a streak until a save lands", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  t.after(() => mock.timers.reset());
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  assert.equal(saver.failingSince(), null);
  saver.trigger();
  calls[0]!.reject();
  await flush();
  assert.equal(saver.failingSince(), 10_000);
  mock.timers.tick(1000);
  calls[1]!.reject();
  await flush();
  assert.equal(saver.failingSince(), 10_000, "a later failure keeps the streak's start");
  mock.timers.tick(2000);
  calls[2]!.resolve();
  await flush();
  assert.equal(saver.failingSince(), null);
});

test("createSaver: a reviewer change while unsaved saves at once; a successful poll retries at once", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  saver.trigger();
  calls[0]!.reject();
  await flush();
  saver.trigger();
  assert.equal(calls.length, 2, "the change did not wait for the backoff");
  calls[1]!.reject();
  await flush();
  saver.retryNow();
  assert.equal(calls.length, 3, "retryNow skips the backoff");
  saver.retryNow();
  assert.equal(calls.length, 3, "never a second save in flight");
  calls[2]!.resolve();
  await flush();
  saver.retryNow();
  assert.equal(calls.length, 3, "nothing to retry once saved");
  mock.timers.tick(10_000);
  assert.equal(calls.length, 3, "the cancelled backoff never fires");
});

test("createSaver: settled reports whether the save landed and never waits through an outage", async (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  assert.equal(await saver.settled(), true, "nothing out: landed");
  saver.trigger();
  saver.trigger();
  const outcome = saver.settled();
  calls[0]!.resolve();
  await flush();
  calls[1]!.reject();
  assert.equal(await outcome, false, "the trailing save failed");
  assert.equal(await saver.settled(), false, "unsaved while the backoff waits: at once");
  mock.timers.tick(1000);
  const retried = saver.settled();
  calls[2]!.resolve();
  assert.equal(await retried, true);
});

test("createSaver: a trigger after quiescence starts a fresh send", async () => {
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  saver.trigger();
  calls[0]!.resolve();
  await flush();
  assert.equal(saver.isBusy(), false);

  saver.trigger();
  assert.equal(calls.length, 2);
  assert.equal(saver.isBusy(), true);
});

test("createSaver: settled resolves once the in-flight and trailing saves are done", async () => {
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  await saver.settled(); // nothing out: at once

  saver.trigger();
  saver.trigger(); // trailing queued
  let settled = false;
  void saver.settled().then(() => (settled = true));
  calls[0]!.resolve();
  await flush();
  assert.equal(settled, false, "the trailing save is still out");

  calls[1]!.reject(); // a failed save still settles, as not landed
  await flush();
  assert.equal(settled, true);
});

test("createSaver: triggerSoon coalesces a burst into one save a second later, and isn't busy meanwhile", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { send, calls } = fakeSend<number>();
  let payload = 0;
  const saver = createSaver(() => payload, send);

  // A page flipping placements as fast as it can.
  for (payload = 1; payload <= 50; payload++) saver.triggerSoon();
  assert.equal(calls.length, 0, "nothing goes at once");
  assert.equal(saver.isBusy(), false, "a waiting save never holds off the poll");
  mock.timers.tick(999);
  assert.equal(calls.length, 0);
  mock.timers.tick(1);
  assert.equal(calls.length, 1, "one save for the whole burst");
  assert.equal(calls[0]!.payload, 51, "snapshotting the latest state");

  // The next burst waits its own second: at most one such save a second.
  saver.triggerSoon();
  mock.timers.tick(999);
  assert.equal(calls.length, 1);
});

test("createSaver: a reviewer's trigger saves at once and takes a waiting triggerSoon with it", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  saver.triggerSoon();
  saver.trigger();
  assert.equal(calls.length, 1, "the reviewer's save went at once");
  mock.timers.tick(1000);
  assert.equal(calls.length, 1, "the waiting save went with it");
});

test("save generations retain completed, failed and coalesced activity after the saver is idle", async () => {
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  const before = saver.generation();
  saver.trigger();
  const started = saver.generation();
  assert.ok(started > before);
  saver.trigger();
  const coalesced = saver.generation();
  assert.ok(coalesced > started, "a mutation queued behind a save also invalidates snapshots");
  calls[0]!.resolve();
  await flush();
  calls[1]!.reject();
  await saver.settled();
  const failed = saver.generation();
  saver.retryNow(); // the failed save lands on its retry
  calls[2]!.resolve();
  await saver.settled();
  assert.equal(saver.isBusy(), false);
  assert.ok(failed > before, "a drained or failed save cannot erase its history");
  assert.equal(saver.generation(), failed, "a retry is not new reviewer activity");
  const idle = saver.generation();
  await saver.settled();
  assert.equal(saver.generation(), idle, "reads and idle waiting do not invent activity");
});

test("deferred save generations advance at mutation request time and when delayed work dispatches", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { send, calls } = fakeSend<number>();
  const saver = createSaver(() => 1, send);
  const before = saver.generation();
  saver.triggerSoon();
  const scheduled = saver.generation();
  assert.ok(scheduled > before, "a snapshot is invalid before any deferred wire work starts");
  assert.equal(calls.length, 0);
  assert.equal(saver.isBusy(), false, "scheduling still does not claim a save is in flight");
  saver.triggerSoon();
  const coalesced = saver.generation();
  assert.ok(coalesced > scheduled);
  mock.timers.tick(999);
  assert.equal(saver.generation(), coalesced);
  mock.timers.tick(1);
  assert.equal(calls.length, 1);
  assert.ok(saver.generation() > coalesced, "dispatch invalidates snapshots begun while deferred");
  calls[0]!.resolve();
  await saver.settled();
  assert.equal(saver.isBusy(), false);
  assert.ok(saver.generation() > before);
});
