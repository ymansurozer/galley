import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadMessage } from "./types";
import { agentPresence } from "./topbar-derive.js";
import {
  cardLoc,
  intentPill,
  lineLabel,
  messageWaiting,
  pendingAnswer,
  questionWaiting,
  recordActivity,
  showsHeld,
  threadKind,
  trailSteps,
  type TrailEntry,
} from "./thread-derive.js";

let seq = 0;
const msg = (over: Partial<ThreadMessage> = {}): ThreadMessage => {
  seq++;
  const at = new Date(Date.UTC(2026, 9, 14, 12, 0, seq)).toISOString();
  return {
    id: `m${seq}`,
    body: `message ${seq}`,
    createdAt: at,
    updatedAt: at,
    role: "user",
    ...over,
  };
};

test("a thread's kind: change request, question, note, agent note, resolved", () => {
  const open = "open" as const;
  assert.equal(threadKind(open, [msg({ intent: "action" })]), "change");
  assert.equal(threadKind(open, [msg({ intent: "question" })]), "question");
  // An ask the reviewer followed with Request change is a change request.
  assert.equal(
    threadKind(open, [msg({ intent: "question" }), msg({ intent: "action" })]),
    "change",
  );
  // A reviewer's note, and a thread only the agent spoke in.
  assert.equal(threadKind(open, [msg({ intent: "note" })]), "note");
  assert.equal(threadKind(open, [msg({ role: "agent", intent: "note" })]), "agent");
  assert.equal(threadKind("resolved", [msg({ intent: "action" })]), "resolved");
  // An agent reply reopened a resolved change request: it's still a change request.
  assert.equal(threadKind(open, [msg({ intent: "action" }), msg({ role: "agent" })]), "change");
});

test("a question waits until an agent reply lands after it was asked", () => {
  const ask = msg({ intent: "question" });
  assert.equal(questionWaiting([ask]), true);
  assert.equal(questionWaiting([ask, msg({ role: "agent" })]), false);
  // Turned into a question after the agent's reply: asked again, so waiting again.
  const reply = msg({ role: "agent" });
  const turned = msg({
    intent: "question",
    askedAt: new Date(Date.UTC(2026, 9, 14, 13)).toISOString(),
  });
  assert.equal(questionWaiting([turned, reply]), true);
  assert.equal(questionWaiting([msg({ intent: "action" })]), false);
});

test("each question waits on its own: an earlier answer doesn't answer a later ask", () => {
  // The reviewer's mixed thread: a change request, a Request change reply, an Ask reply.
  const thread = [
    msg({ intent: "action" }),
    msg({ intent: "action" }),
    msg({ intent: "question" }),
  ];
  assert.deepEqual(
    thread.map((m) => messageWaiting(m, thread)),
    [false, false, true],
  );
  const answeredThread = [...thread, msg({ role: "agent" })];
  assert.deepEqual(
    answeredThread.map((m) => messageWaiting(m, answeredThread)),
    [false, false, false, false],
  );
  // Asked again after the agent's answer: only the later ask waits.
  const first = msg({ intent: "question" });
  const later = [first, msg({ role: "agent" }), msg({ intent: "question" })];
  assert.deepEqual(
    later.map((m) => messageWaiting(m, later)),
    [false, false, true],
  );
  assert.equal(questionWaiting(later), true);
});

test("a message wears its intent where the thread's kind doesn't say it", () => {
  const pills = (kind: ReturnType<typeof threadKind>, thread: ThreadMessage[]) =>
    thread.map((m, i) => intentPill(m, i, kind));
  // The reviewer's case: the opener is the change request the header names; the Request change
  // reply and the Ask reply both say what they are.
  assert.deepEqual(
    pills("change", [
      msg({ intent: "action" }),
      msg({ intent: "action" }),
      msg({ intent: "question" }),
    ]),
    [null, "change", "question"],
  );
  // One-intent threads stay bare: a lone change request, a question and its follow-up.
  assert.deepEqual(pills("change", [msg({ intent: "action" })]), [null]);
  assert.deepEqual(
    pills("question", [
      msg({ intent: "question" }),
      msg({ role: "agent" }),
      msg({ intent: "question" }),
    ]),
    [null, null, null],
  );
  // An ask the reviewer followed with Request change: a change request opened by a question.
  assert.deepEqual(pills("change", [msg({ intent: "question" }), msg({ intent: "action" })]), [
    "question",
    "change",
  ]);
  // Notes and the agent's messages carry none.
  assert.deepEqual(pills("note", [msg({ intent: "note" })]), [null]);
  assert.deepEqual(
    pills("change", [msg({ intent: "action" }), msg({ role: "agent", intent: "question" })]),
    [null, null],
  );
  // A resolved card's header no longer names the kind, so its opener says it.
  assert.deepEqual(pills("resolved", [msg({ intent: "action" })]), ["change"]);
});

// Times on one day, by second: the tab's clock (seenAt, ask stamps) and the desk's (`at`).
const t = (sec: number) => new Date(Date.UTC(2026, 9, 14, 12, 0, sec)).toISOString();
const entry = (body: string, at: number, seenAt: number): TrailEntry => ({
  body,
  at: t(at),
  seenAt: t(seenAt),
});

test("the trail records each new status line once, stamped when the tab first saw it", () => {
  const one = recordActivity([], { body: "Reading quota.ts", at: t(1) }, t(2));
  assert.deepEqual(one, [entry("Reading quota.ts", 1, 2)]);
  // Every poll delivers the same line again until the agent posts another.
  assert.equal(recordActivity(one, { body: "Reading quota.ts", at: t(1) }, t(4)), one);
  const two = recordActivity(one, { body: "Tracing the reset", at: t(5) }, t(6));
  assert.deepEqual(two, [entry("Reading quota.ts", 1, 2), entry("Tracing the reset", 5, 6)]);
});

test("a reposted line is no new step, but counts as said again", () => {
  const trail = [entry("Reading quota.ts", 1, 2)];
  assert.deepEqual(recordActivity(trail, { body: "Reading quota.ts", at: t(30) }, t(31)), [
    entry("Reading quota.ts", 30, 31),
  ]);
});

test("a line said again after another is its own step", () => {
  let trail: readonly TrailEntry[] = [];
  for (const [body, sec] of [
    ["Reading quota.ts", 1],
    ["Running the tests", 3],
    ["Reading quota.ts", 5],
  ] as const)
    trail = recordActivity(trail, { body, at: t(sec) }, t(sec + 1));
  assert.deepEqual(
    trail.map((e) => e.body),
    ["Reading quota.ts", "Running the tests", "Reading quota.ts"],
  );
});

test("no line, or one cleared or gone stale, leaves the trail as it is", () => {
  const trail = [entry("Reading quota.ts", 1, 2)];
  assert.equal(recordActivity(trail, null, t(9)), trail);
  assert.deepEqual(recordActivity([], null, t(9)), []);
});

test("the trail keeps the newest 8 lines", () => {
  let trail: readonly TrailEntry[] = [];
  for (let i = 1; i <= 10; i++)
    trail = recordActivity(trail, { body: `step ${i}`, at: t(i) }, t(i));
  assert.deepEqual(
    trail.map((e) => e.body),
    ["step 3", "step 4", "step 5", "step 6", "step 7", "step 8", "step 9", "step 10"],
  );
});

test("a question shows the steps the tab saw from its ask on, oldest first, the newest live", () => {
  const trail = [
    entry("Reviewing the diff", 1, 2),
    entry("Reading quota.ts", 9, 10),
    entry("Tracing the reset", 14, 15),
  ];
  assert.deepEqual(trailSteps(trail, t(10), "Tracing the reset"), [
    { body: "Reading quota.ts", live: false },
    { body: "Tracing the reset", live: true },
  ]);
  assert.deepEqual(trailSteps(trail, t(20), "Tracing the reset"), []);
});

test("once the agent's line goes stale, its steps stay but none is live", () => {
  const trail = [entry("Reading quota.ts", 9, 10), entry("Tracing the reset", 14, 15)];
  assert.deepEqual(trailSteps(trail, t(10), null), [
    { body: "Reading quota.ts", live: false },
    { body: "Tracing the reset", live: false },
  ]);
});

test("a question's steps are timed on the tab's clock, never the desk's", () => {
  // The desk's clock runs a minute behind the tab's: the line was posted after the ask all the same.
  assert.deepEqual(trailSteps([entry("Reading quota.ts", -50, 12)], t(10), "Reading quota.ts"), [
    { body: "Reading quota.ts", live: true },
  ]);
  // And a minute ahead: the line the tab saw before the ask is still from before it.
  assert.deepEqual(
    trailSteps([entry("Reviewing the diff", 70, 8)], t(10), "Reviewing the diff"),
    [],
  );
});

test("a question waiting on the agent: thinking with its steps, or queued in the top bar's words", () => {
  const idle = { awaitingAgent: false, queuedReviews: 0, queuedQuestions: 0, activity: null };
  const trail = [entry("Reviewing the diff", 1, 2), entry("Reading quota.ts", 11, 12)];
  // Delivered, and the agent hasn't said what it's doing yet.
  assert.deepEqual(pendingAnswer(idle, [], t(10)), {
    queued: false,
    label: "Thinking…",
    steps: [],
  });
  assert.deepEqual(pendingAnswer({ ...idle, activity: "Reading quota.ts" }, trail, t(10)), {
    queued: false,
    label: "Thinking…",
    steps: [{ body: "Reading quota.ts", live: true }],
  });
  // The agent went quiet (its line went stale): still thinking, its steps kept, none live.
  assert.deepEqual(pendingAnswer(idle, trail, t(10)), {
    queued: false,
    label: "Thinking…",
    steps: [{ body: "Reading quota.ts", live: false }],
  });
  // Nothing picked the question up: no steps, whatever the trail holds.
  assert.deepEqual(pendingAnswer({ ...idle, queuedQuestions: 1 }, trail, t(10)), {
    queued: true,
    label: "No agent attached — question queued",
    steps: [],
  });
  // Sent with no agent attached: the review sits queued, and the question says so as the top bar
  // does.
  const sent = { ...idle, awaitingAgent: true, queuedReviews: 1 };
  assert.deepEqual(pendingAnswer(sent, trail, t(10)), {
    queued: true,
    label: "No agent attached — review queued",
    steps: [],
  });
  assert.equal(
    pendingAnswer(sent, trail, t(10)).label,
    agentPresence({ ...sent, unansweredAsks: 1 }).line,
  );
  // Sent, and the agent is on it.
  assert.equal(
    pendingAnswer({ ...idle, awaitingAgent: true, activity: "Editing quota.ts" }, trail, t(10))
      .label,
    "Thinking…",
  );
});

test("the held chip shows for a change request until the review is sent", () => {
  assert.equal(showsHeld(true, false), true);
  assert.equal(showsHeld(true, true), false);
  assert.equal(showsHeld(false, false), false);
});

test("a card names its line only where its place doesn't say it", () => {
  // Under its own line, a one-line thread needs no label.
  assert.equal(cardLoc(34, undefined, false), null);
  assert.equal(cardLoc(34, 34, false), null);
  // It sits under a range's last line, so the range is named.
  assert.equal(cardLoc(42, 45, false), "L42–45");
  // A lost thread keeps the line it had (struck through where it renders).
  assert.equal(cardLoc(34, undefined, true), "L34");
});

test("a line label names the line, or the range", () => {
  assert.equal(lineLabel(42), "L42");
  assert.equal(lineLabel(42, 45), "L42–45");
  assert.equal(lineLabel(42, 42), "L42");
});
