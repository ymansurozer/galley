import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewComment, UiAnnotationRecord } from "./types";
import {
  openRequestList,
  requestRow,
  stepRequest,
  type OpenRequest,
  type RequestPlace,
} from "./requests-derive.js";

let seq = 0;
function comment(path: string, lineNumber: number, over: Partial<ReviewComment> = {}) {
  seq++;
  const at = new Date(Date.UTC(2026, 9, 13, 12, 0, seq)).toISOString();
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

type Message = UiAnnotationRecord["comments"][number];
const message = (body: string, over: Partial<Message> = {}): Message => ({
  id: `m${++seq}`,
  role: "user",
  intent: "action",
  body,
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

function annotation(number: number, over: Partial<UiAnnotationRecord> = {}): UiAnnotationRecord {
  return {
    id: `a${number}`,
    number,
    intent: "change",
    status: "open",
    placement: "placed",
    page: {
      url: "http://localhost:3000/files",
      route: "/files",
      title: "Files",
      viewport: { width: 1280, height: 800, dpr: 1 },
    },
    target: { kind: "page" },
    comments: [message(`Annotation ${number}`)],
    ...over,
  };
}

// Review order: b.ts, then a.ts, then c.ts (the tree's order, not the alphabet's).
const order = ["b.ts", "a.ts", "c.ts"];
const rank = (path: string) => {
  const i = order.indexOf(path);
  return i < 0 ? Infinity : i;
};
const place = (c: { path: string }) => ({ rank: rank(c.path) });
const flagged = (c: ReviewComment) => c.unanchored === true;
const where = (r: RequestPlace) =>
  r.kind === "app" ? `#${r.number}` : `${r.path}:${r.unanchored ? "strip" : r.lineNumber}`;
const list = (comments: ReviewComment[], annotations: UiAnnotationRecord[] = []) =>
  openRequestList(comments, place, flagged, annotations);

// Open change requests in three files, plus one ask, one resolved request, an agent note, a stale
// thread whose file left the diff, and an unanchored one in a.ts.
const review = [
  comment("a.ts", 40),
  comment("c.ts", 3),
  comment("a.ts", 12),
  comment("b.ts", 7, { intent: "question" }),
  comment("b.ts", 20),
  comment("c.ts", 9, { status: "resolved" }),
  comment("c.ts", 15, { role: "agent", intent: "note" }),
  comment("gone.ts", 4, { status: "stale" }),
  comment("a.ts", 90, { unanchored: true }),
];
// App annotations: open change requests #3 and #1, a question (#2), a resolved request (#4), and
// a question the reviewer followed with Request change (#5).
const app = [
  annotation(3),
  annotation(1),
  annotation(2, { intent: "question", comments: [message("Why?", { intent: "question" })] }),
  annotation(4, { status: "resolved" }),
  annotation(5, {
    intent: "question",
    comments: [
      message("Is this final?", { intent: "question" }),
      message("It is.", { role: "agent", intent: undefined }),
      message("Then rename it", { intent: "action" }),
    ],
  }),
];

test("code requests come in review order, then line, a file's strip first", () => {
  assert.deepEqual(list(review).map(where), [
    "b.ts:20",
    "a.ts:strip",
    "a.ts:12",
    "a.ts:40",
    "c.ts:3",
  ]);
});

test("app change requests follow the code ones, by number; questions and resolved stay out", () => {
  assert.deepEqual(list(review, app).map(where), [
    "b.ts:20",
    "a.ts:strip",
    "a.ts:12",
    "a.ts:40",
    "c.ts:3",
    "#1",
    "#3",
    "#5",
  ]);
  assert.deepEqual(list([], app).map(where), ["#1", "#3", "#5"]);
});

test("each request carries the first line of the message that asks for the change", () => {
  const rows = list(
    [
      comment("a.ts", 5, { intent: "question", body: "Is this needed?" }),
      comment("a.ts", 5, { body: "**Drop** it\n\nIt's dead code." }),
    ],
    app,
  );
  assert.deepEqual(
    rows.map((r) => r.text),
    ["Drop it", "Annotation 1", "Annotation 3", "Then rename it"],
  );
});

test("a thread is one request, while a reviewer's change request in it is open", () => {
  const thread = [
    // An ask the reviewer followed up with Request change counts as a change request.
    comment("a.ts", 5, { intent: "question" }),
    comment("a.ts", 5, { role: "agent", intent: "note" }),
    comment("a.ts", 5),
    // A thread the agent answered and nothing else asks a change of stays out.
    comment("a.ts", 8, { intent: "question" }),
    comment("a.ts", 8, { role: "agent", intent: "note" }),
  ];
  assert.deepEqual(list(thread).map(where), ["a.ts:5"]);
});

test("a thread sits in the strip when any of its comments lost its anchor", () => {
  const thread = [comment("a.ts", 5), comment("a.ts", 5, { role: "agent", unanchored: true })];
  assert.deepEqual(list(thread).map(where), ["a.ts:strip"]);
});

test("a file outside the review order (a preview) comes after it, by path", () => {
  const rows = list([comment("z.md", 1), comment("c.ts", 2), comment("m.md", 1)]);
  assert.deepEqual(rows.map(where), ["c.ts:2", "m.md:1", "z.md:1"]);
});

test("the same line on both sides: the deleted line first", () => {
  const rows = list([comment("a.ts", 5), comment("a.ts", 5, { side: "deletions" })]);
  assert.deepEqual(
    rows.map((r) => r.kind === "code" && r.side),
    ["deletions", "additions"],
  );
});

test("a row names its place: file:line, file · lost in the strip, #n for the app", () => {
  const rows = list(
    [comment("src/a.ts", 12), comment("src/b.ts", 4, { unanchored: true })],
    [annotation(2)],
  ).map(requestRow);
  assert.deepEqual(
    rows.map((r) => r.loc),
    ["a.ts:12", "b.ts · lost", "#2"],
  );
  assert.equal(new Set(rows.map((r) => r.key)).size, 3);
});

test("a split file's requests come by the step each is attributed to", () => {
  // a.ts is split: lines past 30 belong to a part that comes after c.ts in review order.
  const byStep = (c: { path: string; lineNumber: number }) => ({
    rank: c.path === "a.ts" && c.lineNumber > 30 ? 3 : rank(c.path),
  });
  assert.deepEqual(openRequestList(review, byStep, flagged, []).map(where), [
    "b.ts:20",
    "a.ts:12",
    "c.ts:3",
    "a.ts:strip",
    "a.ts:40",
  ]);
});

const requests = list(review, app);
const at = (path: string, lineNumber: number, unanchored = false): RequestPlace => ({
  kind: "code",
  path,
  side: "additions",
  lineNumber,
  unanchored,
  rank: rank(path),
});
const atApp = (number: number): RequestPlace => ({ kind: "app", number });
const step = (from: RequestPlace | null, dir: 1 | -1) => {
  const s = stepRequest(requests, from, dir);
  return s && `${where(s.request)}${s.wrapped ? " (wrapped)" : ""}`;
};

test("] visits every request once, code then app, then wraps", () => {
  const seen: string[] = [];
  let from: OpenRequest | null = null;
  for (let i = 0; i < requests.length + 1; i++) {
    const s = stepRequest(requests, from, 1)!;
    seen.push(`${where(s.request)}${s.wrapped ? " (wrapped)" : ""}`);
    from = s.request;
  }
  assert.deepEqual(seen, [
    "b.ts:20",
    "a.ts:strip",
    "a.ts:12",
    "a.ts:40",
    "c.ts:3",
    "#1",
    "#3",
    "#5",
    "b.ts:20 (wrapped)",
  ]);
});

test("[ walks the same requests in reverse, wrapping off the first onto the last app one", () => {
  assert.equal(step(requests[0]!, -1), "#5 (wrapped)");
  assert.equal(step(atApp(1), -1), "c.ts:3");
  assert.equal(step(at("c.ts", 3), -1), "a.ts:40");
  assert.equal(step(at("a.ts", 12), -1), "a.ts:strip");
  assert.equal(step(at("a.ts", 90, true), -1), "b.ts:20");
});

test("from a line between code requests, ] and [ take the nearest on either side", () => {
  assert.equal(step(at("a.ts", 20), 1), "a.ts:40");
  assert.equal(step(at("a.ts", 20), -1), "a.ts:12");
  // The top of a file (before its strip) steps into the strip, or back to the file before.
  assert.equal(step(at("a.ts", 0, true), 1), "a.ts:strip");
  assert.equal(step(at("a.ts", 0, true), -1), "b.ts:20");
  // A file with no requests steps to the next file that has one.
  assert.equal(step(at("b.ts", 99), 1), "a.ts:strip");
  // Past the last code request, ] crosses into the app's.
  assert.equal(step(at("c.ts", 50), 1), "#1");
});

test("from an annotation between app requests (a question), ] and [ take the nearest", () => {
  assert.equal(step(atApp(2), 1), "#3");
  assert.equal(step(atApp(2), -1), "#1");
  // The app with nothing selected sits before its first request, after the code's last.
  assert.equal(step(atApp(0), 1), "#1");
  assert.equal(step(atApp(0), -1), "c.ts:3");
  // Past the last app request, ] wraps to the first code one.
  assert.equal(step(atApp(9), 1), "b.ts:20 (wrapped)");
});

test("with no place to step from, ] starts at the first request and [ at the last", () => {
  assert.equal(step(null, 1), "b.ts:20");
  assert.equal(step(null, -1), "#5");
});

test("a lone request wraps onto itself; no requests, no step", () => {
  const one = list([], [annotation(7)]);
  assert.deepEqual(stepRequest(one, one[0]!, 1), { request: one[0], wrapped: true });
  assert.equal(stepRequest([], null, 1), null);
});
