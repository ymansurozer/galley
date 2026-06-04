# Galley

Standalone browser-based Galley for git working tree or staged diffs. A human reviews
the diff — accepting/rejecting changes and leaving comments — then clicks **Send to Agent**,
which hands a structured review back to a waiting coding agent.

## Run

```bash
pnpm install
pnpm dev -- --repo /path/to/repo
```

Options:

```bash
pnpm dev -- --repo . --diff working
pnpm dev -- --repo . --diff staged
pnpm dev -- --repo . --session feature-x        # defaults to current branch
pnpm dev -- --repo . --port 5173 --no-open
```

## How the agent loop works

The desk is a **living** surface — it stays open across rounds; the human never has to close
or reopen the tab.

1. The agent starts `galley --session <id>` in the background. It opens the tab and keeps
   serving. The banner goes to **stderr**.
2. The agent loops on `galley await --session <id>`, which blocks until the human clicks
   **Send to Agent** and then prints the `ReviewResult` to stdout.
3. The agent acts on it, and can `galley comment --session <id> --path … --body "…"` to
   reply — the reply appears in the open tab within ~1.5s, threaded under the human's comment.
4. The human keeps reviewing in the same tab; the agent loops back to `await`.

Code edits the agent makes are not re-diffed into the open desk; restart the desk to surface a
fresh diff (decisions reconcile — a hunk whose content changed resets to pending).

The full agent-facing contract and installable skill is
[`skills/galley/SKILL.md`](./skills/galley/SKILL.md) — install it into any agent
with `npx skills add <owner>/galley`.

## Review identity & storage

A review is keyed by repo + session (the session defaults to the current branch). HEAD and
the diff hash are kept as staleness metadata, not identity, so a new commit doesn't orphan a
review. State is persisted outside the repo under:

```txt
~/.galley/<repo-hash>/<session>/
```

While a desk is open it writes `<session>/desk.lock`; agents must not edit tracked files
while that lock exists.

## Buttons

Every change — decisions, comments, staging, viewed marks — is **saved automatically** as you
make it (resume any time by reopening the desk), so there are just two buttons:

- **Reset Review** — clear decisions/comments and unstage everything for this review.
- **Send to Agent** — hand the current review to the waiting agent; the desk stays open and
  shows the agent's replies as they arrive.

## Roadmap

Ordered roughly by sequence: **infra & robustness first**, then review capabilities, then
the guided review, then UI work, then distribution.

### Infra & robustness (do first)

- [x] **`galley await` long-poll robustness** — the server holds the request for 1 hour, but
      the client uses global `fetch` (undici), whose default `headersTimeout` (~5 min) aborts a
      header-less long-poll early, so `await` returns empty after ~5 min regardless. Fix: give
      the client a custom undici dispatcher with `headersTimeout: 0`, and add `galley await
      --timeout <s>` (server returns `204` → empty stdout) so short-timeout harnesses can
      re-poll on a tolerable cadence instead of being killed mid-wait.
- [x] **Live `reload` endpoint** — re-diff the working tree into the open desk so the agent's
      *code edits* appear in the same tab without a restart (today only comments stream live).
      Rebuild state from the current diff, merge with prior decisions (reuse the staleness
      logic), and have the browser poll pick up diff changes without clobbering in-progress edits.

### Review capabilities

- [x] **File review mode + single-file simplified view** — `galley file <path>` for one file,
      tracked or untracked/new (e.g. a generated plan): full file when unchanged, diff when
      changed. Tracked+changed stages on accept; untracked is verdict-only. Tree auto-hidden
      when only one file is in the review.
- [x] **PR review mode** — `galley pr <ref>` checks out the branch (aborts if tracked changes
      are uncommitted), diffs against the merge-base, and accept/reject become approve /
      request-changes verdicts (no staging). _gh PR-number fetch is out of scope; branch names only._

### Guided review

- [ ] **AI-guided review in the right sidebar** — overall changeset overview → optional PR
      description → logical file order (general→specific) with a concise per-file summary shown
      before each diff → highlight the most critical changes. Turns a pile of changes into a
      guided overview → summary → diff → next flow.

### UI

- [x] **UI architecture** — modular `src/ui/` ES modules bundled by esbuild → `dist/ui.js`.
      The chrome (file tree, toolbar, composer, modals, toast) is reactive via **Alpine.js**
      over a single reactive store (`store.S`); the diff is an imperative `@pierre/diffs`
      island kept in a non-reactive holder (`store.D`) + `x-ignore`. `alpinejs`,
      `@alpinejs/persist`, and `@pierre/diffs` are all bundled (no CDN; ~9.5MB ui.js, fine for
      a localhost tool). Unblocks the polish items below.
- [ ] **Comark markdown rendering** — render markdown files (e.g. plans) with comark instead of
      raw text, with rendered-comment anchoring. Deferred here because comark is framework-first
      and the anchoring model should be built on the stack chosen above.
- [x] **Auto-save; remove the Save button** — every change persists instantly via `persist()`
      after each mutation; the toolbar keeps only Reset Review and Send to Agent.
- [ ] **Edit & delete comments** — manage your own comments, not just add/resolve.
- [ ] **Markdown comments** — render comment bodies with a CommonMark renderer + code
      highlighting.
- [ ] **Settings** — font, diff-view options, file-tree options, diff theme, code-highlight theme.

### Distribution

- [ ] **Per-agent instruction blocks** — Codex (`AGENTS.md`) and Pi config snippets for the
      start → `await` → act → `comment` → `await` loop; test end-to-end with each.
- [ ] **Documented file-poll fallback** — for agents that can't long-poll or background a
      process: each Send writes `artifacts.resultJson`, so the agent can just stat that file.
- [ ] **CI & release automation** — a solid CI pipeline (lint, typecheck, build, tests on every
      PR) plus an automated release flow: merges to `main` trigger semantic versioning and a
      tagged release (changelog, npm publish/binaries), with GitHub branch protection on `main`
      (required status checks, PR review before merge, linear history).
