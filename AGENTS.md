# AGENTS.md

This file provides guidance to coding agents working with code in this repository. `CLAUDE.md` is a symlink to it.

## What this is

Galley is a CLI (`galley`) that serves a localhost browser UI for reviewing a git diff. A human reviews (accept/reject changes, comment, ask questions), and a coding agent attaches to the same desk via CLI subcommands to receive the review, reply, and re-diff its edits into the open tab. No model runs inside Galley — it is a protocol + interface only.

## Commands

```bash
pnpm dev          # esbuild --watch for the UI and bridge bundles + run the CLI from source via tsx
pnpm build        # tsc (backend) + UI and bridge typechecks + esbuild bundles + copy index.html
pnpm check        # typecheck all three worlds, no emit
pnpm lint         # oxlint + oxfmt --check
pnpm lint:fix     # oxlint --fix + oxfmt (formats)
pnpm test         # node:test via tsx, all src/**/*.test.ts
pnpm smoke        # end-to-end agent-contract test against dist/ — requires pnpm build first
pnpm perf-smoke   # perf budgets against dist/ — requires pnpm build first
pnpm release      # CI checks, then changelogen --release --push --no-github
```

Check a guide, or reread one section of the contract, without starting a desk. Before a release, run the built local CLI: `pnpm build`, then `node dist/cli.js` stands in for `galley`.

```bash
galley guide check <file> [--base <ref>]   # the guide's schema, and every span on a changed line of the diff
galley spec --section <name>              # one section of `galley spec`; `galley spec --help` lists them
```

Run a single test file:

```bash
node --import tsx --import ./scripts/test-deadline.mjs --test src/state.test.ts
```

CI (`.github/workflows/ci.yml`) runs lint, check, build, test, smoke, perf-smoke.

## Testing a desk

A desk writes settings, locks and saved reviews under `$HOME/.galley`, so a desk started with the real `HOME` rewrites the user's own. Test against a sandbox desk instead:

1. `pnpm build`, then `pnpm --silent desk:sandbox`. It gives the desk a throwaway `HOME`, a fixture repo and a loopback port in 5100–5299, and prints one JSON line once the desk serves the fixture. To test Decisions mode, run `pnpm --silent desk:sandbox --guide`: it attaches a topics guide and seeds a topic thread before printing the JSON line.
2. Read that line's fields with `jq -r`. `url` is the desk. `repo` is the fixture: edit it, then `reload`. `cli` is a shell template: replace `<command>` with a subcommand (`await`, `comment`, `reload`, `ui`, `stop`) and keep the printed environment prefix, `--repo` and `--session` so it reaches the fixture.
3. Check the page with `pnpm --silent desk:browse <url> [--screenshot <png>]`. It opens every file the desk serves in headless Chromium and fails when a file's row, its changed lines (or a pure rename's notice) don't render, or when the page throws; console errors are reported without failing. On a desk with a topics guide it walks the files in Code mode, then opens Decisions on the first topic with a thread (or the first topic). The topic and its threads must render before it takes a screenshot. Run it, and any script importing `chromium` from `playwright-core`, with the real `HOME`, where Playwright's browser cache is; if Chromium is missing, run `pnpm exec playwright-core install chromium`.
4. Stop it with `kill <pid>` (the `pid` field), Ctrl-C, or the template's `stop`. Each stops the desk and deletes the sandbox. A signal sent to `pnpm` alone never reaches it.

## Three compilation worlds

`src/` is split into a Node backend and two browser bundles, built and type-checked separately:

- **Backend** (`src/*.ts`, excluding `src/ui/` and `src/bridge/`): ESM with NodeNext resolution — intra-backend imports use `.js` extensions. Compiled by `tsc` to `dist/`. Entry: `src/cli.ts` (`dist/cli.js` is the published bin).
- **UI** (`src/ui/*.ts`): browser code (Alpine.js) bundled by esbuild from `src/ui/main.ts` into `dist/ui.js`; type-checked (noEmit) with `tsconfig.ui.json` (bundler resolution, DOM libs). All markup lives in `src/ui/index.html` (copied verbatim to `dist/`), with `@pierre/diffs` rendering the diff. Styles live in `src/ui/styles/*.css`: `main.ts` imports `index.css`, so esbuild emits `dist/ui.css` beside `ui.js` (served at `/ui.css`). `tokens.css` holds the semantic token layer — the dark default and the `:root[data-theme="light"]` palette — and every other sheet styles through those tokens. Shortcuts are drawn as keycaps by `keycaps.ts` (the `x-keys` directive, `data-tip-keys` on tooltips), never as inline text.
  The diagram renderer (`src/ui/diagrams.ts`) is its own esbuild entry, emitted as `dist/diagrams.js` and served at `/diagrams.js`. It is imported at run time the first time a body with a diagram shows, keeping Pele out of `ui.js` and its size gate.
- **Bridge** (`src/bridge/*.ts`): browser code that runs _inside the reviewed app's pages_, not the desk. The UI proxy injects it into every proxied HTML page. esbuild bundles `src/bridge/main.ts` into `dist/bridge.js` (an IIFE), and `tsconfig.bridge.json` type-checks it (noEmit, DOM libs). Its only channel is tokenized `postMessage` to the desk tab; it never calls the desk API.

The worlds do not import each other at runtime. `src/types.ts` is the single source of truth for the shared shapes (ReviewState, ReviewResult, Guide, the bridge ↔ desk messages, …); `src/ui/types.ts` (and `src/ui/walkthrough.ts`) and the bridge import what they need via `import type { ... } from "../types"` — type-only, erased by esbuild, so no backend code ships in a browser bundle and the runtime boundary holds. Define shared wire shapes in `src/types.ts`; the UI and bridge pick them up through type imports.

## Architecture

**Backend flow:** `cli.ts` parses args and dispatches: desk starts (`galley`, `galley file <path>`, `galley pr <ref>`) build a `ReviewState` and call `startServer`; agent subcommands (`await`, `comment`, `reload`, `ui`) find the live desk and talk to it over HTTP. `git.ts` is the git plumbing + unified-diff parser. `state.ts` is the core: builds/merges/persists `ReviewState`, derives change blocks and their `stableKey`/`contentHash`, reconciles decisions across reloads, and manages desk locks + deterministic ports. `server.ts` is the HTTP server: serves the UI, exposes `/api/*` (state poll, comment, reload, decisions, and the long-poll `/api/await-send` that backs `galley await`). `proxy.ts` is the UI proxy: a second listener per desk, started once the state has a UI target (`--ui` / `galley ui`). It reverse-proxies the agent's loopback dev server so the desk's UI view can frame the app on a different origin, and it injects the bridge into every page.

**Key invariants in `state.ts`:**

- `Decision` records (keyed `path:stableKey`) — not git staging and not the rendered diff — are the source of truth for accept/reject. They survive reloads even when accepting staged the hunk out of the working-tree diff.
- `contentHash`/`reviewedHash` pairs detect staleness: if the agent rewrites a block (or a file) after it was decided/approved, the decision/approval resets to pending on reload. The same pattern invalidates comment anchors (`anchorText` → re-anchoring → `unanchored`) and guides (`baseDiffHash`).
- Desks are idempotent per repo+session: `stablePort` hashes repo+session to a port in 41000–50999 (or the operator's `GALLEY_PORT_RANGE`, resolved once in `cli.ts` and passed down) so a restarted desk binds the same origin and an open tab self-heals; a desk lock file is trusted only if the server actually answers (`deskAlive`).

**Agent contract:** plain JSON on stdout. `galley await` long-polls and prints one tagged event — `{"kind":"question",…}` or `{"kind":"review","result":{…ReviewResult…}}` (the reviewer hit Send). A question event batches every pending question in `questions`: answer each in its own lane, then await again; `galley spec` has the per-lane handling. The contract is the single source of truth in `src/spec.ts` (printed by `galley spec`); the skill (`skills/galley/SKILL.md`) and the AGENTS.md snippet (`skills/galley/agents-snippet.md`) are bootstrap-only and point consuming agents at `galley spec`, and the server's error responses do too. **If you change CLI flags, events, the ReviewResult shape, or a topic part kind, update `src/spec.ts` and its test coverage in the same change.** `REVIEW.md`'s Contract hygiene lists what review holds such a change to. `scripts/smoke.mjs` and `src/spec.test.ts` exercise this contract and are the regression net for it.

**UI:** an Alpine.js app with a global store (`src/ui/store.ts`); `poll.ts` polls `/api/state`, `render.ts` renders the diff via `@pierre/diffs` (which renumbers lines per render — display anchors are derived, raw file lines stay canonical), `keys.ts` holds the keyboard-first command map, and `guide.ts`/`tree.ts`/`decisions.ts` etc. are feature modules.

## Conventions

- Record conventions, gotchas, recipes, and known flakes in `AGENTS.md` or a repo doc linked here so every account and Codex can find them. Keep personal preferences in per-account agent memory.
- Commits follow **Conventional Commits** (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, …). `changelogen` groups them into the changelog and infers the semver bump, so the prefix matters — use `feat:` for user-facing additions and `fix:` for bug fixes.
- Comments in this codebase explain _why_ and record invariants (see `state.ts`, `types.ts`); match that style.
- Formatting/linting is oxfmt/oxlint — run `pnpm lint:fix` rather than hand-formatting.
- Version bumps and CHANGELOG are handled by `changelogen` via `pnpm release` (tag push triggers the npm publish workflow); don't edit CHANGELOG.md or the version by hand.
- Releases go through `pnpm release` only. Pin a version with `pnpm release -r X.Y.Z`: below 1.0, a `feat` bumps only the patch. The release workflow creates the GitHub Release once the tag lands, which is why the script passes `--no-github`. Don't run a bare `changelogen --release` without it. Its local GitHub sync would make GitHub create the tag on main's head, on the wrong commit, and start a release from there.
