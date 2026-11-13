import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildReviewResult,
  computeOpenQuestions,
  loadLatestReview,
  mergeReviewerSave,
  mergeReviewState,
  persistReview,
} from "./state.js";
import { bodyBlocks, carryTopicThreads, replyToTopicThread } from "./topicthreads.js";
import type { Guide, GuideTopic, ReviewState, ThreadMessage, TopicThread } from "./types.js";

function state(over: Partial<ReviewState>): ReviewState {
  return {
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
    comments: [],
    changes: [],
    reviewedFiles: [],
    stagedFiles: [],
    ...over,
  };
}

const topic = (id: string, over: Partial<GuideTopic> = {}): GuideTopic => ({
  id,
  title: `Title of ${id}`,
  recorded: `Recorded for ${id}`,
  body: "Para one.\n\nPara two.",
  covers: [],
  ...over,
});
const guideOf = (...topics: GuideTopic[]): Guide => ({
  overview: "o",
  stages: [{ id: "s", label: "S", groups: [{ id: "g", title: "G", topics }] }],
});

const message = (over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: "m1",
  role: "user",
  intent: "action",
  body: "Please change this.",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  ...over,
});
// A thread as the tab sends it: the part it names, no title or quote (the desk sets those).
const sent = (id: string, topicId: string, part: string, over: Partial<TopicThread> = {}) =>
  ({
    id,
    target: { topic: topicId, part },
    title: "",
    intent: "change",
    status: "open",
    comments: [message({ id: `${id}-m` })],
    ...over,
  }) satisfies TopicThread;

const seen = { token: null, reloadGeneration: 0, baseDiffHash: "base" };
const save = (live: ReviewState, base: number, threads: TopicThread[], removed: string[] = []) =>
  mergeReviewerSave(live, { base, changes: { topicThreads: { changed: threads, removed } }, seen });

test("a body's parts are its top-level blocks and the items of its top-level lists", () => {
  const body = [
    "Intro para.", // 1
    "",
    "- one", // 3
    "- two", // 4
    "  - nested", // 5
    "- three", // 6
    "",
    "| a | b |", // 8
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```ts", // 12
    "const x = 1;",
    "```",
    "",
    "```mermaid", // 16
    "graph TD; A-->B",
    "```",
    "",
    "---",
    "",
    "1. first", // 22
  ].join("\n");
  assert.deepEqual(bodyBlocks(body), [
    { line: 1, text: "Intro para." },
    { line: 3, text: "- one" },
    { line: 4, text: "- two\n  - nested" },
    { line: 6, text: "- three" },
    { line: 8, text: "| a | b |\n|---|---|\n| 1 | 2 |" },
    { line: 12, text: "```ts\nconst x = 1;\n```" },
    { line: 16, text: "```mermaid\ngraph TD; A-->B\n```" },
    { line: 22, text: "1. first" },
  ]);
});

test("a new thread takes its title and quote from the desk's guide, and keeps them after", async () => {
  const live = state({ guide: guideOf(topic("t1")) });
  await save(live, 0, [sent("a", "t1", "body:3"), sent("b", "t1", "recorded")]);
  assert.deepEqual(
    live.topicThreads!.map((t) => [t.target.part, t.title, t.quote]),
    [
      ["body:3", "Title of t1", "Para two."],
      ["recorded", "Title of t1", "Recorded for t1"],
    ],
  );
  // A later save of the same thread can't move it or rewrite what it quotes.
  await save(live, 1, [{ ...sent("a", "t1", "body:1"), title: "x", quote: "y" }]);
  assert.deepEqual(live.topicThreads![0]!.target, { topic: "t1", part: "body:3" });
  assert.equal(live.topicThreads![0]!.quote, "Para two.");
  // A part the topic doesn't have puts the thread on the title.
  await save(live, 2, [sent("c", "t1", "body:9")]);
  assert.deepEqual(live.topicThreads![2]!.target, { topic: "t1", part: "title" });
});

test("a thread saved from one tab and another from a tab that is behind both land, and a restart keeps them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "galley-topic-threads-"));
  try {
    const live = state({ root, session: "threads", guide: guideOf(topic("t1"), topic("t2")) });
    await save(live, 0, [sent("a", "t1", "title")]);
    assert.equal(live.saveNumber, 1);
    // An agent reply lands between the tabs' saves.
    replyToTopicThread(live, "a", "Done.", "2026-11-13T11:00:00.000Z");
    // Tab B confirmed save 0: it has never seen thread a, nor the reply.
    const outcome = await save(live, 0, [sent("b", "t2", "recorded", { intent: "question" })]);
    assert.deepEqual(
      live.topicThreads!.map((t) => t.id),
      ["a", "b"],
    );
    assert.deepEqual(outcome.merged?.topicThreads, live.topicThreads, "B was behind: it gets both");
    // Tab A resolves its thread from a copy without the reply: the reply stays.
    await save(live, 2, [{ ...sent("a", "t1", "title"), status: "resolved" }]);
    assert.deepEqual(
      live.topicThreads![0]!.comments.map((m) => m.body),
      ["Please change this.", "Done."],
    );
    // A stop and a restart keep them.
    await persistReview(live);
    const restarted = await mergeReviewState(
      state({ root, session: "threads" }),
      await loadLatestReview(root, "threads"),
    );
    assert.deepEqual(restarted.topicThreads, live.topicThreads);
    // Removing a thread removes only it.
    await save(live, 3, [], ["a"]);
    assert.deepEqual(
      live.topicThreads!.map((t) => t.id),
      ["b"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a thread on a body block follows it down; once the block is gone it moves to the title", async () => {
  const body = ["Para one.", "", "Para two.", "", "- item a", "- item b"].join("\n");
  const live = state({ guide: guideOf(topic("t1", { body })) });
  await save(live, 0, [sent("p", "t1", "body:3"), sent("i", "t1", "body:6")]);
  assert.deepEqual(
    live.topicThreads!.map((t) => t.quote),
    ["Para two.", "- item b"],
  );
  // Two lines are added above both blocks.
  const shifted = ["Para one.", "", "New para.", "", "Para two.", "", "- item a", "- item b"];
  live.guide = guideOf(topic("t1", { body: shifted.join("\n") }));
  carryTopicThreads(live);
  assert.deepEqual(
    live.topicThreads!.map((t) => [t.target.part, t.moved]),
    [
      ["body:5", undefined],
      ["body:8", undefined],
    ],
  );
  // "Para two." is deleted.
  live.guide = guideOf(topic("t1", { body: ["Para one.", "", "- item a", "- item b"].join("\n") }));
  carryTopicThreads(live);
  assert.deepEqual(live.topicThreads![0]!.target, { topic: "t1", part: "title" });
  assert.equal(live.topicThreads![0]!.moved, true);
  assert.equal(live.topicThreads![0]!.quote, "Para two.", "it still quotes what it was on");
  assert.deepEqual(live.topicThreads![1]!.target, { topic: "t1", part: "body:4" });
  // Where the text is there twice, the one nearer the old line wins.
  live.guide = guideOf(
    topic("t1", { body: ["- item b", "", "Para one.", "", "- item b"].join("\n") }),
  );
  carryTopicThreads(live);
  assert.deepEqual(live.topicThreads![1]!.target, { topic: "t1", part: "body:5" });
});

test("a new guide that drops a topic keeps its open change request and drops its question", async () => {
  const live = state({ guide: guideOf(topic("t1"), topic("gone")) });
  await save(live, 0, [
    sent("req", "gone", "recorded"),
    sent("ask", "gone", "title", {
      intent: "question",
      comments: [message({ intent: "question" })],
    }),
    sent("done", "gone", "title", { status: "resolved" }),
    sent("kept", "t1", "flag"),
  ]);
  live.guide = guideOf(topic("t1", { flag: "Watch this." }));
  carryTopicThreads(live);
  assert.deepEqual(
    live.topicThreads!.map((t) => [t.id, t.title]),
    [
      ["req", "Title of gone"],
      ["kept", "Title of t1"],
    ],
  );
  assert.deepEqual(
    buildReviewResult(live, { resultJson: "r", sessionDir: "d" }).topicChangeRequests.map((r) => [
      r.id,
      r.topic,
    ]),
    [
      ["kept", "t1"],
      ["req", "gone"],
    ],
    "the dropped topic's request still goes, after the guide's own",
  );
});

test("the result carries open topic change requests with their part and quote; questions go as questions", async () => {
  const live = state({ guide: guideOf(topic("t1")) });
  await save(live, 0, [
    sent("rec", "t1", "recorded", { comments: [message({ body: "Write it down in an ADR." })] }),
    sent("res", "t1", "title", { status: "resolved" }),
    sent("ask", "t1", "body:1", {
      intent: "question",
      comments: [message({ id: "q1", intent: "question", body: "Why two paras?" })],
    }),
  ]);
  const result = buildReviewResult(live, { resultJson: "r", sessionDir: "d" });
  assert.deepEqual(result.topicChangeRequests, [
    {
      id: "rec",
      topic: "t1",
      part: "recorded",
      quote: "Recorded for t1",
      body: "Write it down in an ADR.",
    },
  ]);
  assert.deepEqual(result.openQuestions, [
    {
      lane: "topic",
      id: "ask",
      topic: "t1",
      part: "body:1",
      quote: "Para one.",
      body: "Why two paras?",
      mode: "repo",
      session: "s",
    },
  ]);
  // Answered, it is no longer open.
  replyToTopicThread(live, "ask", "Because.", "2026-11-13T12:00:00.000Z");
  assert.deepEqual(computeOpenQuestions(live), []);
});

test("option picks survive saves, follow labels and reach the result with their label", async () => {
  const body = '```options\n[{"label":"A","ships":true},{"label":"B"}]\n```';
  const live = state({ guide: guideOf(topic("t1", { body })) });
  await save(live, 0, [
    sent("pick", "t1", "option:2", { option: "B", comments: [message({ body: "Use: B" })] }),
  ]);
  assert.equal(live.topicThreads![0]!.quote, "B");
  assert.deepEqual(
    buildReviewResult(live, { resultJson: "r", sessionDir: "d" }).topicChangeRequests,
    [{ id: "pick", topic: "t1", part: "option:2", quote: "B", body: "Use: B", option: "B" }],
  );
  live.guide = guideOf(
    topic("t1", {
      body: body.replace(
        '[{"label":"A","ships":true},{"label":"B"}]',
        '[{"label":"B"},{"label":"A","ships":true}]',
      ),
    }),
  );
  carryTopicThreads(live);
  assert.equal(live.topicThreads![0]!.target.part, "option:1");
  live.guide = guideOf(topic("t1"));
  carryTopicThreads(live);
  assert.equal(live.topicThreads![0]!.target.part, "title");
  assert.equal(live.topicThreads![0]!.moved, true);
});

test("a reply pick carries the latest picked option through save and result", async () => {
  const live = state({ guide: guideOf(topic("t1")) });
  await save(live, 0, [
    sent("reply-pick", "t1", "title", {
      intent: "question",
      comments: [
        message({ intent: "question", body: "Alternatives?" }),
        message({
          id: "agent",
          role: "agent",
          intent: "note",
          body: '```options\n[{"label":"A"},{"label":"B"}]\n```',
        }),
        message({ id: "pickA", option: "A", body: "Use: A" }),
        message({ id: "pickB", option: "B", body: "Use: B" }),
      ],
    }),
  ]);
  const result = buildReviewResult(live, { resultJson: "r", sessionDir: "d" });
  assert.equal(result.topicChangeRequests[0]!.option, "B");
  assert.equal(result.topicChangeRequests[0]!.body, "Use: B");
});
