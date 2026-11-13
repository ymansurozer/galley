import { test } from "node:test";
import assert from "node:assert/strict";
import {
  droppedThreads,
  isOpenChange,
  signOffStand,
  threadPlace,
  threadSlot,
  topicBlockers,
  topicMark,
  topicParts,
  topicRequestList,
  topicThreadsSendLine,
} from "./topicthreads-derive";
import { topicSettled, topicsDone } from "./topics-derive";
import type { GuideStage, ThreadMessage, TopicThread } from "../types";

const topic = (id: string, flag?: string) => ({
  id,
  title: `Title ${id}`,
  recorded: "r",
  body: "b",
  covers: [],
  ...(flag ? { flag } : {}),
});
const STAGES: GuideStage[] = [
  {
    id: "s",
    label: "S",
    groups: [{ id: "g", title: "G", topics: [topic("t1"), topic("t2", "Careful")] }],
  },
];

const msg = (over: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: "m",
  role: "user",
  intent: "action",
  body: "Change it.\nMore detail.",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  ...over,
});
const thread = (id: string, topicId: string, part: string, over: Partial<TopicThread> = {}) =>
  ({
    id,
    target: { topic: topicId, part },
    title: `Title ${topicId}`,
    intent: "change",
    status: "open",
    comments: [msg({ id: `${id}-m` })],
    ...over,
  }) satisfies TopicThread;

test("a topic's parts run title, Recorded, the body's blocks by the desk's lines, then the flag", () => {
  const stamp = { blocks: [], lines: 0, coverHash: "h", bodyParts: [1, 3, 5] };
  assert.deepEqual(topicParts(topic("t1"), stamp), [
    "title",
    "recorded",
    "body:1",
    "body:3",
    "body:5",
  ]);
  assert.deepEqual(topicParts(topic("t2", "Careful"), undefined), ["title", "recorded", "flag"]);
});

test("threads on the title sit under Recorded with Recorded's own, and one on Recorded says so", () => {
  assert.equal(threadSlot("title"), "recorded");
  assert.equal(threadSlot("recorded"), "recorded");
  assert.equal(threadSlot("body:3"), "body:3");
  assert.equal(threadPlace(thread("a", "t1", "recorded")), "on Recorded");
  assert.equal(threadPlace(thread("a", "t1", "title")), "on the title");
  assert.equal(threadPlace(thread("a", "t1", "title", { moved: true })), "its part changed");
});

test("a topic with one open change request reads change requested, offers Mark Reviewed, and counts as done once marked", () => {
  const threads = [
    thread("req", "t1", "body:1"),
    thread("ask", "t1", "title", { intent: "question", comments: [msg({ intent: "question" })] }),
    thread("old", "t1", "recorded", { status: "resolved" }),
  ];
  const blockers = topicBlockers(threads, "t1");
  assert.deepEqual(
    blockers.map((t) => t.id),
    ["req"],
  );
  assert.equal(topicMark(false, blockers.length > 0), "change");
  assert.equal(signOffStand(false, blockers.length), "mark");
  // Mark Reviewed settles it with the ordinary sign-off.
  const review = {
    topics: {
      t1: { blocks: [], lines: 1, coverHash: "H1" },
      t2: { blocks: [], lines: 1, coverHash: "H2" },
    },
    settledTopics: { t1: { hash: "H1", round: 1 } },
  };
  assert.equal(topicSettled(review, "t1"), true);
  assert.deepEqual(topicsDone(STAGES, review), { done: 1, total: 2 });
  assert.equal(signOffStand(true, blockers.length), "reviewed");
  assert.equal(topicMark(true, blockers.length > 0), "change", "its mark still shows the request");
  // Resolved, the request is gone: the topic is plainly settled.
  assert.equal(signOffStand(true, 0), "settled");
  assert.equal(topicMark(true, false), "done");
  assert.equal(signOffStand(false, 0), "settle");
  assert.equal(topicMark(false, false), "todo");
});

test("a question followed by a Request change reply counts as a change request", () => {
  const t = thread("q", "t1", "title", {
    intent: "question",
    comments: [msg({ id: "q1", intent: "question" }), msg({ id: "q2", intent: "action" })],
  });
  assert.equal(isOpenChange(t), true);
});

test("topic requests list by guide order and down the page, with dropped topics last under their kept title", () => {
  const threads = [
    thread("t2-flag", "t2", "flag"),
    thread("gone", "dropped", "title", { title: "An old title" }),
    thread("t1-body", "t1", "body:9"),
    thread("t1-rec", "t1", "recorded"),
    thread("t2-title", "t2", "title", { status: "resolved" }),
  ];
  const list = topicRequestList(threads, STAGES);
  assert.deepEqual(
    list.map((r) => [r.id, r.title, r.part, r.text]),
    [
      ["t1-rec", "Title t1", "recorded", "Change it."],
      ["t1-body", "Title t1", "body:9", "Change it."],
      ["t2-flag", "Title t2", "flag", "Change it."],
      ["gone", "An old title", "title", "Change it."],
    ],
  );
});

test("the Send dialog counts topic change requests and questions still waiting", () => {
  const threads = [
    thread("a", "t1", "title"),
    thread("b", "t1", "recorded"),
    thread("q", "t1", "body:1", { intent: "question", comments: [msg({ intent: "question" })] }),
    thread("r", "t1", "flag", { status: "resolved" }),
  ];
  assert.equal(topicThreadsSendLine(threads), "2 topic change requests · 1 open topic question");
  assert.equal(topicThreadsSendLine([]), "");
});

test("the threads on topics the guide no longer has are the Overview's to show", () => {
  const threads = [
    thread("a", "t1", "title"),
    thread("b", "dropped", "recorded"),
    thread("c", "overview", "map"),
  ];
  assert.deepEqual(
    droppedThreads(threads, STAGES).map((t) => t.id),
    ["b"],
  );
});

test("the cursor visits options where their fence sits among body blocks", () => {
  assert.deepEqual(
    topicParts(topic("t1"), {
      blocks: [],
      lines: 0,
      coverHash: "h",
      bodyParts: [1, 9],
      optionsLine: 3,
      options: [{ label: "A" }, { label: "B" }],
    }),
    ["title", "recorded", "body:1", "option:1", "option:2", "body:9"],
  );
});
