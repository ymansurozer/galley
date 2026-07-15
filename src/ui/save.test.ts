import { test } from "node:test";
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
    "comments",
    "decisionFiles",
    "decisions",
    "reviewedFileHashes",
    "reviewedFiles",
  ]);
  // The heavy/server-owned fields are absent from the wire.
  const wire = slice as Record<string, unknown>;
  assert.equal("rawDiff" in wire, false);
  assert.equal("files" in wire, false);
  assert.equal("changes" in wire, false);
  assert.equal("stagedFiles" in wire, false);
  assert.equal("stagedChangeKeys" in wire, false);
  // The serialized body carries none of the heavy server-owned state.
  const body = JSON.stringify(slice);
  assert.equal(body.includes("diff --git"), false);
});

// Drain the microtask queue (the send chain is send().catch().finally(), so settling
// takes several ticks) — a real timer flushes everything queued before it.
const flush = () => new Promise((r) => setTimeout(r, 0));

// A controllable fake send: each call parks a deferred so the test drives when the save
// "completes", and records the payload it was handed at send time.
function fakeSend<T>() {
  const calls: { payload: T; resolve: () => void; reject: () => void }[] = [];
  const send = (payload: T) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ payload, resolve: () => resolve(), reject: () => reject(new Error("x")) });
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
