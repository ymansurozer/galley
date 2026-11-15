import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGuide } from "./guide.js";

const guide = (body: string) => ({
  overview: "Options",
  stages: [
    {
      id: "s",
      label: "Stage",
      groups: [
        {
          id: "g",
          title: "Group",
          topics: [
            { id: "choice", title: "Choice", recorded: "Code", body, covers: [{ path: "a.ts" }] },
          ],
        },
      ],
    },
  ],
});
const fence = (json: string) => `\`\`\`options\n${json}\n\`\`\``;
test("topic options refuse malformed blocks naming their topic", () => {
  for (const source of [
    '[{"label":"A"}]',
    '[{"label":"A","ships":true},{"label":"B","ships":true}]',
    "broken",
    '[{"label":"A"},{"label":1}]',
    '[{"label":"A","note":true},{"label":"B"}]',
  ]) {
    const result = validateGuide(guide(fence(source)));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /choice.*options/);
  }
  const valid = fence('[{"label":"A","ships":true},{"label":"B","recommended":true}]');
  assert.equal(validateGuide(guide(valid)).ok, true);
  assert.equal(validateGuide(guide(`${valid}\n\n${valid}`)).ok, false);
});
