import assert from "node:assert/strict";
import { test } from "node:test";

import { SPEC } from "./spec.js";

// The SPEC string is the single source of truth for the agent contract (printed by
// `galley spec`). These anchors guard that consolidating the skill/snippet into it didn't
// silently hollow out a section — if you intentionally rename a section, update the anchor.
const ANCHORS = [
  // modes
  "Review modes",
  "repo (default)",
  "galley file <path>",
  "galley pr <ref>",
  // the loop + events
  "galley await",
  "galley comment",
  "galley reload",
  "galley status",
  '"kind":"question"',
  '"kind":"review"',
  // a question is READ-ONLY: answer it, don't edit code in response (guards issue 04)
  "answering is READ-ONLY",
  "NEVER edit tracked",
  // question batching + immediate re-await (issue 05)
  "batched into this delivery",
  "await again immediately",
  // result + acting
  "ReviewResult",
  "approvedFiles",
  "overallNote",
  // unanswered questions fold into the Send (issue 05)
  "openQuestions",
  "How to act on a review",
  // guided review schema (folded in from the old guide-spec)
  "Guide JSON schema",
  "one-paragraph changeset overview",
  "files (required, non-empty array)",
  "repo-relative; must be a file in the diff",
  "Orientation, not a changelog",
  // the rest of the operational contract
  "reload vs restart",
  "desk.lock",
  "Settings",
  "PATCH_CONFLICT",
];

test("SPEC carries every consolidated section", () => {
  for (const anchor of ANCHORS) {
    assert.ok(SPEC.includes(anchor), `galley spec is missing the "${anchor}" anchor`);
  }
});

test("SPEC has no dangling references to the old skill/command", () => {
  assert.ok(
    !SPEC.includes("guide-spec"),
    "SPEC should not reference the removed guide-spec command",
  );
  assert.ok(
    !SPEC.includes("SKILL.md"),
    "SPEC must be self-contained — no 'see the skill' pointers",
  );
});
