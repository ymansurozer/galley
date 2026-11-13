import { test } from "node:test";
import assert from "node:assert/strict";
import { firstTopic, stepGroup, stepTopic, topicsNavRows } from "./topics-derive";
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
          ? `group ${r.title} ${r.count}${r.current ? " current" : ""}`
          : `topic ${r.id}${r.open ? " open" : ""}${r.flagged ? " flagged" : ""}`,
    ),
    [
      "stage Edge",
      "group Group A 2",
      "group Group B 1",
      "stage Data",
      "group Group C 3 current",
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
