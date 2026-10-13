import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewComment } from "./types";
import {
  openRequestCount,
  requestStops,
  stepRequest,
  type RequestStop,
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

// Review order: b.ts, then a.ts, then c.ts (the tree's order, not the alphabet's).
const order = ["b.ts", "a.ts", "c.ts"];
const rank = (path: string) => {
  const i = order.indexOf(path);
  return i < 0 ? Infinity : i;
};
const flagged = (c: ReviewComment) => c.unanchored === true;
const where = (s: RequestStop) => `${s.path}:${s.unanchored ? "strip" : s.lineNumber}`;

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

test("requestStops walks open change requests in review order, then line, the strip first", () => {
  assert.deepEqual(requestStops(review, rank, flagged).map(where), [
    "b.ts:20",
    "a.ts:strip",
    "a.ts:12",
    "a.ts:40",
    "c.ts:3",
  ]);
});

test("a thread is one stop, and counts while a reviewer's change request in it is open", () => {
  const thread = [
    // An ask the reviewer followed up with Request change counts as a change request.
    comment("a.ts", 5, { intent: "question" }),
    comment("a.ts", 5, { role: "agent", intent: "note" }),
    comment("a.ts", 5),
    // A thread the agent answered and nothing else asks a change of stays out.
    comment("a.ts", 8, { intent: "question" }),
    comment("a.ts", 8, { role: "agent", intent: "note" }),
  ];
  assert.deepEqual(requestStops(thread, rank, flagged).map(where), ["a.ts:5"]);
  assert.equal(openRequestCount(thread), 1);
});

test("a thread sits in the strip when any of its comments lost its anchor", () => {
  const thread = [comment("a.ts", 5), comment("a.ts", 5, { role: "agent", unanchored: true })];
  assert.deepEqual(requestStops(thread, rank, flagged).map(where), ["a.ts:strip"]);
});

test("a file outside the review order (a preview) comes after it, by path", () => {
  const stops = requestStops(
    [comment("z.md", 1), comment("c.ts", 2), comment("m.md", 1)],
    rank,
    flagged,
  );
  assert.deepEqual(stops.map(where), ["c.ts:2", "m.md:1", "z.md:1"]);
});

test("the same line on both sides: the deleted line first", () => {
  const stops = requestStops(
    [comment("a.ts", 5), comment("a.ts", 5, { side: "deletions" })],
    rank,
    flagged,
  );
  assert.deepEqual(
    stops.map((s) => s.side),
    ["deletions", "additions"],
  );
});

test("openRequestCount counts the walk's stops", () => {
  assert.equal(openRequestCount(review), 5);
  assert.equal(openRequestCount([]), 0);
});

const stops = requestStops(review, rank, flagged);
const at = (path: string, lineNumber: number, unanchored = false): RequestStop => ({
  path,
  side: "additions",
  lineNumber,
  unanchored,
});
const step = (from: RequestStop | null, dir: 1 | -1) => {
  const s = stepRequest(stops, rank, from, dir);
  return s && `${where(s.stop)}${s.wrapped ? " (wrapped)" : ""}`;
};

test("] visits every stop once, in order, then wraps", () => {
  const seen: string[] = [];
  let from: RequestStop | null = null;
  for (let i = 0; i < stops.length + 1; i++) {
    const s = stepRequest(stops, rank, from, 1)!;
    seen.push(`${where(s.stop)}${s.wrapped ? " (wrapped)" : ""}`);
    from = s.stop;
  }
  assert.deepEqual(seen, [
    "b.ts:20",
    "a.ts:strip",
    "a.ts:12",
    "a.ts:40",
    "c.ts:3",
    "b.ts:20 (wrapped)",
  ]);
});

test("[ walks the same stops in reverse, wrapping off the first", () => {
  assert.equal(step(stops[0]!, -1), "c.ts:3 (wrapped)");
  assert.equal(step(at("c.ts", 3), -1), "a.ts:40");
  assert.equal(step(at("a.ts", 12), -1), "a.ts:strip");
  assert.equal(step(at("a.ts", 90, true), -1), "b.ts:20");
});

test("from a line between stops, ] and [ take the nearest on either side", () => {
  assert.equal(step(at("a.ts", 20), 1), "a.ts:40");
  assert.equal(step(at("a.ts", 20), -1), "a.ts:12");
  // The top of a file (before its strip) steps into the strip, or back to the file before.
  assert.equal(step(at("a.ts", 0, true), 1), "a.ts:strip");
  assert.equal(step(at("a.ts", 0, true), -1), "b.ts:20");
  // A file with no requests steps to the next file that has one.
  assert.equal(step(at("b.ts", 99), 1), "a.ts:strip");
});

test("with no place to step from, ] starts at the first stop and [ at the last", () => {
  assert.equal(step(null, 1), "b.ts:20");
  assert.equal(step(null, -1), "c.ts:3");
});

test("a lone stop wraps onto itself; no stops, no step", () => {
  const one = [at("a.ts", 3)];
  assert.deepEqual(stepRequest(one, rank, one[0]!, 1), { stop: one[0], wrapped: true });
  assert.equal(stepRequest([], rank, null, 1), null);
});
