import { test } from "node:test";
import assert from "node:assert/strict";
import {
  droppedThreads,
  isOpenChange,
  mapTarget,
  overviewChip,
  overviewParts,
  overviewPlace,
  overviewSlot,
  overviewStops,
  overviewTints,
  partQuote,
  signOffStand,
  threadPlace,
  threadSlot,
  topicBlockers,
  topicMark,
  topicParts,
  topicRequestList,
  topicHeldBack,
  topicSendParts,
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

// The desk's list of a body's blocks, by these lines.
const parts = (...lines: number[]) => lines.map((line) => ({ line, text: `Block at ${line}.` }));

test("a topic's parts run title, Recorded, the body's blocks by the desk's lines, then the flag", () => {
  const stamp = { blocks: [], lines: 0, coverHash: "h", bodyParts: parts(1, 3, 5) };
  assert.deepEqual(topicParts(topic("t1"), stamp), [
    "title",
    "recorded",
    "body:1",
    "body:3",
    "body:5",
  ]);
  assert.deepEqual(topicParts(topic("t2", "Careful"), undefined), ["title", "recorded", "flag"]);
  // A line block's lines sit where its fence does, among the body's blocks.
  assert.deepEqual(
    topicParts(topic("t3", "Careful"), stamp, [
      { fence: 4, parts: ["line:deletions:10:a.ts", "line:additions:10:a.ts"] },
    ]),
    [
      "title",
      "recorded",
      "body:1",
      "body:3",
      "line:deletions:10:a.ts",
      "line:additions:10:a.ts",
      "body:5",
      "flag",
    ],
  );
});

test("a topic's parts run in page order: body blocks, options and a line block's lines by source line", () => {
  // Body: a paragraph (1), the lines fence (3), a paragraph (7), the options fence (9), a list item (14).
  const stamp = {
    blocks: [],
    lines: 0,
    coverHash: "h",
    bodyParts: parts(1, 7, 14),
    options: [{ label: "Keep" }, { label: "Drop" }],
    optionsLine: 9,
  };
  assert.deepEqual(
    topicParts(topic("t4", "Careful"), stamp, [
      { fence: 3, parts: ["line:deletions:10:a.ts", "line:additions:10:a.ts"] },
    ]),
    [
      "title",
      "recorded",
      "body:1",
      "line:deletions:10:a.ts",
      "line:additions:10:a.ts",
      "body:7",
      "option:1",
      "option:2",
      "body:14",
      "flag",
    ],
  );
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

test("the Send dialog counts topic change requests and questions still waiting, in the other lanes' words", () => {
  const threads = [
    thread("a", "t1", "title"),
    thread("b", "t1", "recorded"),
    thread("q", "t1", "body:1", { intent: "question", comments: [msg({ intent: "question" })] }),
    thread("r", "t1", "flag", { status: "resolved" }),
  ];
  assert.deepEqual(topicSendParts(threads), [
    "2 change requests on 1 topic",
    "1 open question on 1 topic",
  ]);
  assert.deepEqual(topicSendParts([]), []);
  // The Overview is named as itself, beside the topics.
  assert.deepEqual(
    topicSendParts([
      thread("o1", "overview", "coverage"),
      thread("o2", "overview", "group:g"),
      ...threads,
      thread("c", "t2", "flag"),
    ]),
    ["5 change requests on 2 topics and the Overview", "1 open question on 1 topic"],
  );
  assert.deepEqual(
    topicSendParts([thread("o1", "overview", "coverage"), thread("o2", "overview", "map")]),
    ["2 change requests on the Overview"],
  );
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
      bodyParts: parts(1, 9),
      optionsLine: 3,
      options: [{ label: "A" }, { label: "B" }],
    }),
    ["title", "recorded", "body:1", "option:1", "option:2", "body:9"],
  );
});

// ── The Overview ─────────────────────────────────────────────────────────────────────────────────

const MAP_STAGES: GuideStage[] = [
  {
    id: "back",
    label: "Back",
    groups: [
      { id: "api", title: "API", topics: [topic("t1")] },
      { id: "a>b", title: "Odd id", topics: [topic("t2")] },
    ],
  },
  { id: "front", label: "Front", groups: [{ id: "ui", title: "UI", topics: [topic("t3")] }] },
];
const LINKS = [
  { from: "api", to: "a>b", label: "writes" },
  { from: "a>b", to: "ui", label: "serves" },
];

test("the Overview's parts are the summary, the map, each box and link, and coverage; j / k stop at three", () => {
  const parts = overviewParts(MAP_STAGES, LINKS, { map: true, coverage: true });
  assert.deepEqual(parts, [
    "summary",
    "map",
    "group:api",
    "group:a>b",
    "group:ui",
    "link:api>a>b",
    "link:a>b>ui",
    "coverage",
  ]);
  assert.deepEqual(overviewStops(parts), ["summary", "map", "coverage"]);
  // No map drawn (under three groups), no boxes or links to point at; no coverage card, no stop.
  assert.deepEqual(overviewParts(MAP_STAGES, LINKS, { map: false, coverage: false }), ["summary"]);
});

test("threads on the map, a box or a link sit under the map, each chip naming the box or the link's groups", () => {
  assert.equal(overviewSlot("summary"), "summary");
  assert.equal(overviewSlot("coverage"), "coverage");
  assert.equal(overviewSlot("map"), "map");
  assert.equal(overviewSlot("group:api"), "map");
  assert.equal(overviewSlot("link:api>a>b"), "map");
  const chip = (part: string, over: Partial<TopicThread> = {}) =>
    overviewChip(thread("x", "overview", part, over), MAP_STAGES, LINKS);
  assert.equal(chip("summary"), null);
  assert.equal(chip("coverage"), null);
  assert.equal(chip("map"), "The map");
  assert.equal(chip("group:a>b"), "Odd id");
  assert.equal(chip("link:a>b>ui"), "Odd id → UI");
  // A part the tab's guide no longer has is named by what the thread quoted.
  assert.equal(chip("group:gone", { quote: "Gone" }), "Gone");
  // One a new guide moved to the map says what it was on.
  const moved = thread("x", "overview", "map", { moved: true, quote: "API → Store: writes" });
  assert.equal(overviewPlace(moved), "was on API → Store: writes");
  assert.equal(overviewPlace(thread("x", "overview", "group:api")), null);
});

test("a box or a link is found from its part whatever its ids hold", () => {
  assert.deepEqual(mapTarget("group:a>b", LINKS), { group: "a>b" });
  assert.deepEqual(mapTarget("link:a>b>ui", LINKS), { link: ["a>b", "ui"] });
  assert.deepEqual(mapTarget("link:api>a>b", LINKS), { link: ["api", "a>b"] });
  assert.equal(mapTarget("link:nope>ui", LINKS), null);
  assert.equal(mapTarget("map", LINKS), null);
});

test("an open thread tints its part: blue for a question, orange for a change request, which wins", () => {
  const ask = { intent: "question" as const, comments: [msg({ intent: "question" })] };
  const tints = overviewTints([
    thread("q", "overview", "group:api", ask),
    thread("c", "overview", "group:ui"),
    thread("both-q", "overview", "link:api>a>b", ask),
    thread("both-c", "overview", "link:api>a>b"),
    thread("done", "overview", "group:a>b", { status: "resolved" }),
    thread("topic", "t1", "title"),
  ]);
  assert.deepEqual(
    [...tints],
    [
      ["group:api", "question"],
      ["group:ui", "change"],
      ["link:api>a>b", "change"],
    ],
  );
});

test("Overview requests come first, named Overview, summary then the map then coverage", () => {
  const list = topicRequestList(
    [
      thread("t1-title", "t1", "title"),
      thread("cov", "overview", "coverage", { title: "Overview" }),
      thread("box", "overview", "group:g", { title: "Overview" }),
      thread("sum", "overview", "summary", { title: "Overview" }),
    ],
    STAGES,
  );
  assert.deepEqual(
    list.map((r) => [r.id, r.title]),
    [
      ["sum", "Overview"],
      ["box", "Overview"],
      ["cov", "Overview"],
      ["t1-title", "Title t1"],
    ],
  );
});

test("a part's quote is the desk's text of a body block, or the field the part names", () => {
  const stamp = { blocks: [], lines: 0, coverHash: "h", bodyParts: parts(1, 3) };
  const t = { ...topic("t1", "Careful"), title: "Cache it", recorded: "Kept the cache." };
  assert.equal(partQuote(t, stamp, "body:3"), "Block at 3.");
  assert.equal(partQuote(t, stamp, "title"), "Cache it");
  assert.equal(partQuote(t, stamp, "recorded"), "Kept the cache.");
  assert.equal(partQuote(t, stamp, "flag"), "Careful");
  // A line the desk lists no block at, an option and a line of a line block quote nothing here.
  assert.equal(partQuote(t, stamp, "body:2"), undefined);
  assert.equal(partQuote(t, stamp, "option:1"), undefined);
  assert.equal(partQuote(t, undefined, "body:1"), undefined);
});

test("the Send holds back resolved topic threads and answered questions on a topic or the Overview", () => {
  const asked = msg({ id: "q", intent: "question", createdAt: "2026-11-13T10:00:00.000Z" });
  const answer = msg({
    id: "a",
    role: "agent",
    intent: "note",
    createdAt: "2026-11-13T10:01:00.000Z",
  });
  const threads = [
    thread("answered", "t1", "body:1", { intent: "question", comments: [asked, answer] }),
    thread("overview", "overview", "summary", { intent: "question", comments: [asked, answer] }),
    thread("waiting", "t1", "title", { intent: "question", comments: [asked] }),
    thread("resolved", "t2", "flag", { status: "resolved" }),
    // A question the reviewer turned into a change request goes, as a request.
    thread("turned", "t2", "title", {
      intent: "question",
      comments: [asked, answer, msg({ id: "c", createdAt: "2026-11-13T10:02:00.000Z" })],
    }),
    thread("request", "t1", "recorded"),
  ];
  assert.deepEqual(topicHeldBack(threads), { resolved: 1, answered: 2 });
  assert.deepEqual(topicHeldBack([]), { resolved: 0, answered: 0 });
});
