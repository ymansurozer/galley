import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectedOption,
  replacePick,
  parseOptions,
  replaceReplyPick,
} from "./topics-options-derive";
import type { TopicThread } from "../types";
test("picks replace only picks, shipping clears them and is the default", () => {
  const options = [{ label: "A", ships: true }, { label: "B" }, { label: "C" }];
  const pick: TopicThread = {
    id: "pick",
    target: { topic: "t", part: "option:2" },
    title: "T",
    intent: "change",
    status: "open",
    option: "B",
    comments: [
      {
        id: "m",
        body: "Use: B",
        intent: "action",
        role: "user",
        createdAt: "now",
        updatedAt: "now",
      },
    ],
  };
  assert.equal(selectedOption(options, [], "t"), 0);
  const held = replacePick([], "t", pick);
  assert.equal(selectedOption(options, held, "t"), 1);
  assert.equal(held[0]?.option, "B");
  assert.deepEqual(replacePick(held, "t"), []);
  assert.equal(selectedOption(options, replacePick(held, "t"), "t"), 0);
  assert.equal(selectedOption([{ label: "A" }, { label: "B" }], [], "t"), -1);
});

test("reply options parse conservatively and preserve optional tags", () => {
  assert.deepEqual(
    parseOptions('[{"label":"A","note":"Reason","recommended":true},{"label":"B"}]'),
    [{ label: "A", note: "Reason", recommended: true }, { label: "B" }],
  );
  for (const invalid of [
    "broken",
    "{}",
    "[]",
    '[{"label":"Only"}]',
    '[{"label":"A","ships":true},{"label":"B","ships":true}]',
    '[{"label":"A","ships":"yes"},{"label":"B"}]',
  ])
    assert.equal(parseOptions(invalid), null);
});

test("a reply keeps one pick, skips a repeated pick, and shipping removes only that pick", () => {
  const opener = {
    id: "opener",
    role: "user" as const,
    intent: "question" as const,
    body: "Choices?",
    createdAt: "now",
    updatedAt: "now",
  };
  const thread: TopicThread = {
    id: "t",
    target: { topic: "topic", part: "title" },
    title: "T",
    intent: "question",
    status: "open",
    comments: [opener],
  };
  const make = (label: string) => ({
    ...opener,
    id: label,
    intent: "action" as const,
    option: label,
    body: `Use: ${label}`,
  });
  const first = replaceReplyPick(thread, { label: "A" }, make("A"));
  const second = replaceReplyPick(first, { label: "B" }, make("B"));
  assert.deepEqual(
    second.comments.map((m) => m.body),
    ["Choices?", "Use: B"],
  );
  assert.equal(replaceReplyPick(second, { label: "B" }, make("B")), second);
  assert.deepEqual(
    replaceReplyPick(second, { label: "Ships", ships: true }, make("Ships")).comments,
    [opener],
  );
  assert.equal(replaceReplyPick(thread, { label: "Ships", ships: true }, make("Ships")), thread);
});
