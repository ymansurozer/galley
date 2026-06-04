---
status: open
created_at: 2026-06-03
---

## Problem Statement

Galley's protocol is intentionally harness-agnostic — any agent that can run a command, read
stdout, and background a process can drive it — but that claim is neither verified nor
documented per agent. Two gaps:

1. **No per-agent instructions.** There's a generic AGENTS.md snippet in the skill, but no
   tested, agent-specific guidance for Codex or Pi on the start → `await` → act → `comment`
   loop, and the loop hasn't been run end-to-end with a non-Claude agent.
2. **No documented fallback for constrained harnesses.** Agents that can't long-poll or
   background a process have no blessed path. The data exists (`artifacts.resultJson` is
   written on every Send) but the file-poll pattern isn't documented.

## Solution

- Author and **end-to-end test** per-agent instruction blocks for Codex (`AGENTS.md`) and Pi,
  covering the full loop with the `galley` CLI.
- **Document the file-poll fallback**: agents that can't `await` can stat `artifacts.resultJson`
  to detect a Send, with a clear example.

## User Stories

1. As a Codex user, I want a ready-made AGENTS.md block, so that Codex drives Galley without me
   writing the protocol from scratch.
2. As a Pi user, I want a ready-made config snippet, so that Pi drives Galley out of the box.
3. As an agent author on any harness, I want the start → await → act → comment loop spelled out
   concretely, so that I can adapt it to my tool.
4. As a maintainer, I want the loop verified end-to-end with at least one non-Claude agent, so
   that the cross-agent claim is real, not aspirational.
5. As an agent that can't hold a long-poll open, I want a documented file-poll fallback, so
   that I can still detect a Send.
6. As an agent using the fallback, I want a clear example of watching `artifacts.resultJson`,
   so that I implement it correctly.
7. As a reviewer, I want the same desk behavior regardless of which agent is driving, so that
   the experience is consistent.
8. As a maintainer, I want the per-agent docs to live alongside the skill, so that installing
   the skill brings the guidance.

## Implementation Decisions

- **Per-agent instruction blocks.** Add Codex (`AGENTS.md`) and Pi instruction snippets,
  derived from the existing generic snippet in `skills/galley/SKILL.md`, tuned to each
  harness's process/background model. Live alongside the skill so installation carries them.
- **End-to-end verification.** Run the full loop (start desk → `await` → act → `comment` →
  `await`) with at least one non-Claude agent that's available, and capture any required tweaks
  (e.g. the `--timeout` flag from the live-desk-robustness PRD for short-timeout harnesses).
- **File-poll fallback docs.** Document the pattern: each Send writes `artifacts.resultJson`;
  an agent can poll/stat that file (by mtime or content) instead of using `await`. Optionally
  add a `galley result --session <id>` convenience that prints the latest `resultJson` so the
  fallback doesn't require knowing the on-disk path.
- **Mostly docs + verification.** Minimal code: possibly the `galley result` convenience; the
  rest is instructions and testing. Depends on the live-desk-robustness PRD landing first so
  the loop is actually robust before we document it for others.

## Testing Decisions

- A good test here is **the loop actually working** with a given agent — primarily a manual,
  scripted end-to-end run per agent, asserting the desk receives the send and the agent acts.
- **Automated coverage:** the file-poll fallback's precondition — that a Send always writes
  `artifacts.resultJson` with the expected shape — can be asserted in the existing
  server/state tests. `galley result`, if built, gets a small test that it prints the latest
  result for a session.
- **Prior art:** the manual smoke scripts used while building the persistent desk; the
  `node:test` suite for the result-writing precondition.

## Out of Scope

- Building wrappers, SDKs, or plugins for each agent (instructions only).
- Submitting Galley to any skills registry / marketplace beyond what `npx skills add` does
  automatically.
- Supporting harnesses that can neither long-poll, background, nor poll a file (out of reach).

## Further Notes

This group is intentionally last: it documents and verifies the cross-agent story, which only
makes sense once the loop is robust (live-desk-robustness) and the feature set is stable. The
`--timeout` flag and file-poll fallback are the two escape hatches that make "works with any
agent" true in practice rather than just in principle.
