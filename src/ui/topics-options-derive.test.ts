import { test } from "node:test";
import assert from "node:assert/strict";
import { selectedOption, replacePick, parseOptions } from "./topics-options-derive";
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
