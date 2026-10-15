import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewComment, UiAnnotationRecord } from "./types";
import { codeSendSummary } from "./send-derive.js";
import { openRequestList } from "./requests-derive.js";

// Each comment is a second after the one before, so an agent reply made later answers a question
// made earlier.
let seq = 0;
function comment(path: string, lineNumber: number, over: Partial<ReviewComment> = {}) {
  seq++;
  const at = new Date(Date.UTC(2026, 9, 15, 12, 0, seq)).toISOString();
  return {
    id: `c${seq}`,
    path,
    side: "additions",
    lineNumber,
    body: `comment ${seq}`,
    createdAt: at,
    updatedAt: at,
    status: "open",
    role: "user",
    intent: "action",
    ...over,
  } satisfies ReviewComment as ReviewComment;
}
const ask = (path: string, lineNumber: number, over: Partial<ReviewComment> = {}) =>
  comment(path, lineNumber, { intent: "question", ...over });
const reply = (path: string, lineNumber: number, over: Partial<ReviewComment> = {}) =>
  comment(path, lineNumber, { role: "agent", intent: "note", ...over });

test("no requests reads as none, and nothing is held back", () => {
  assert.deepEqual(codeSendSummary([], 0), { code: "No change requests", codeNotSent: "" });
});

test("one change request is singular, in one file", () => {
  assert.deepEqual(codeSendSummary([comment("a.ts", 3)], 0), {
    code: "1 change request in 1 file",
    codeNotSent: "",
  });
});

test("requests count by thread across their files, beside the question still waiting", () => {
  const comments = [
    comment("a.ts", 3),
    // A second message in the same thread, and the agent's reply to it: still one request.
    comment("a.ts", 3),
    reply("a.ts", 3),
    comment("a.ts", 9),
    comment("b.ts", 1),
    ask("b.ts", 20),
  ];
  assert.deepEqual(codeSendSummary(comments, 0), {
    code: "3 change requests in 2 files · 1 open question",
    codeNotSent: "",
  });
});

test("questions aren't change requests, until the reviewer requests one in their thread", () => {
  const comments = [
    ask("a.ts", 3),
    ask("a.ts", 7),
    reply("a.ts", 7),
    comment("a.ts", 7),
    ask("b.ts", 4),
    ask("b.ts", 4),
  ];
  assert.deepEqual(codeSendSummary(comments, 0), {
    code: "1 change request in 1 file · 2 open questions",
    codeNotSent: "",
  });
});

test("resolved threads and answered questions are held back, on the sub-line", () => {
  const comments = [
    comment("a.ts", 3, { status: "resolved" }),
    reply("a.ts", 3, { status: "resolved" }),
    ask("a.ts", 8, { status: "resolved" }),
    ask("b.ts", 5),
    reply("b.ts", 5),
    // An agent note, and a thread whose file left the diff: neither sent nor held back.
    reply("b.ts", 30),
    comment("gone.ts", 2, { status: "stale" }),
  ];
  assert.deepEqual(codeSendSummary(comments, 0), {
    code: "No change requests",
    codeNotSent: "Not sent: 2 resolved · 1 answered question",
  });
  assert.deepEqual(codeSendSummary([ask("c.ts", 1), reply("c.ts", 1), ask("c.ts", 4)], 0), {
    code: "1 open question",
    codeNotSent: "Not sent: 1 answered question",
  });
});

test("a question asked again after the agent's answer waits again", () => {
  const comments = [ask("a.ts", 3), reply("a.ts", 3), ask("a.ts", 3)];
  assert.deepEqual(codeSendSummary(comments, 0), { code: "1 open question", codeNotSent: "" });
});

test("rejected changes show only when there are some", () => {
  assert.equal(codeSendSummary([comment("a.ts", 3)], 0).code, "1 change request in 1 file");
  assert.equal(
    codeSendSummary([comment("a.ts", 3)], 1).code,
    "1 change request in 1 file · 1 rejected change",
  );
  assert.deepEqual(codeSendSummary([], 2), { code: "2 rejected changes", codeNotSent: "" });
});

test("the change requests counted are the code rows of the sidebar's Change requests list", () => {
  const comments = [
    comment("a.ts", 40),
    comment("a.ts", 40),
    comment("a.ts", 12),
    comment("a.ts", 12, { side: "deletions" }),
    comment("a.ts", 90, { unanchored: true }),
    comment("b.ts", 7, { intent: "question" }),
    comment("b.ts", 7, { intent: "note" }),
    comment("b.ts", 20, { intent: "question" }),
    comment("c.ts", 9, { status: "resolved" }),
    comment("c.ts", 15, { role: "agent", intent: "note" }),
    comment("gone.ts", 4, { status: "stale" }),
  ];
  // An app change request: the UI lane's, not counted here.
  const app: UiAnnotationRecord[] = [
    {
      id: "a1",
      number: 1,
      intent: "change",
      status: "open",
      placement: "placed",
      page: {
        url: "http://localhost:3000/",
        route: "/",
        title: "Home",
        viewport: { width: 1280, height: 800, dpr: 1 },
      },
      target: { kind: "page" },
      comments: [
        { id: "m1", role: "user", intent: "action", body: "Wider", createdAt: "t", updatedAt: "t" },
      ],
    },
  ];
  const listed = openRequestList(
    comments,
    () => ({ rank: 0 }),
    (c) => c.unanchored === true,
    app,
  ).filter((r) => r.kind === "code");
  const files = new Set(listed.map((r) => r.path)).size;
  assert.equal(listed.length, 5);
  assert.equal(
    codeSendSummary(comments, 0).code,
    `${listed.length} change requests in ${files} files · 2 open questions`,
  );
});
