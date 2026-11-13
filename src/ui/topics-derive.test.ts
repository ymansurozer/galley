import { test } from "node:test";
import assert from "node:assert/strict";
import {
  earlierLabel,
  firstTodo,
  firstTopic,
  groupEntry,
  nextTodo,
  stepGroup,
  stepTopic,
  topicSettled,
  topicsDone,
  topicsNavRows,
  type TopicsReview,
} from "./topics-derive";
import type { GuideStage } from "../types";

// Two stages: "edge" holds groups a (topics a1, a2) and b (b1); "data" holds c (c1, c2, c3).
const topic = (id: string, flag?: string) => ({
  id,
  title: `Title ${id}`,
  recorded: "r",
  body: "b",
  covers: [{ path: "x.ts" }],
  ...(flag ? { flag } : {}),
});
const STAGES: GuideStage[] = [
  {
    id: "edge",
    label: "Edge",
    groups: [
      { id: "a", title: "Group A", topics: [topic("a1"), topic("a2", "Look closer")] },
      { id: "b", title: "Group B", topics: [topic("b1")] },
    ],
  },
  {
    id: "data",
    label: "Data",
    groups: [{ id: "c", title: "Group C", topics: [topic("c1"), topic("c2"), topic("c3")] }],
  },
];

test("next and previous topic cross group and stage boundaries", () => {
  assert.equal(stepTopic(STAGES, "a1", 1), "a2");
  assert.equal(stepTopic(STAGES, "a2", 1), "b1");
  assert.equal(stepTopic(STAGES, "b1", 1), "c1");
  assert.equal(stepTopic(STAGES, "c1", -1), "b1");
  assert.equal(stepTopic(STAGES, "b1", -1), "a2");
});

test("topic steps start from the Overview and end on it, or stay at the last topic", () => {
  assert.equal(stepTopic(STAGES, null, 1), "a1");
  assert.equal(stepTopic(STAGES, null, -1), undefined);
  assert.equal(stepTopic(STAGES, "a1", -1), null);
  assert.equal(stepTopic(STAGES, "c3", 1), undefined);
});

test("next and previous group land on the group's first topic", () => {
  assert.equal(stepGroup(STAGES, "a2", 1), "b1");
  assert.equal(stepGroup(STAGES, "b1", 1), "c1");
  assert.equal(stepGroup(STAGES, "c3", -1), "b1");
  assert.equal(stepGroup(STAGES, "b1", -1), "a1");
  assert.equal(stepGroup(STAGES, "a2", -1), null);
  assert.equal(stepGroup(STAGES, null, 1), "a1");
  assert.equal(stepGroup(STAGES, null, -1), undefined);
  assert.equal(stepGroup(STAGES, "c2", 1), undefined);
});

test("the review's first topic is the first group's first topic", () => {
  assert.equal(firstTopic(STAGES), "a1");
  assert.equal(firstTopic([]), undefined);
});

test("a topic id the guide no longer has steps as the Overview", () => {
  assert.equal(stepTopic(STAGES, "gone", 1), "a1");
  assert.equal(stepGroup(STAGES, "gone", 1), "a1");
});

test("the sidebar lists stages and groups, and unfolds only the open topic's group", () => {
  const rows = topicsNavRows(STAGES, "c2");
  assert.deepEqual(
    rows.map((r) =>
      r.kind === "stage"
        ? `stage ${r.label}`
        : r.kind === "group"
          ? `group ${r.title} ${r.done}/${r.total}${r.current ? " current" : ""}`
          : r.kind === "topic"
            ? `topic ${r.id}${r.open ? " open" : ""}${r.flagged ? " flagged" : ""}`
            : r.label,
    ),
    [
      "stage Edge",
      "group Group A 0/2",
      "group Group B 0/1",
      "stage Data",
      "group Group C 0/3 current",
      "topic c1",
      "topic c2 open",
      "topic c3",
    ],
  );
  const overview = topicsNavRows(STAGES, null);
  assert.ok(overview.every((r) => r.kind !== "topic"));
  const flagged = topicsNavRows(STAGES, "a1").filter((r) => r.kind === "topic");
  assert.deepEqual(
    flagged.map((r) => r.kind === "topic" && [r.id, r.flagged]),
    [
      ["a1", false],
      ["a2", true],
    ],
  );
});

// ── Settling ──
// Every topic stamped with a cover hash "H<id>"; `settled` maps the ids signed off to their round.
const ALL = ["a1", "a2", "b1", "c1", "c2", "c3", "c4"];
const review = (settled: Record<string, number> = {}, round = 1): TopicsReview => ({
  round,
  topics: Object.fromEntries(ALL.map((id) => [id, { blocks: [], lines: 1, coverHash: `H${id}` }])),
  settledTopics: Object.fromEntries(
    Object.entries(settled).map(([id, r]) => [id, { hash: `H${id}`, round: r }]),
  ),
});

test("a topic is settled only while its sign-off names its cover hash now", () => {
  const r = review({ a1: 1 });
  assert.equal(topicSettled(r, "a1"), true);
  assert.equal(topicSettled(r, "a2"), false);
  r.topics!.a1!.coverHash = "moved";
  assert.equal(topicSettled(r, "a1"), false, "its lines changed since");
  assert.equal(topicSettled({ settledTopics: { gone: { hash: "H", round: 1 } } }, "gone"), false);
});

test("next to do: later in the group, then earlier in it, then the following groups, wrapping", () => {
  assert.equal(nextTodo(STAGES, review(), "a1"), "a2");
  assert.equal(nextTodo(STAGES, review({ c1: 1 }), "c3"), "c2", "earlier in its own group first");
  // From the last to-do topic of a group: the first to-do topic of the next group that has one.
  assert.equal(nextTodo(STAGES, review({ a1: 1, b1: 1 }), "a2"), "c1");
  assert.equal(nextTodo(STAGES, review({ a1: 1, b1: 1, c1: 1 }), "a2"), "c2");
  // From the last group, on to the groups before it.
  assert.equal(nextTodo(STAGES, review({ c1: 1, c2: 1, a1: 1 }), "c3"), "a2");
  assert.equal(nextTodo(STAGES, review({ a1: 1, a2: 1, b1: 1, c1: 1, c2: 1 }), "c3"), undefined);
  assert.equal(
    nextTodo(STAGES, review({ a1: 1, a2: 1, b1: 1, c1: 1, c2: 1, c3: 1 }), "c3"),
    undefined,
  );
});

test("a group is entered at its first topic still to do, or its first when all are settled", () => {
  const [a, b] = STAGES[0]!.groups;
  assert.equal(groupEntry(a!, review({ a1: 1 })), "a2");
  assert.equal(groupEntry(a!, review({ a1: 1, a2: 1 })), "a1");
  assert.equal(groupEntry(b!), "b1");
  assert.equal(stepGroup(STAGES, "b1", 1, review({ c1: 1 })), "c2", "⇧↓ uses it");
  assert.equal(stepGroup(STAGES, null, 1, review({ a1: 1 })), "a2");
});

test("↵ on the Overview opens the review's first topic still to do, and nothing once all are", () => {
  assert.equal(firstTodo(STAGES, review({ a1: 1, a2: 1 })), "b1");
  assert.equal(firstTodo(STAGES, review(Object.fromEntries(ALL.map((id) => [id, 1])))), undefined);
});

test("progress counts settled topics out of all, earlier rounds' included", () => {
  assert.deepEqual(topicsDone(STAGES, review({ a1: 1, c2: 3 }, 3)), { done: 2, total: 6 });
});

test("topics settled in earlier rounds fold into one row and leave the group's total", () => {
  const rows = (r: TopicsReview, open = new Set<string>(), at = "c1") =>
    topicsNavRows(STAGES, at, r, open).map((row) =>
      row.kind === "group"
        ? `group ${row.id} ${row.done}/${row.total}${row.settled ? " done" : ""}`
        : row.kind === "topic"
          ? `topic ${row.id}${row.settled ? " settled" : ""}`
          : row.kind === "earlier"
            ? `${row.label}${row.open ? " open" : ""}`
            : `stage ${row.label}`,
    );
  // Group c with a fourth topic: three settled in round 1 and one in round 2, viewed in round 3.
  const four: GuideStage[] = structuredClone(STAGES);
  four[1]!.groups[0]!.topics.push(topic("c4"));
  const r = review({ c1: 1, c2: 1, c3: 1, c4: 2, a1: 3 }, 3);
  const c = topicsNavRows(four, "c1", r).filter((row) => row.kind !== "stage");
  assert.deepEqual(
    c.map((row) => (row.kind === "group" ? `${row.id} ${row.done}/${row.total}` : row.kind)),
    ["a 1/2", "b 0/1", "c 0/0", "earlier", "topic", "topic", "topic", "topic"],
    "a1, settled this round, counts; group c's four are out of its total, unfolded for open c1",
  );
  assert.equal(c.find((row) => row.kind === "earlier")?.label, "4 settled in earlier rounds");
  // All from round 1, viewed in round 2.
  assert.deepEqual(rows(review({ c2: 1, c3: 1 }, 2)), [
    "stage Edge",
    "group a 0/2",
    "group b 0/1",
    "stage Data",
    "group c 0/1",
    "topic c1",
    "2 settled in round 1",
  ]);
  // Opened, its topics follow it; one of them open keeps it open too.
  assert.deepEqual(rows(review({ c2: 1, c3: 1 }, 2), new Set(["c"])).slice(-3), [
    "2 settled in round 1 open",
    "topic c2 settled",
    "topic c3 settled",
  ]);
  assert.deepEqual(rows(review({ c2: 1, c3: 1 }, 2), new Set(), "c3").slice(-3), [
    "2 settled in round 1 open",
    "topic c2 settled",
    "topic c3 settled",
  ]);
  // Settled in the current round: an ordinary row with its mark, and in the count.
  assert.deepEqual(rows(review({ c2: 2, c3: 2 }, 2)).slice(-4), [
    "group c 2/3",
    "topic c1",
    "topic c2 settled",
    "topic c3 settled",
  ]);
  assert.deepEqual(rows(review({ c1: 2, c2: 2, c3: 2 }, 2))[4], "group c 3/3 done");
});

test("the fold's words name the round when its topics share one", () => {
  assert.equal(earlierLabel([1, 1, 1]), "3 settled in round 1");
  assert.equal(earlierLabel([1, 1, 1, 2]), "4 settled in earlier rounds");
});
