import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadMessage } from "./types";
import {
  intentPill,
  lineLabel,
  messageWaiting,
  questionWaiting,
  showsHeld,
  threadKind,
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

test("the held chip shows for a change request until the review is sent", () => {
  assert.equal(showsHeld(true, false), true);
  assert.equal(showsHeld(true, true), false);
  assert.equal(showsHeld(false, false), false);
});

test("a line label names the line, or the range", () => {
  assert.equal(lineLabel(42), "L42");
  assert.equal(lineLabel(42, 45), "L42–45");
  assert.equal(lineLabel(42, 42), "L42");
});
