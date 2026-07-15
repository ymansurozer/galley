// End-to-end smoke test of the agent contract: spins up a real desk on a throwaway git
// repo and drives the full loop the way an agent would — `galley await` yields a tagged
// event ({kind:"question"|"review"}), `galley comment` answers, and a Send produces a
// ReviewResult. Validates the event-stream contract that SKILL.md documents.
// Run: pnpm build && pnpm smoke
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const PORT = 6799,
  ID = "smoke";
const CLI = path.join(process.cwd(), "dist", "cli.js");
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (...args) => execFileSync("node", [CLI, ...args], { encoding: "utf8" }).trim();
const getJson = async (p, init) => (await fetch(BASE + p, init)).json();
const post = (p, body) =>
  fetch(BASE + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let desk, tmp;
const cleanup = () => {
  try {
    desk?.kill();
  } catch {
    /**/
  }
  try {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  } catch {
    /**/
  }
};
process.on("exit", cleanup);

try {
  // throwaway repo: one committed file + a working-tree change
  tmp = mkdtempSync(path.join(tmpdir(), "galley-smoke-"));
  const git = (...a) => execFileSync("git", a, { cwd: tmp, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "s@s.dev");
  git("config", "user.name", "smoke");
  writeFileSync(path.join(tmp, "a.txt"), "one\ntwo\nthree\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(path.join(tmp, "a.txt"), "one\nCHANGED\nthree\n");

  desk = spawn("node", [CLI, "--repo", tmp, "--session", ID, "--port", String(PORT), "--no-open"], {
    stdio: "ignore",
    // Keep the smoke hermetic: no update-check network call at desk start.
    env: { ...process.env, GALLEY_NO_UPDATE_CHECK: "1" },
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/api/state");
      break;
    } catch {
      await sleep(100);
    }
  }

  const state = await getJson("/api/state");
  assert.equal(state.mode, "repo");
  assert.ok(state.changes.length >= 1, "desk has a change to review");
  console.log(`✓ desk up — repo mode, ${state.changes.length} change(s)`);

  // guided review with skim (issue 06): attach a guide (OUTSIDE the repo so it isn't a stray
  // untracked file) whose skimBlocks span resolves to the change block, and a file-level skim.
  const guideDir = mkdtempSync(path.join(tmpdir(), "galley-smoke-guide-"));
  const guidePath = path.join(guideDir, "guide.json");
  writeFileSync(
    guidePath,
    JSON.stringify({
      overview: "Smoke overview.",
      files: [
        {
          path: "a.txt",
          orientation: "The changed file.",
          skim: true,
          skimReason: "smoke",
          skimBlocks: [{ lines: 2, reason: "line-two churn" }],
        },
      ],
    }),
  );
  const reloaded = JSON.parse(cli("reload", "--repo", tmp, "--session", ID, "--guide", guidePath));
  assert.ok(reloaded.ok, "reload with a skim guide accepted");
  const guidedState = await getJson("/api/state");
  assert.equal(guidedState.guide?.files?.[0]?.skim, true, "file-level skim survives to state");
  assert.ok(
    guidedState.changes.some((c) => c.skim),
    "a skimBlocks span stamped a change block",
  );
  console.log("✓ reload --guide with skim → accepted, file + block stamped");

  // A skim span that resolves to no change block is rejected (diff-aware validation).
  const badReload = await post("/api/reload", {
    guide: {
      overview: "x",
      files: [{ path: "a.txt", orientation: "s", skimBlocks: [{ lines: 99 }] }],
    },
  });
  assert.equal(badReload.status, 422, "unresolvable skim span rejected");
  const badBody = await badReload.json();
  assert.ok(badBody.error?.includes("a.txt"), "rejection names the offending file");
  rmSync(guideDir, { recursive: true, force: true });
  console.log("✓ reload with an unresolvable skim span → 422 naming the entry");

  // human asks a question → `galley await` yields a question event
  await post("/api/ask", {
    path: "a.txt",
    lineNumber: 2,
    side: "additions",
    body: "why this change?",
  });
  // No await is parked yet, so the question sits queued — the presence signal the
  // UI renders as "No agent attached — question queued".
  const queuedState = await getJson("/api/state");
  assert.equal(queuedState.queuedQuestions, 1, "question queued with no listener");
  console.log("✓ queuedQuestions reflects an undelivered question");
  const ev1 = JSON.parse(cli("await", "--repo", tmp, "--session", ID, "--timeout", "5"));
  assert.equal(ev1.kind, "question");
  assert.equal(ev1.question.body, "why this change?");
  assert.equal(ev1.question.lineNumber, 2);
  console.log("✓ await → question event");

  // Two more questions fired back-to-back with no await parked → they batch: a single await
  // hands over BOTH, oldest first, with the singular `question` kept for compatibility.
  await post("/api/ask", {
    path: "a.txt",
    lineNumber: 2,
    side: "additions",
    body: "batched one?",
  });
  await post("/api/ask", {
    path: "a.txt",
    lineNumber: 2,
    side: "additions",
    body: "batched two?",
  });
  const batchState = await getJson("/api/state");
  assert.equal(batchState.queuedQuestions, 2, "both questions queued with no listener");
  const evBatch = JSON.parse(cli("await", "--repo", tmp, "--session", ID, "--timeout", "5"));
  assert.equal(evBatch.kind, "question");
  assert.equal(evBatch.questions.length, 2, "both questions delivered in one event");
  assert.deepEqual(
    evBatch.questions.map((q) => q.body),
    ["batched one?", "batched two?"],
  );
  assert.equal(evBatch.question.body, "batched one?", "singular question is the oldest");
  const drainedState = await getJson("/api/state");
  assert.equal(drainedState.queuedQuestions, 0, "batch drained in one await");
  console.log("✓ multiple questions batch into one await event");

  // agent posts ephemeral activity while working → visible in the state payload
  const status = JSON.parse(
    cli("status", "--repo", tmp, "--session", ID, "--body", "Reading a.txt…"),
  );
  assert.ok(status.ok && status.live, "status accepted by the live desk");
  const activeState = await getJson("/api/state");
  assert.equal(activeState.agentActivity?.body, "Reading a.txt…");
  assert.equal(activeState.queuedQuestions, 0, "question was delivered");
  console.log("✓ status → ephemeral agentActivity in state");

  // agent answers via `galley comment`
  const reply = JSON.parse(
    cli(
      "comment",
      "--repo",
      tmp,
      "--session",
      ID,
      "--path",
      "a.txt",
      "--line",
      "2",
      "--side",
      "additions",
      "--role",
      "agent",
      "--body",
      "Because two became CHANGED.",
    ),
  );
  assert.ok(reply.ok && reply.commentId, "comment posted");
  const answeredState = await getJson("/api/state");
  assert.equal(answeredState.agentActivity, null, "agent answer cleared the activity line");
  console.log("✓ comment posted (answer) — activity cleared");

  // human clicks Send → `galley await` yields a review event with a ReviewResult.
  // Attach an overall note and confirm it round-trips as a field on the structured result.
  const NOTE = "After applying, run the formatter and update the changelog.";
  await post("/api/send", { ...(await getJson("/api/state")), overallNote: NOTE });
  const ev2 = JSON.parse(cli("await", "--repo", tmp, "--session", ID, "--timeout", "5"));
  assert.equal(ev2.kind, "review");
  assert.equal(ev2.result.mode, "repo");
  for (const k of ["requestedChanges", "accepted", "rejected", "stagedFiles"])
    assert.ok(Array.isArray(ev2.result[k]), `result.${k} is an array`);
  assert.equal(ev2.result.overallNote, NOTE, "overallNote round-trips on the result");
  // The contract is the structured arrays only — no prose summary field, no duplicate .md artifact.
  assert.equal(ev2.result.summaryMarkdown, undefined, "no summaryMarkdown field on the result");
  assert.ok(
    ev2.result.artifacts?.resultJson && ev2.result.artifacts?.sessionDir,
    "artifacts carry resultJson + sessionDir",
  );
  assert.equal(ev2.result.artifacts.summaryMd, undefined, "no summaryMd artifact");
  console.log("✓ await → review event (ReviewResult shape + overallNote ok)");

  // review over → `galley stop` shuts the desk down; the process exits and the port frees.
  const stop = JSON.parse(cli("stop", "--repo", tmp, "--session", ID));
  assert.ok(stop.ok, "stop acked");
  assert.deepEqual(stop.stopped, [ID], "stop names the session it shut down");
  for (let i = 0; i < 50 && desk.exitCode === null; i++) await sleep(100);
  assert.notEqual(desk.exitCode, null, "desk process exited after stop");
  const dead = await fetch(BASE + "/api/state").then(
    () => true,
    () => false,
  );
  assert.equal(dead, false, "desk no longer answers");
  // Idempotent: a second stop with nothing running still exits 0 with an empty list.
  const stopAgain = JSON.parse(cli("stop", "--repo", tmp, "--session", ID));
  assert.ok(stopAgain.ok && stopAgain.stopped.length === 0, "stop is idempotent");
  console.log("✓ stop → desk exited, port freed, second stop idempotent");

  console.log("\nSMOKE PASS");
} catch (error) {
  console.error("\nSMOKE FAIL:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  cleanup();
}
