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

  // human clicks Send → `galley await` yields a review event with a ReviewResult
  await post("/api/send", await getJson("/api/state"));
  const ev2 = JSON.parse(cli("await", "--repo", tmp, "--session", ID, "--timeout", "5"));
  assert.equal(ev2.kind, "review");
  assert.equal(ev2.result.mode, "repo");
  for (const k of ["requestedChanges", "accepted", "rejected", "stagedFiles"])
    assert.ok(Array.isArray(ev2.result[k]), `result.${k} is an array`);
  console.log("✓ await → review event (ReviewResult shape ok)");

  console.log("\nSMOKE PASS");
} catch (error) {
  console.error("\nSMOKE FAIL:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  cleanup();
}
