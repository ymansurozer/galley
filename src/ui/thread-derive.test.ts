import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadMessage } from "./types";
import { lineLabel, questionWaiting, showsHeld, threadKind } from "./thread-derive.js";

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

test("the held band shows for a change request until the review is sent", () => {
  assert.equal(showsHeld(true, false), true);
  assert.equal(showsHeld(true, true), false);
  assert.equal(showsHeld(false, false), false);
});

test("a line label names the line, or the range", () => {
  assert.equal(lineLabel(42), "L42");
  assert.equal(lineLabel(42, 45), "L42–45");
  assert.equal(lineLabel(42, 42), "L42");
});
