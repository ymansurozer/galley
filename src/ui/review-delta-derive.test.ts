import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeReviewerSave } from "../state.js";
import type {
  ChangeState,
  Decision,
  ReviewComment,
  ReviewState,
  ReviewerSave,
  UiAnnotationRecord,
} from "../types.js";
import {
  applyReviewerChanges,
  noChanges,
  reviewerChanges,
  stampDecisions,
  unionChanges,
} from "./review-delta-derive.js";

const decision = (key: string, status: Decision["status"] = "accepted"): Decision => ({
  key,
  status,
  reviewedHash: `h-${key}`,
  path: key.split(":")[0]!,
  lineNumber: 1,
  side: "additions",
  title: "",
});
const comment = (id: string, body = "Body", over: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  path: "a.ts",
  side: "additions",
  lineNumber: 1,
  body,
  createdAt: "t",
  updatedAt: "t",
  status: "open",
  role: "user",
  ...over,
});
const annotation = (id: string, over: Partial<UiAnnotationRecord> = {}): UiAnnotationRecord => ({
  id,
  number: 1,
  intent: "change",
  status: "open",
  placement: "unvisited",
  page: { url: "http://localhost:3000/", route: "/", viewport: { width: 1, height: 1, dpr: 1 } },
  target: { kind: "page" },
  comments: [{ id: `${id}-m`, role: "user", body: "Fix", createdAt: "t", updatedAt: "t" }],
  ...over,
});
const review = (over: Partial<ReviewerSave> = {}): ReviewerSave => ({
  decisions: [decision("a.ts:k1"), decision("a.ts:k2", "rejected")],
  comments: [comment("c1"), comment("c2")],
  reviewedFiles: ["a.ts", "b.ts"],
  reviewedFileHashes: { "a.ts": "A1", "b.ts": "B1" },
  signedOffBlocks: { "a.ts:k1": "h1", "a.ts:k2": "h2" },
  settledTopics: { t1: { hash: "T1", round: 1 }, t2: { hash: "T2", round: 1 } },
  decisionFiles: ["a.ts"],
  annotations: [annotation("p1"), annotation("p2", { number: 2 })],
  lastAnnotationNumber: 2,
  ...over,
});

test("reviewerChanges: nothing changed is no change at all", () => {
  const changes = reviewerChanges(review(), review());
  assert.deepEqual(changes, {});
  assert.equal(noChanges(changes), true);
});

test("reviewerChanges: a collection's records keep no matter the order of their keys", () => {
  const base = review();
  const now = review({
    decisions: [
      {
        title: "",
        side: "additions",
        lineNumber: 1,
        path: "a.ts",
        reviewedHash: "h-a.ts:k1",
        status: "accepted",
        key: "a.ts:k1",
      },
      decision("a.ts:k2", "rejected"),
    ],
  });
  assert.deepEqual(reviewerChanges(base, now), {});
});

test("reviewerChanges: each collection's changed, added and removed records, by key", () => {
  const base = review();
  const now = review({
    decisions: [decision("a.ts:k1", "rejected"), decision("c.ts:k9")],
    comments: [comment("c1", "Edited"), comment("c3")],
    reviewedFiles: ["a.ts", "c.ts"],
    reviewedFileHashes: { "a.ts": "A2", "c.ts": "C1" },
    signedOffBlocks: { "a.ts:k1": "h1", "c.ts:k9": "h9" },
    settledTopics: { t1: { hash: "T1", round: 1 }, t3: { hash: "T3", round: 2 } },
    decisionFiles: ["c.ts"],
    annotations: [annotation("p1", { status: "resolved" }), annotation("p3", { number: 3 })],
    lastAnnotationNumber: 3,
  });
  assert.deepEqual(reviewerChanges(base, now), {
    decisions: {
      changed: [decision("a.ts:k1", "rejected"), decision("c.ts:k9")],
      removed: ["a.ts:k2"],
    },
    comments: { changed: [comment("c1", "Edited"), comment("c3")], removed: ["c2"] },
    fileSignOffs: {
      changed: [
        { path: "a.ts", hash: "A2" },
        { path: "c.ts", hash: "C1" },
      ],
      removed: ["b.ts"],
    },
    signedOffBlocks: { changed: [{ key: "c.ts:k9", hash: "h9" }], removed: ["a.ts:k2"] },
    settledTopics: { changed: [{ id: "t3", hash: "T3", round: 2 }], removed: ["t2"] },
    decisionFiles: { changed: ["c.ts"], removed: ["a.ts"] },
    annotations: {
      changed: [annotation("p1", { status: "resolved" }), annotation("p3", { number: 3 })],
      removed: ["p2"],
    },
    lastAnnotationNumber: 3,
  });
});

test("reviewerChanges: a file sign-off with no hash is a record of its own", () => {
  const changes = reviewerChanges(
    review({ reviewedFiles: [], reviewedFileHashes: {} }),
    review({ reviewedFiles: ["new.ts"], reviewedFileHashes: {} }),
  );
  assert.deepEqual(changes, { fileSignOffs: { changed: [{ path: "new.ts" }], removed: [] } });
});

test("reviewerChanges: what the page reports goes as a report, never as the whole annotation", () => {
  const base = review({
    annotations: [annotation("p1"), annotation("p2", { screenshotCapture: "requested" })],
  });
  const now = review({
    annotations: [
      annotation("p1", { placement: "placed" }),
      annotation("p2", { screenshotCapture: "failed" }),
    ],
  });
  assert.deepEqual(reviewerChanges(base, now), {
    annotationReports: [
      { id: "p1", placement: "placed" },
      { id: "p2", screenshotCapture: "failed" },
    ],
  });
});

test("reviewerChanges: the reviewer's edit sends the whole annotation, its placement with it", () => {
  const edited = annotation("p1", { placement: "placed", status: "resolved" });
  const changes = reviewerChanges(
    review(),
    review({ annotations: [edited, annotation("p2", { number: 2 })] }),
  );
  assert.deepEqual(changes, { annotations: { changed: [edited], removed: [] } });
});

test("reviewerChanges: stored screenshots are the desk's to say, so they are no change", () => {
  const changes = reviewerChanges(
    review(),
    review({
      annotations: [annotation("p1", { screenshots: true }), annotation("p2", { number: 2 })],
    }),
  );
  assert.deepEqual(changes, {});
});

test("reviewerChanges: the annotation number goes only up", () => {
  assert.deepEqual(reviewerChanges(review(), review({ lastAnnotationNumber: 1 })), {});
  assert.deepEqual(reviewerChanges(review(), review({ lastAnnotationNumber: 5 })), {
    lastAnnotationNumber: 5,
  });
});

test("reviewerChanges: the records it carries are copies, not the tab's own", () => {
  const now = review({ comments: [comment("c1", "Edited"), comment("c2")] });
  const changes = reviewerChanges(review(), now);
  now.comments[0]!.body = "Edited again";
  assert.equal(changes.comments!.changed[0]!.body, "Edited");
});

test("applyReviewerChanges: applying a difference to its base gives the changed review back", () => {
  const base = review();
  const now = review({
    decisions: [decision("a.ts:k1", "rejected"), decision("c.ts:k9")],
    comments: [comment("c1", "Edited"), comment("c3")],
    reviewedFiles: ["a.ts", "c.ts"],
    reviewedFileHashes: { "a.ts": "A2", "c.ts": "C1" },
    signedOffBlocks: { "a.ts:k1": "h1", "c.ts:k9": "h9" },
    settledTopics: { t1: { hash: "T1", round: 1 }, t3: { hash: "T3", round: 2 } },
    decisionFiles: ["c.ts"],
    annotations: [
      annotation("p1", { status: "resolved", placement: "placed" }),
      annotation("p3", { number: 3 }),
    ],
    lastAnnotationNumber: 3,
  });
  assert.deepEqual(applyReviewerChanges(base, reviewerChanges(base, now)), now);
  const reported = review({
    annotations: [annotation("p1", { placement: "unplaced" }), annotation("p2", { number: 2 })],
  });
  assert.deepEqual(applyReviewerChanges(base, reviewerChanges(base, reported)), reported);
});

test("applyReviewerChanges: onto a newer copy, the changes replace their records and keep the rest", () => {
  // The tab's copy was review(); another tab since signed off d.ts and added comment c9.
  const newer = review({
    comments: [comment("c1"), comment("c2"), comment("c9", "Other tab")],
    reviewedFiles: ["a.ts", "b.ts", "d.ts"],
    reviewedFileHashes: { "a.ts": "A1", "b.ts": "B1", "d.ts": "D1" },
  });
  const merged = applyReviewerChanges(newer, {
    comments: { changed: [comment("c1", "Mine")], removed: ["c2", "gone"] },
    fileSignOffs: { changed: [{ path: "e.ts", hash: "E1" }], removed: ["a.ts"] },
    annotationReports: [
      { id: "p2", placement: "placed" },
      { id: "missing", placement: "placed" },
    ],
  });
  assert.deepEqual(
    merged.comments.map((c) => [c.id, c.body]),
    [
      ["c1", "Mine"],
      ["c9", "Other tab"],
    ],
  );
  assert.deepEqual(merged.reviewedFiles, ["b.ts", "d.ts", "e.ts"]);
  assert.deepEqual(merged.reviewedFileHashes, { "b.ts": "B1", "d.ts": "D1", "e.ts": "E1" });
  assert.deepEqual(
    merged.annotations!.map((a) => [a.id, a.placement]),
    [
      ["p1", "unvisited"],
      ["p2", "placed"],
    ],
  );
  assert.equal(newer.comments.length, 3, "the copy it was given is untouched");
});

test("unionChanges: a key a doubtful save touched gets the current truth, its removal included", () => {
  const confirmed = review();
  // A save the desk may have taken added c3 and signed off c.ts; the reviewer then deleted c3 and
  // rejected a.ts:k1.
  const doubtful = review({
    comments: [comment("c1"), comment("c2"), comment("c3")],
    reviewedFiles: ["a.ts", "b.ts", "c.ts"],
    reviewedFileHashes: { "a.ts": "A1", "b.ts": "B1", "c.ts": "C1" },
  });
  const now = review({
    decisions: [decision("a.ts:k1", "rejected"), decision("a.ts:k2", "rejected")],
    reviewedFiles: ["a.ts", "b.ts", "c.ts"],
    reviewedFileHashes: { "a.ts": "A1", "b.ts": "B1", "c.ts": "C1" },
  });
  assert.deepEqual(
    unionChanges([reviewerChanges(confirmed, now), reviewerChanges(doubtful, now)]),
    {
      decisions: { changed: [decision("a.ts:k1", "rejected")], removed: [] },
      comments: { changed: [], removed: ["c3"] },
      fileSignOffs: { changed: [{ path: "c.ts", hash: "C1" }], removed: [] },
    },
  );
});

test("unionChanges: a key in several differences goes once", () => {
  const now = review({
    comments: [comment("c1", "Edited"), comment("c2")],
    decisionFiles: [],
    lastAnnotationNumber: 4,
  });
  const older = review({ comments: [comment("c1", "Older"), comment("c2"), comment("c4")] });
  const union = unionChanges([reviewerChanges(review(), now), reviewerChanges(older, now)]);
  assert.deepEqual(union.comments, { changed: [comment("c1", "Edited")], removed: ["c4"] });
  assert.deepEqual(union.decisionFiles, { changed: [], removed: ["a.ts"] });
  assert.equal(union.lastAnnotationNumber, 4);
});

test("unionChanges: an annotation sent whole carries its placement, so no report goes beside it", () => {
  const now = review({
    annotations: [
      annotation("p1", { status: "resolved", placement: "placed" }),
      annotation("p2", { number: 2, placement: "unplaced", screenshotCapture: "failed" }),
    ],
  });
  const edited = review({
    annotations: [
      annotation("p1", { status: "resolved" }),
      annotation("p2", { number: 2, screenshotCapture: "requested" }),
    ],
  });
  const before = review({
    annotations: [
      annotation("p1"),
      annotation("p2", { number: 2, placement: "unplaced", screenshotCapture: "requested" }),
    ],
  });
  const union = unionChanges([reviewerChanges(before, now), reviewerChanges(edited, now)]);
  assert.deepEqual(union.annotations, { changed: [now.annotations![0]], removed: [] });
  assert.deepEqual(union.annotationReports, [
    { id: "p2", placement: "unplaced", screenshotCapture: "failed" },
  ]);
});

test("unionChanges: no differences, or empty ones, are no change", () => {
  assert.deepEqual(unionChanges([]), {});
  assert.equal(noChanges(unionChanges([{}, reviewerChanges(review(), review())])), true);
});

test("stampDecisions: each block takes its decision's status, pending where it has none", () => {
  const block = (stableKey: string): ChangeState => ({
    id: `a.ts:${stableKey}`,
    path: "a.ts",
    stableKey,
    hunkIndex: 0,
    side: "additions",
    lineNumber: 1,
    title: "",
    status: "accepted",
    reviewedHash: "old",
  });
  const blocks = [block("k1"), block("k3")];
  stampDecisions(blocks, [decision("a.ts:k1", "rejected")]);
  assert.deepEqual(
    blocks.map((c) => [c.id, c.status, c.reviewedHash]),
    [
      ["a.ts:k1", "rejected", "h-a.ts:k1"],
      ["a.ts:k3", "pending", undefined],
    ],
  );
});

// The two worlds share no runtime code: this holds the tab's difference to the shape the desk
// applies, so neither can drift from the other unnoticed.
test("the tab's changes, applied by the desk, give the desk the tab's work on top of its own", async () => {
  const confirmed = review({ annotations: [], lastAnnotationNumber: 0 });
  const desk = {
    id: "id",
    session: "s",
    root: "/r",
    repoHash: "h",
    mode: "repo",
    staged: false,
    head: null,
    baseDiffHash: "base",
    createdAt: "t",
    rawDiff: "",
    files: [],
    changes: [],
    stagedFiles: [],
    saveNumber: 4,
    ...structuredClone(confirmed),
    // Since the tab's copy, another tab signed off d.ts and the agent replied.
    reviewedFiles: ["a.ts", "b.ts", "d.ts"],
    reviewedFileHashes: { "a.ts": "A1", "b.ts": "B1", "d.ts": "D1" },
  } as ReviewState;
  desk.comments.push(comment("reply", "Done", { role: "agent" }));
  const tab = structuredClone(confirmed);
  tab.decisions = [decision("a.ts:k1", "rejected"), decision("a.ts:k2", "rejected")];
  tab.comments = [comment("c1", "Edited")];
  tab.reviewedFiles = ["a.ts", "b.ts", "c.ts"];
  tab.reviewedFileHashes = { "a.ts": "A1", "b.ts": "B1", "c.ts": "C1" };
  tab.decisionFiles = ["a.ts", "c.ts"];
  const outcome = await mergeReviewerSave(desk, {
    base: 3,
    changes: reviewerChanges(confirmed, tab),
    seen: { token: null, reloadGeneration: 0, baseDiffHash: "base" },
  });
  assert.deepEqual(
    desk.decisions!.map((d) => [d.key, d.status]),
    [
      ["a.ts:k1", "rejected"],
      ["a.ts:k2", "rejected"],
    ],
  );
  assert.deepEqual(
    desk.comments.map((c) => [c.id, c.body]),
    [
      ["c1", "Edited"],
      ["reply", "Done"],
    ],
  );
  assert.deepEqual(desk.reviewedFiles, ["a.ts", "b.ts", "d.ts", "c.ts"]);
  assert.deepEqual(desk.reviewedFileHashes, {
    "a.ts": "A1",
    "b.ts": "B1",
    "d.ts": "D1",
    "c.ts": "C1",
  });
  assert.deepEqual(desk.decisionFiles, ["a.ts", "c.ts"]);
  assert.equal(outcome.saveNumber, 5);
  assert.deepEqual(outcome.merged?.reviewedFiles, ["a.ts", "b.ts", "d.ts", "c.ts"]);
});
