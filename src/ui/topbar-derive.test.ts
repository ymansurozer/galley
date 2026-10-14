import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewComment, UiAnnotationRecord } from "./types";
import {
  agentPresence,
  deskSubtitle,
  deskTitle,
  unansweredAsks,
  type PresenceSignals,
} from "./topbar-derive.js";

const idle: PresenceSignals = {
  awaitingAgent: false,
  queuedReviews: 0,
  queuedQuestions: 0,
  activity: null,
  unansweredAsks: 0,
};
const presence = (over: Partial<PresenceSignals>) => agentPresence({ ...idle, ...over });

test("agentPresence: an idle desk shows nothing", () => {
  assert.deepEqual(presence({}), { kind: "hidden", line: "" });
});

test("agentPresence: after Send, the agent's activity line shows while it works", () => {
  assert.deepEqual(presence({ awaitingAgent: true, activity: "Fixing the reload test" }), {
    kind: "working",
    line: "Fixing the reload test",
  });
});

test("agentPresence: a Send nothing picked up is queued for a missing agent", () => {
  assert.deepEqual(presence({ awaitingAgent: true, queuedReviews: 1 }), {
    kind: "notAttached",
    line: "No agent attached — review queued",
  });
});

test("agentPresence: an unanswered ask with an active agent shows the thread's working line", () => {
  assert.deepEqual(presence({ unansweredAsks: 1, activity: "Reading state.ts" }), {
    kind: "answering",
    line: "Working · Reading state.ts",
  });
});

test("agentPresence: an unanswered ask nothing picked up is queued for a missing agent", () => {
  assert.deepEqual(presence({ unansweredAsks: 2, queuedQuestions: 1 }), {
    kind: "notAttached",
    line: "No agent attached — question queued",
  });
});

test("agentPresence: once the agent replied, its lingering activity line shows nothing", () => {
  // The reply cleared awaitingAgent (and answered the ask); the last `galley status` line lives on
  // until its TTL.
  assert.deepEqual(presence({ activity: "Done — replied on state.ts" }), {
    kind: "hidden",
    line: "",
  });
});

test("agentPresence: waiting with no activity and nothing queued shows nothing", () => {
  assert.equal(presence({ awaitingAgent: true }).kind, "hidden");
  assert.equal(presence({ unansweredAsks: 1 }).kind, "hidden");
});

test("agentPresence: a sent review speaks before an unanswered ask", () => {
  assert.deepEqual(presence({ awaitingAgent: true, queuedReviews: 1, unansweredAsks: 1 }), {
    kind: "notAttached",
    line: "No agent attached — review queued",
  });
  assert.deepEqual(presence({ awaitingAgent: true, unansweredAsks: 1, activity: "Editing" }), {
    kind: "working",
    line: "Editing",
  });
});

let seq = 0;
function comment(lineNumber: number, over: Partial<ReviewComment> = {}) {
  seq++;
  const at = new Date(Date.UTC(2026, 9, 14, 12, 0, seq)).toISOString();
  return {
    id: `c${seq}`,
    path: "a.ts",
    side: "additions",
    lineNumber,
    body: `comment ${seq}`,
    createdAt: at,
    updatedAt: at,
    status: "open",
    role: "user",
    intent: "question",
    ...over,
  } satisfies ReviewComment as ReviewComment;
}

test("unansweredAsks counts the reviewer's open asks no later agent reply in the thread answers", () => {
  const answeredAsk = comment(3);
  const reply = comment(3, { role: "agent", intent: "note" });
  const waiting = comment(9);
  const replyElsewhere = comment(10, { role: "agent", intent: "note" });
  const resolvedAsk = comment(20, { status: "resolved" });
  const staleAsk = comment(21, { status: "stale" });
  const request = comment(22, { intent: "action" });
  assert.equal(
    unansweredAsks(
      [answeredAsk, reply, waiting, replyElsewhere, resolvedAsk, staleAsk, request],
      [],
    ),
    1,
  );
});

test("unansweredAsks: an ask turned after the agent's reply is asked again", () => {
  const reply = comment(5, { role: "agent", intent: "note" });
  const turned = comment(5, { askedAt: new Date(Date.UTC(2026, 9, 14, 13)).toISOString() });
  turned.createdAt = new Date(Date.UTC(2026, 9, 14, 11)).toISOString();
  assert.equal(unansweredAsks([turned, reply], []), 1);
});

test("unansweredAsks adds the app's waiting questions", () => {
  const ask = {
    id: "m1",
    body: "Is this intentional?",
    createdAt: "2026-10-14T12:00:00.000Z",
    updatedAt: "2026-10-14T12:00:00.000Z",
    role: "user",
    intent: "question",
  } as const;
  const waiting = { status: "open", comments: [ask] } as unknown as UiAnnotationRecord;
  const replied = {
    status: "open",
    comments: [
      ask,
      { ...ask, id: "m2", role: "agent", intent: "note", createdAt: "2026-10-14T12:05:00.000Z" },
    ],
  } as unknown as UiAnnotationRecord;
  assert.equal(unansweredAsks([comment(1)], [waiting, replied]), 2);
});

const working = {
  mode: "repo",
  staged: false,
  project: "galley",
  branch: "fix/untracked-reload",
  session: "fix-untracked-reload",
  root: "/work/galley-wt",
} as const;

test("deskTitle names the branch, the pr's head branch, or the file", () => {
  assert.equal(deskTitle(working), "fix/untracked-reload");
  assert.equal(
    deskTitle({ ...working, mode: "pr", target: "feat/quota", branch: "feat/quota" }),
    "feat/quota",
  );
  assert.equal(deskTitle({ ...working, mode: "file", target: "docs/plan.md" }), "plan.md");
});

test("deskTitle falls back to the session on a detached HEAD", () => {
  assert.equal(deskTitle({ ...working, branch: undefined, session: "review" }), "review");
});

test("deskSubtitle names the project and what of it is under review", () => {
  assert.equal(deskSubtitle(working, false), "galley · uncommitted changes");
  assert.equal(deskSubtitle({ ...working, staged: true }, false), "galley · staged changes");
  assert.equal(deskSubtitle({ ...working, mode: "pr" }, false), "galley · pull request");
  assert.equal(deskSubtitle({ ...working, mode: "file" }, false), "galley · single file");
  assert.equal(deskSubtitle(working, true), "galley · app review");
});

test("deskSubtitle falls back to the root's folder for a review saved without a project", () => {
  assert.equal(
    deskSubtitle({ ...working, project: undefined }, false),
    "galley-wt · uncommitted changes",
  );
});
