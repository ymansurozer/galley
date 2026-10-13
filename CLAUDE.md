# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
pnpm release      # lint + check + test + build + smoke + changelogen --release --push
```

Run a single test file:

```bash
node --import tsx --test src/state.test.ts
```

CI (`.github/workflows/ci.yml`) runs lint, check, build, test, smoke — all must pass.

## Three compilation worlds

`src/` is split into a Node backend and two browser bundles, built and type-checked separately:

- **Backend** (`src/*.ts`, excluding `src/ui/` and `src/bridge/`): ESM with NodeNext resolution — intra-backend imports use `.js` extensions. Compiled by `tsc` to `dist/`. Entry: `src/cli.ts` (`dist/cli.js` is the published bin).
- **UI** (`src/ui/*.ts`): browser code (Alpine.js) bundled by esbuild from `src/ui/main.ts` into `dist/ui.js`; type-checked (noEmit) with `tsconfig.ui.json` (bundler resolution, DOM libs). All markup lives in `src/ui/index.html` (~4500 lines, copied verbatim to `dist/`), with `@pierre/diffs` rendering the diff.
- **Bridge** (`src/bridge/*.ts`): browser code that runs *inside the reviewed app's pages*, not the desk. The UI proxy injects it into every proxied HTML page. esbuild bundles `src/bridge/main.ts` into `dist/bridge.js` (an IIFE), and `tsconfig.bridge.json` type-checks it (noEmit, DOM libs). Its only channel is tokenized `postMessage` to the desk tab; it never calls the desk API.

The worlds do not import each other at runtime. `src/types.ts` is the single source of truth for the shared shapes (ReviewState, ReviewResult, Guide, the bridge ↔ desk messages, …); `src/ui/types.ts` (and `src/ui/walkthrough.ts`) and the bridge import what they need via `import type { ... } from "../types"` — type-only, erased by esbuild, so no backend code ships in a browser bundle and the runtime boundary holds. Change a wire type in `src/types.ts` alone; the UI and bridge pick it up through the type import.

## Architecture

**Backend flow:** `cli.ts` parses args and dispatches: desk starts (`galley`, `galley file <path>`, `galley pr <ref>`) build a `ReviewState` and call `startServer`; agent subcommands (`await`, `comment`, `reload`, `ui`) find the live desk and talk to it over HTTP. `git.ts` is the git plumbing + unified-diff parser. `state.ts` is the core: builds/merges/persists `ReviewState`, derives change blocks and their `stableKey`/`contentHash`, reconciles decisions across reloads, and manages desk locks + deterministic ports. `server.ts` is the HTTP server: serves the UI, exposes `/api/*` (state poll, comment, reload, decisions, and the long-poll `/api/await-send` that backs `galley await`). `proxy.ts` is the UI proxy: a second listener per desk, started once the state has a UI target (`--ui` / `galley ui`). It reverse-proxies the agent's loopback dev server so the desk's UI view can frame the app on a different origin, and it injects the bridge into every page.

**Key invariants in `state.ts`:**

- `Decision` records (keyed `path:stableKey`) — not git staging and not the rendered diff — are the source of truth for accept/reject. They survive reloads even when accepting staged the hunk out of the working-tree diff.
- `contentHash`/`reviewedHash` pairs detect staleness: if the agent rewrites a block (or a file) after it was decided/approved, the decision/approval resets to pending on reload. The same pattern invalidates comment anchors (`anchorText` → re-anchoring → `unanchored`) and guides (`baseDiffHash`).
- Desks are idempotent per repo+session: `stablePort` hashes repo+session to a port in 41000–50999 so a restarted desk binds the same origin and an open tab self-heals; a desk lock file is trusted only if the server actually answers (`deskAlive`).

**Agent contract:** plain JSON on stdout. `galley await` long-polls and prints one tagged event — `{"kind":"question",…}` (answer now via `galley comment`) or `{"kind":"review","result":{…ReviewResult…}}` (the reviewer hit Send). The contract is the single source of truth in `src/spec.ts` (printed by `galley spec`); the skill (`skills/galley/SKILL.md`) and the AGENTS.md snippet (`skills/galley/agents-snippet.md`) are bootstrap-only and point consuming agents at `galley spec`, and the server's error responses do too. **If you change the CLI flags, events, or ReviewResult shape, update `src/spec.ts` in the same change.** `scripts/smoke.mjs` and `src/spec.test.ts` exercise this contract and are the regression net for it.

**UI:** an Alpine.js app with a global store (`src/ui/store.ts`); `poll.ts` polls `/api/state`, `render.ts` renders the diff via `@pierre/diffs` (which renumbers lines per render — display anchors are derived, raw file lines stay canonical), `keys.ts` holds the keyboard-first command map, and `guide.ts`/`tree.ts`/`decisions.ts` etc. are feature modules.

## Conventions

- Commits follow **Conventional Commits** (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, …). `changelogen` groups them into the changelog and infers the semver bump, so the prefix matters — use `feat:` for user-facing additions and `fix:` for bug fixes.
- Comments in this codebase explain *why* and record invariants (see `state.ts`, `types.ts`); match that style.
- Formatting/linting is oxfmt/oxlint — run `pnpm lint:fix` rather than hand-formatting.
- Version bumps and CHANGELOG are handled by `changelogen` via `pnpm release` (tag push triggers the npm publish workflow); don't edit CHANGELOG.md or the version by hand.
