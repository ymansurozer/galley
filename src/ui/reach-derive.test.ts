import { test } from "node:test";
import assert from "node:assert/strict";
import { deskReach, reachMessage, restartCommand } from "./reach-derive.js";

const at = (
  now: number,
  over: Partial<Parameters<typeof deskReach>[0]> = {},
  shown: Parameters<typeof deskReach>[1] = null,
) =>
  deskReach(
    { now, lastAnswerAt: 0, failingSince: null, unsaved: false, saving: false, ...over },
    shown,
  );

test("deskReach: nothing to show while the desk answers and every save lands", () => {
  assert.equal(at(2999), null);
});

test("deskReach: three seconds without an answer is unreachable, unsaved or not", () => {
  assert.deepEqual(at(3000), { kind: "unreachable", unsaved: false });
  assert.deepEqual(at(9000, { failingSince: 4000, unsaved: true }), {
    kind: "unreachable",
    unsaved: true,
  });
});

test("deskReach: a failed save shows nothing if a retry lands within three seconds", () => {
  assert.equal(at(2500, { lastAnswerAt: 2000, failingSince: 1000, unsaved: true }), null);
});

test("deskReach: a desk that answers but has not saved for three seconds can't save", () => {
  assert.deepEqual(at(4000, { lastAnswerAt: 3500, failingSince: 1000, unsaved: true }), {
    kind: "unsaved",
    unsaved: true,
  });
});

test("deskReach: while a save is out, the banner keeps what it says until the save answers", () => {
  const shown = { kind: "unreachable", unsaved: true } as const;
  // The desk answered a poll and the held save is on its way: the banner goes once it has landed.
  const back = { lastAnswerAt: 9000, failingSince: 1000, unsaved: true };
  assert.equal(at(9000, { ...back, saving: true }, shown), shown);
  assert.deepEqual(at(9000, { ...back, saving: false }, shown), { kind: "unsaved", unsaved: true });
  assert.equal(at(9000, { lastAnswerAt: 9000, saving: false }, shown), null);
  // Nothing shown yet: an attempt in flight raises nothing on its own.
  assert.equal(at(2000, { saving: true }), null);
});

test("restartCommand: repo mode names the session, and the index when the review is staged", () => {
  assert.equal(
    restartCommand({ mode: "repo", session: "main", staged: false }),
    "galley --session main",
  );
  assert.equal(
    restartCommand({ mode: "repo", session: "main", staged: true }),
    "galley --staged --session main",
  );
});

test("restartCommand: pr and file modes name their target", () => {
  assert.equal(
    restartCommand({ mode: "pr", session: "pr-feat", target: "feat/x", staged: false }),
    "galley pr feat/x --session pr-feat",
  );
  assert.equal(
    restartCommand({ mode: "file", session: "file-plan", target: "docs/plan.md", staged: false }),
    "galley file docs/plan.md --session file-plan",
  );
});

test("restartCommand: quotes what the shell would split or expand", () => {
  assert.equal(
    restartCommand({ mode: "file", session: "s", target: "my notes/it's.md", staged: false }),
    "galley file 'my notes/it'\\''s.md' --session s",
  );
});

test("reachMessage: says whether the tab holds unsaved changes", () => {
  assert.match(reachMessage({ kind: "unreachable", unsaved: true }).detail, /unsaved changes/);
  assert.match(reachMessage({ kind: "unreachable", unsaved: false }).detail, /is saved/);
  assert.match(reachMessage({ kind: "unsaved", unsaved: true }).title, /isn't saving/);
});
