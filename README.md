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
2. The agent loops on `galley await --session <id>`, which blocks until the next desk event
   and prints a tagged JSON envelope to stdout: `{kind:"question",…}` (the human asked a
   question — answer it live) or `{kind:"review",result:{…}}` (the human clicked **Send**).
3. The agent acts on it, and can `galley comment --session <id> --path … --body "…"` to
   reply — the reply appears in the open tab within ~1.5s, threaded under the human's comment.
4. After editing code the agent runs `galley reload --session <id>` to re-diff the working
   tree into the open tab (decisions reconcile — a hunk whose content changed resets to
   pending), then loops back to `await` for the next round. The desk stays open throughout.

The full agent-facing contract and installable skill is
[`skills/galley/SKILL.md`](./skills/galley/SKILL.md) — install it into any agent with `npx
skills add <owner>/galley`. To make an agent *always* review via Galley, paste the standalone
[`skills/galley/agents-snippet.md`](./skills/galley/agents-snippet.md) into its `AGENTS.md` /
`CLAUDE.md`; the snippet refers back to the skill for details.

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

Every change — decisions, comments, staging, file approvals — is **saved automatically** as you
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
      changed. Tracked+changed stages on approve; untracked is verdict-only. Tree auto-hidden
      when only one file is in the review.
- [x] **PR review mode** — `galley pr <ref>` checks out the branch (aborts if tracked changes
      are uncommitted), diffs against the merge-base, and accept/reject become approve /
      request-changes verdicts (no staging). _gh PR-number fetch is out of scope; branch names only._

- [x] **Ask the agent (just-in-time questions)** — a comment can be an **Ask** (a question the
      agent answers live, in the thread) or a **Request change** (queued for Send). `galley await`
      is a tagged event stream (`{kind:"question"|"review"}`); the agent answers questions with
      `galley comment` and acts on the review on Send. Questions never enter the handoff.

### Guided review

- [x] **AI-guided review** — the agent attaches a guide at start (`galley … --guide <file>`):
      an overview page (title + changeset overview + optional PR description + a count-fill
      category plan), then files walked in a logical order (general→specific) with a per-file
      change category + summary in the diff header and the critical ones flagged. Top bar drives
      Next/Prev + progress; approving (or marking reviewed) a file advances. Galley runs no model — it renders +
      validates the guide and flags it stale when the diff moves past it. (Built as vertical
      slices; design in `prototypes/`, PRD + issues in `.prd/guided-review/`.)
- [ ] **Anti-hedging guide-authoring rules** — tighten the guide spec / skill instructions with
      explicit anti-hedging language (ban "appears / seems / might / likely / probably / I think";
      demand "This change introduces… / moves… / is needed because…"; describe only what the diff
      supports, state concrete uncertainty otherwise). Cheap copy-edit that raises the quality of
      agent-authored summaries and seeded comments. (Borrowed from codiff's review-assist prompt.)
- [ ] **Anchor repair instead of stale-flagging** — when re-diffing on `reload`, try to re-anchor
      each guide entry to its nearest surviving section/line before declaring the guide stale, so a
      guide degrades gracefully across rounds (the agent edits between rounds — Galley's hot path)
      instead of invalidating wholesale on any drift. Keep clean "vanished → stale" semantics for
      anchors that genuinely no longer resolve. (Borrowed from codiff's walkthrough anchor repair.)

### UI

- [x] **UI architecture** — modular `src/ui/` ES modules bundled by esbuild → `dist/ui.js`.
      The chrome (file tree, toolbar, composer, modals, toast) is reactive via **Alpine.js**
      over a single reactive store (`store.S`); the diff is an imperative `@pierre/diffs`
      island kept in a non-reactive holder (`store.D`) + `x-ignore`. `alpinejs`,
      `@alpinejs/persist`, and `@pierre/diffs` are all bundled (no CDN; ~9.5MB ui.js, fine for
      a localhost tool). Unblocks the polish items below.
- [x] **Markdown file rendering** — in file mode, markdown files render formatted (markdown-it)
      with a **Rendered / Source** toggle. Comment directly on rendered blocks: markdown-it's
      `token.map` gives each block its exact source line, so a block comment is a normal
      line-anchored comment (works the same in the Source/diff view). New/untracked files open
      Rendered; changed files open Source.
- [x] **Auto-save; remove the Save button** — every change persists instantly via `persist()`
      after each mutation; the toolbar keeps only Reset Review and Send to Agent.
- [x] **Edit & delete comments** — edit/delete your own comments (agent replies stay
      read-only); edits show an "edited" marker. Auto-saved like every other change.
- [x] **Markdown comments** — comment bodies render as markdown via **markdown-it** with
      Shiki-highlighted code blocks. Output is sanitized (`html: false` + DOMPurify)
      because agent replies are rendered too.
- [x] **Settings** — a gear-triggered panel (persisted to localStorage): diff options
      (layout, intra-line, indicators, hunk separators, wrapping), a shared code-highlight
      theme (diff + comment code), mono font + size, show-unchanged-files, and a
      stage-on-accept toggle (off = verdict-only; PR mode is always verdict-only).

### Distribution

- [x] **Agent contract: one complete skill + paste-in snippet + e2e** — the loop is
      agent-agnostic, so instead of per-agent blocks there's one full reference skill
      (`skills/galley/SKILL.md`: modes, the await event loop, every CLI option, `ReviewResult`)
      you `npx skills add` for explicit use, plus a separate standalone snippet
      (`skills/galley/agents-snippet.md`) you paste into any agent's `AGENTS.md` / `CLAUDE.md` so
      it always reviews via Galley — the snippet refers back to the skill for details. `pnpm
      smoke` drives the full `await` event-stream loop end-to-end (question → answer → Send →
      ReviewResult) on a throwaway repo as a kept check.
- [ ] **App-served guide spec + thin skill shim** — move the guide data-model + authoring rules
      out of the skill and into the binary (`galley guide-spec` prints the current schema + rules
      to stdout); the installed skill fetches it at runtime instead of hardcoding it, so the skill
      can't drift from the user's installed `galley`. Keep the human-facing reference in SKILL.md,
      but make the *machine* contract come from the binary. (Borrowed from codiff's
      `--walkthrough-guide`; highest-leverage robustness win for the skill-install distribution.)
- [x] **Documented file-poll fallback** — for agents that can't long-poll or background a
      process: each Send (over)writes `artifacts.resultJson`, so the agent polls that file
      instead of `galley await`. Documented in `skills/galley/SKILL.md` (File-poll fallback).
- [x] **Keyboard shortcuts** — full keyboard navigation (Gerrit-style): `]`/`[` files, `j`/`k`
      lines, `n`/`p` changes, `a`/`x` accept/reject, `c` comment, `f` approve, `?` help overlay.
- [x] **UI Polish**: 
- [ ] **Command palette** — add a discoverable Cmd/Ctrl+Shift+P palette for common review
      actions: file filter, find in diffs, next/previous file or change, accept/reject/request
      change, approve file, toggle layout/settings/sidebar, open in editor, reload, and Send to
      Agent. Keep keyboard shortcuts as the fast path, but make every major action searchable.
- [ ] **Commit/range/branch review modes** — expand beyond working/staged/file/PR branch
      reviews with `galley commit <ref>`, `galley range <base>..<head>` / `<base>...<head>`, and
      `galley branch <base>` so Galley can review historical or comparison diffs without
      requiring a dirty working tree.
- [ ] **Open file in editor** — add a configurable editor command and UI/shortcut action to open
      the selected file at the current line from the review desk. Support placeholders like
      `{repo}`, `{file}`, and `{line}` and keep it safe for repo-relative paths.
- [ ] **Lazy diff/content loading + large/binary-file guards** — today `src/git.ts` reads full
      contents for *every* changed file up front (`git show` / `fs.readFile(…, "utf8")`, capped only
      by a 50 MiB `maxBuffer` crash guard) and ships it all in the initial state; the only large-file
      handling is client-side render deferral (`deferRender`'s "Rendering…" badge over
      `RENDER_INDICATOR_MIN_LINES`, plus the `DIFF_CACHE_CAP` LRU of warm @pierre instances), which
      only manages tokenization jank on content that's *already* loaded. Move the guard to the data
      layer: classify each file by byte size before loading and ship lightweight patch/summary data
      first, then hydrate full contents, highlighting, rendered markdown, and image details on demand
      when a file is opened. Borrow codiff's model — a per-file `loadState`
      (`ready | deferred | too-large | binary | error`) with two byte tiers (an *eager* limit, e.g.
      ~1 MiB, loaded up front; a *manual* limit, e.g. ~2 MiB, deferred until the user opens it; over
      that = `too-large`, skipped with a "File is N MB, so Galley skipped rendering it." summary and an
      explicit load-anyway action) plus an image byte cap. Add **binary detection** (NUL-byte scan)
      so binaries are skipped rather than read as UTF-8 and handed to @pierre — Galley has no binary
      guard today.
- [ ] **GitHub PR URL/number support** — let `galley pr 123` or a GitHub pull request URL resolve
      and fetch the PR branch/merge-base automatically. Keep Send-to-Agent as the primary output;
      any GitHub publishing should be optional and separate.
- [ ] **CI & release automation** — a solid CI pipeline (lint, typecheck, build, tests on every
      PR) plus an automated release flow: merges to `main` trigger semantic versioning and a
      tagged release (changelog, npm publish/binaries), with GitHub branch protection on `main`
      (required status checks, PR review before merge, linear history).
- [ ] **Release 0.1** — publish to npm, with a simple install script that adds the skill and snippet to the
      agent of choice, plus docs on manual installation and usage.
