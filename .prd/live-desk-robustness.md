---
status: done
created_at: 2026-06-03
completed_at: 2026-06-03
---

## Problem Statement

The living desk has two infrastructure gaps that break its core promise of a persistent,
always-current surface:

1. **The long-poll dies early.** `galley await` waits for the human to click **Send to
   agent**, but the client uses Node's global `fetch` (undici), whose default
   `headersTimeout` (~5 min) aborts a header-less long-poll. So `await` returns empty after
   ~5 minutes even though the server holds the request for an hour. The agent must constantly
   re-arm `await`, which spams empty timeouts and — on harnesses that can't loop cleanly —
   risks missing a Send entirely.
2. **The open desk goes stale after the agent edits code.** The desk shows the diff captured
   when it started. When the agent makes code changes between rounds, the reviewer has to
   restart the desk to see them, which breaks the "same tab, always current" experience.

## Solution

Make the wait survive a long human review, and let the desk re-diff itself in place:

- The `await` client gets a custom undici dispatcher with `headersTimeout` disabled, so a
  single `await` can block for as long as the server holds it. A `galley await --timeout <s>`
  flag lets short-timeout harnesses opt into a server-side `204` cutoff and re-poll on a
  cadence they can tolerate.
- A new `reload` capability rebuilds the desk's review state from the current working-tree
  diff, merges it with the reviewer's existing decisions and comments (reusing the staleness
  logic), and swaps it into the live server so the open tab updates without a restart. The
  browser's existing poll detects the changed diff and re-renders without clobbering work in
  progress.

## User Stories

1. As a coding agent, I want a single `galley await` call to block until the human actually
   clicks Send, so that I don't have to re-arm it every five minutes.
2. As a coding agent on a harness that caps command runtime, I want `galley await --timeout
   <s>` to return cleanly after N seconds, so that I can re-poll on a cadence my harness
   tolerates instead of being killed mid-wait.
3. As a coding agent, I want an empty `await` result (a `204`) to be unambiguous, so that I
   can tell "no send yet, re-poll" apart from "the human sent."
4. As a reviewer, I want the desk to keep waiting quietly while I take my time, so that long
   reviews don't silently drop the agent's attention.
5. As a coding agent, I want to edit code between rounds and have the reviewer see the new
   diff in the same tab, so that we don't lose the living-desk experience.
6. As a coding agent, I want to trigger a reload of the desk's diff after I make changes, so
   that the reviewer reviews my latest work, not a stale snapshot.
7. As a reviewer, when the diff reloads, I want my accept/reject decisions on unchanged hunks
   preserved, so that I don't have to re-decide everything.
8. As a reviewer, when the diff reloads, I want decisions on hunks whose content changed to
   reset to pending, so that I re-review what actually changed.
9. As a reviewer, when the diff reloads, I want my comments to stay attached to their files,
   so that the conversation isn't lost.
10. As a reviewer, when the diff reloads, I don't want my scroll position or an open comment
    composer to be destroyed, so that a background refresh doesn't interrupt me.
11. As a coding agent, I want `reload` to be a no-op-safe operation when nothing changed, so
    that I can call it freely.
12. As a maintainer, I want the await timeout behavior to be configurable in one place, so
    that the default and the override are easy to reason about.

## Implementation Decisions

- **`await` client dispatcher.** The `await` subcommand constructs an undici dispatcher
  (`Agent`/`Pool`) with `headersTimeout: 0` and `bodyTimeout: 0` and passes it to `fetch`, so
  the header-less long-poll is not aborted client-side. This is the primary fix.
- **`--timeout` flag.** `galley await --timeout <s>` adds `?timeout=<s>` to the
  `/api/await-send` request; the server arms its existing timeout to that value (instead of
  the hardcoded hour) and returns `204` on expiry. Without the flag, the server holds long
  and the client dispatcher keeps the socket alive. `204` continues to mean "no send, re-poll."
- **`reload` capability.** A new `POST /api/reload` rebuilds a fresh `ReviewState` from the
  current diff via the existing review-state builder, then merges it into the live in-memory
  state. The merge is an extension of the existing `mergeReviewState` so it can fold a fresh
  base into an *already-live* state (not just a saved-from-disk one): carry accepted/rejected
  decisions whose `stableKey` + `contentHash` match, reset changed ones to pending, keep
  comments on still-present files, and recompute `baseDiffHash`.
- **`galley reload` subcommand.** Mirrors `galley comment`: reads the desk lock, POSTs to the
  live server's `/api/reload`; falls back to a no-op message if no desk is live. The agent
  calls it after editing code.
- **Browser live update.** The existing 1.5s poll is extended to compare the server's
  `baseDiffHash` against the client's; on change it re-fetches and re-renders the diff (not
  just merges new comments), while preserving scroll and deferring if a composer/popover is open.
- **Deep module.** The review-state **merge** logic (in the state module) is the deep, pure
  module here — single interface, used by both initial load and reload. The diff rebuild stays
  behind the existing builder. The undici dispatcher is an isolated helper in the CLI layer.

## Testing Decisions

- A good test here exercises **external behavior of the merge**: given a saved/live state and
  a fresh diff, the merged state has the right decision statuses, staleness resets, comment
  retention, and `baseDiffHash`. It must not assert on internal call order or private shapes.
- **Modules to test:** the review-state merge function (decision carry-over by
  `stableKey`+`contentHash`, staleness reset, comment retention on present vs absent files);
  `sanitizeSession`. These are pure and already isolated.
- **Prior art:** none — the repo has no tests yet. Stand up Node's built-in `node:test`
  runner (zero new dependencies, consistent with the no-deps server) and add a `test` script.
  Use the existing diff fixtures pattern (a small committed repo or inline unified-diff
  strings fed to `parseUnifiedDiff`).
- The undici dispatcher and HTTP long-poll timeout are validated by a scripted end-to-end
  smoke run (start desk, `await`, send, assert stdout), not unit tests.

## Out of Scope

- Real-time collaborative editing / CRDTs / multiple simultaneous reviewers.
- The desk calling a model itself.
- Auto-reload on filesystem watch (reload is explicitly triggered by the agent for now).
- Replacing the long-poll with WebSockets/SSE (the poll + long-poll model stays).

## Further Notes

The `--timeout` flag is a fallback for constrained harnesses; the dispatcher fix is what makes
the default experience good. Both ship together so the cross-agent story (see the distribution
PRD) has a clean answer for harnesses that can't hold a socket open.
