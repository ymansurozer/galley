# Review instructions

Galley is a review desk. The reviewer's work lives in a browser tab and on the desk. The agent receives it through `galley await`. `AGENTS.md` holds the architecture and the agent-contract invariants. This file says what to flag beyond them, and at what severity. A diff can pass every check and still break one of the rules below. Review each changed file against every rule that applies to it.

## Severity

- **P1**: loses, reverts, or silently changes something the reviewer owns, or lets a stale tab do so.
- **P2**: a lane that one summing surface counts and another leaves out, or a contract-hygiene miss from the list below.

A defect that was already there stays pre-existing, even when the diff touches its line. If the diff adds a lane, though, a surface that leaves that lane out is this diff's finding.

## Verification bar

- Every finding cites `file:line`, and a behavior claim comes from reading the code path.
- Before you call something a race, name both interleaved paths: which tab or poll writes, and which response lands last.

## Do not report

- Anything CI enforces: `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm build`, `pnpm smoke`, `pnpm perf-smoke`.
- `CHANGELOG.md` and the version; `changelogen` writes them.
- Prose under `.desk/**`.

## Always check

### Reviewer-owned state survives the real world (P1)

Reviewer-owned state is everything the reviewer made: `Decision` records, file and part approvals, comments and replies on code, UI annotations, topic and Overview threads, and resolved or answered marks. For every change that writes, merges, replaces, or resets any of it, trace these four cases through the code. Report each one the diff gets wrong:

- **A second tab that is behind.** Tab B last polled before tab A saved, and now B saves its copy. A's work must survive. The desk enforces this in the `/api/*` handler, which for a save is `mergeReviewerSave` in `src/state.ts`. A guard that runs only in the tab is a finding, because the stale tab is exactly the one that skips it.
- **A delayed or failed response.** The save errors, or it answers after the next poll has landed. The tab keeps the unsaved edit and shows the failure. A late answer must not overwrite newer state, either in the tab or on the desk.
- **Reset.** `/api/reset` clears what it promises and nothing else. A tab that was open across the reset must not save its old state back.
- **A desk restart.** The state persists, `loadLatestReview` reads it back, and `mergeReviewState` merges it into the next start's state. A new field that is not persisted, or that the merge drops, resets on restart.

Every branch in `src/ui/poll.ts` that replaces tab state from the desk's copy keeps what the tab has not yet saved. This covers the guide-swap branch and any new branch. Unsaved work is a thread or a reviewer message that the tab holds but neither the desk's list nor the confirmed copy has. Only what the confirmed copy has and the desk dropped stays dropped.

### Every lane is counted everywhere (P2)

The lanes are Code, App (UI), topics, and the Overview. A change that adds a lane, or makes an existing lane hold something new that is counted, must count it on every surface that sums across lanes. It must use the same words the other lanes use, and it must not state one number twice in two wordings. Read every surface on this list, not only the ones the diff touches:

- The Send dialog's heading and its "Not sent" line (`openSendModal` in `src/ui/main.ts`, `src/ui/send-derive.ts`, `src/ui/uilane-derive.ts`, `topicSendParts` in `src/ui/topicthreads-derive.ts`). The heading never says "No change requests" while any lane has one open.
- The blockers chip (`src/ui/blockers.ts`).
- The Change requests list and the `]` / `[` walk (`src/ui/requests-derive.ts`, `src/ui/requests.ts`, `src/ui/keys.ts`).
- `ReviewResult` in `src/types.ts`, and what `/api/await-send` sends.
- The contract in `src/spec.ts` (`galley spec`), and `scripts/smoke.mjs`.

A surface that leaves the lane out is a finding, even when the diff never touched that surface.

### Contract hygiene (P2)

- New or changed contract text in `src/spec.ts` gets an assertion in `src/spec.test.ts` that pins it.
- A new guide refusal (a `reason` from `validateGuide` and its helpers in `src/guide.ts`) follows its siblings' wording. That wording is a dotted path to the field, then what it must be, as in `guide.stages must be a non-empty array`.
- A new exported type or function carries a comment stating what it guarantees and who relies on that guarantee.
- A test goes in the test file of the module it exercises, not in the test file of whichever module the diff happened to touch.
- Each compilation world (backend, UI, bridge) may need its own copy of a parser or derivation, because the worlds cannot import each other at runtime. Every copy then carries a comment naming the other copy, and saying the two must change together.
