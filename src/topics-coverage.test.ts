import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGuide } from "./guide.js";

const guide = { overview: "Review", files: [{ path: "a", skim: true }] };
test("skims require a reason and normalize covers with optional reviewer rule", () => {
  assert.deepEqual(validateGuide({ ...guide, skims: [{ covers: [{ path: "a" }] }] }), {
    ok: false,
    reason: "guide.skims[0].reason must be a non-empty string",
  });
  const r = validateGuide({
    ...guide,
    skims: [{ reason: "Generated", rule: "Churn", covers: [{ path: "a", lines: [[8, 3]] }] }],
  });
  assert.ok(r.ok);
  if (r.ok)
    assert.deepEqual(r.guide.skims, [
      { reason: "Generated", rule: "Churn", covers: [{ path: "a", lines: [[3, 8]] }] },
    ]);
});
