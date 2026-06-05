---
status: open
created_at: 2026-06-05
---

## Parent

[00-prd.md](00-prd.md)

## What to build

Close the loop on keeping the guide honest to the current diff, and document the agent
workflow.

- **Staleness hint:** record the `baseDiffHash` the guide was attached against (e.g.
  `guide.baseDiffHash`). When the review's `baseDiffHash` has advanced past it (the agent
  edited code and reloaded), show a subtle "guide may be stale — regenerate" hint on the
  Overview page / guide bar. The guide still renders; this is advisory, not blocking.
- **Regeneration workflow:** after editing code and `galley reload`, the agent regenerates the
  guide from the new diff and re-attaches it with `galley guide` (the new attach clears the
  stale hint). No timers, no in-desk model — same model-free contract as comments.
- **Docs:** add `galley guide` to `skills/galley/SKILL.md` — the subcommand, the guide JSON
  schema (`overview`, `prDescription?`, `files[]: {path, order, category, summary, critical?,
  why?}`), the attach/reload/regenerate flow, and that an absent guide degrades gracefully.
  Keep the skill's no-wrap prose convention; re-run `oxfmt` on the tables.

## Acceptance criteria

- [ ] The guide stores the `baseDiffHash` it was generated against; attaching a guide sets it.
- [ ] When `state.baseDiffHash` differs from the guide's, a subtle "may be stale" hint shows;
      re-attaching a fresh guide clears it.
- [ ] `skills/galley/SKILL.md` documents `galley guide`, the guide JSON schema, and the
      regenerate-after-reload flow; tables stay aligned (oxfmt) and prose is unwrapped.
- [ ] Graceful absence still holds (no guide → no hint, desk usable).

## Blocked by

- [01-attach-guide-and-overview-page.md](01-attach-guide-and-overview-page.md)
