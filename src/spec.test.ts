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
  // question batching + immediate re-await (issue 05); the loop iterates the whole batch, not
  // the deprecated .question compat field (issue 04 cleanup)
  "batched into this delivery",
  "await again immediately",
  ".questions[]",
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
  // skimmable review (issue 06) — the fields and the "only on request / opposite of flag" rule
  "skimBlocks?",
  "new-file-side [start, end] span",
  "Skim LOWERS attention",
  "When to skim",
  // fully-skimmed files leave the flow (issue 07)
  "drops into a collapsed",
  "genuinely needs no eyes",
  // moved-file handling documented in the contract (issues 01–03)
  "movedFrom",
  "renamed old → new",
  // focused-review definition + flag (issue 04)
  "focused review",
  "mechanical churn skimmed",
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

test("SPEC's question loop uses the space-safe read idiom, not word-splitting (issue 04)", () => {
  // Question bodies contain spaces, so \`for q in $(jq …)\` shatters each JSON object — the example
  // must pipe through \`while IFS= read\`. Agents copy it verbatim, so pin the safe idiom.
  assert.ok(SPEC.includes("| while IFS= read -r q"), "loop must use a while-read pipeline");
  assert.ok(!SPEC.includes("for q in $("), "loop must not word-split questions with for-in");
});

test("SPEC states the deduped invariants exactly once (issue 04)", () => {
  const count = (re: RegExp) => (SPEC.match(re) ?? []).length;
  // The READ-ONLY question rule has ONE full statement (Events); the loop comment is a pointer.
  assert.equal(count(/answering is READ-ONLY/g), 1, "READ-ONLY rule should be stated once");
  // The reload-resets-edits invariant lives once, at the reload bullet.
  assert.equal(count(/resets to pending on reload/g), 1, "reload-resets invariant should be once");
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
