---
status: open
created_at: 2026-06-03
---

## Problem Statement

The entire UI is one hand-rolled `ui.html` with inline CSS and a single `<script>`. It worked
to get Galley going, but it's becoming hard to maintain as features pile up (guided sidebar,
settings, richer comments). There are also concrete UX gaps today:

- A manual **Save** button exists even though every change can just auto-save.
- Comments can't be **edited or deleted** (only added/resolved/reopened).
- Comments render as **plain text** — no markdown, no code highlighting — so they look poor and
  code snippets are unreadable.
- There are **no user settings** — font, diff-view style, file-tree options, and color themes
  are fixed.

## Solution

First make the **architecture decision** — keep the single `ui.html` or migrate to a React +
shadcn app — because it gates how the rest is built. Then deliver the UX improvements:

- **Auto-save everything**; remove the Save button (keep Reset and Send to agent).
- **Edit and delete comments.**
- **Markdown rendering** for comment bodies with **code syntax highlighting**.
- A **settings panel**: font, diff-view options (split/stacked, word/line diff), file-tree
  options, diff theme, and code-highlight theme.

## User Stories

1. As a maintainer, I want a decision on whether to migrate to React + shadcn, so that I stop
   accreting features in an unmaintainable single file or commit to keeping it lean.
2. As a maintainer, I want the server to keep serving a built asset regardless of the UI stack,
   so that the zero-dependency runtime story is preserved.
3. As a reviewer, I want every change saved instantly, so that I never lose work and never
   wonder whether I saved.
4. As a reviewer, I don't want a Save button cluttering the toolbar, so that the only actions
   are Reset and Send to agent.
5. As a reviewer, I want to edit a comment I wrote, so that I can fix or refine it.
6. As a reviewer, I want to delete a comment I wrote, so that I can remove one I no longer want.
7. As a reviewer, I want my edits/deletes reflected in what gets sent to the agent, so that the
   `ReviewResult` matches what I see.
8. As a reviewer, I want comment bodies rendered as markdown, so that lists, emphasis, and
   structure are readable.
9. As a reviewer, I want code blocks in comments syntax-highlighted, so that code I paste or
   the agent posts is legible.
10. As a reviewer, I want markdown rendering to be safe (no script injection), so that comment
    content can't compromise the desk.
11. As a reviewer, I want to choose the font/family used in the desk, so that it's comfortable
    to read.
12. As a reviewer, I want to set the diff view style (split/stacked, word vs line diff), so
    that diffs match how I like to read them.
13. As a reviewer, I want file-tree options, so that the tree behaves the way I prefer.
14. As a reviewer, I want to pick the diff color theme and the code-highlight theme, so that the
    desk matches my taste and is easy on the eyes.
15. As a reviewer, I want my settings to persist across sessions, so that I set them once.
16. As a reviewer, I want both my comments and the agent's comments rendered consistently, so
    that the thread reads cleanly.

## Implementation Decisions

- **Architecture decision is a gating spike.** Evaluate keeping `ui.html` (modularized) vs a
  React + shadcn app built with a bundler (e.g. Vite) whose output the existing server serves
  statically. Decision criteria: maintainability as features grow, bundle size, dev loop, and
  preserving the zero-dependency *server* (build-time deps are fine; runtime stays lean). The
  outcome is a short decision doc plus, if migrating, a thin scaffold. The edit/delete,
  markdown, and settings items are built on the chosen stack.
- **Auto-save.** Remove the Save button; every mutation (comment add/edit/delete/resolve,
  decision, viewed flag) persists immediately (debounced). Toolbar = Reset + Send to agent.
- **Edit/delete comments.** Comment actions mutate `ReviewState.comments` and persist;
  reflected in `buildReviewSummary`/`buildReviewResult`. Deleting an agent comment is allowed
  too (the reviewer owns their desk).
- **Markdown comments.** Render bodies with a CommonMark renderer plus a syntax highlighter,
  with output sanitized. Applies to user and agent comments. (Library choice — e.g.
  markdown-it/marked + highlight.js/shiki — is settled in the architecture spike to match the
  chosen stack.)
- **Settings.** A settings store persisted client-side (and surfaced in a settings UI):
  font/family, diff style (split/stacked, word/line), file-tree options, diff theme,
  code-highlight theme. Diff/highlight themes are presets, not a full theming engine.
- **Modules.** A comment-render module (markdown string → safe HTML) and a settings store are
  the isolatable pieces; the rest is UI wiring.

## Testing Decisions

- This PRD is UI-heavy, so most validation is via running the app (the `run`/`verify` flows),
  not unit tests. A good unit test here covers the **pure transforms**: comment markdown →
  sanitized HTML (correct rendering, no script execution) and settings serialization round-trip.
- **Modules to test:** the comment-render transform (markdown + highlight + sanitize) and the
  settings store (persist/load round-trip). Edit/delete is validated through the comment-state
  mutations (reuse the state tests) and a manual run.
- **Prior art:** the `node:test` setup from earlier PRDs for the pure transforms; manual
  end-to-end via the project's run flow for the interactive pieces.

## Out of Scope

- A full visual redesign beyond these four improvements.
- A general theming engine (themes are a fixed set of presets).
- Mobile/responsive overhaul.
- Server-side settings sync across machines (client-persisted is enough for now).

## Further Notes

The architecture decision blocks edit/delete, markdown, and settings — those are squarely "UI
features" that would be rebuilt in a migration, so they wait on it. Auto-save is small and
stack-agnostic enough to land independently. Guided review (separate PRD) also adds sidebar
surface, so its UI work should follow the same decision.
