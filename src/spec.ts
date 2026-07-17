// The machine contract for driving Galley as an agent. This is the SINGLE SOURCE OF TRUTH,
// printed by `galley spec` so an installed skill / AGENTS.md can fetch it at runtime instead
// of hardcoding a copy that drifts from the user's installed binary. It covers the full
// operational contract: review modes, the await/comment/reload loop, await exit semantics, the
// ReviewResult shape, how to act on a review, the guided-review schema, reload-vs-restart,
// concurrency, settings, and errors. Bootstrap-only material (what Galley is, when to use it,
// how to install it) lives in the skill/AGENTS.md, because you need it before running this.
//
// Written to be dense — every line carries a distinct fact. Keep it in sync with reality: if
// you change CLI flags, events, or the ReviewResult shape, update this string in the same
// change. `scripts/smoke.mjs` and `src/spec.test.ts` guard it.
export const SPEC = `galley agent contract

Galley serves a localhost browser desk over a git diff. A human accepts/rejects changes,
comments, and asks questions, then clicks Send to Agent; the desk stays live across rounds. You
attach via CLI subcommands — receive each Send, answer questions, post replies that appear live,
and re-diff your edits into the same tab. No model runs in the desk; the review is the human's.

## Review modes
Pick one at start. await/comment/status/reload auto-target the lone live desk and omit --session
below; --session at start (and restart) names the desk — needed only for a stable id or a second desk.
- repo (default) — \`galley\`: working-tree diff; \`--diff staged\` for the index; \`--path <p>\`
  limits to a path. Untracked (new) files show as full-file additions. Approve stages the file
  (toggle); accept/reject are verdicts. A moved file stages both its old and new paths as a rename.
- file — \`galley file <path>\`: one file, tracked or not. Unchanged → full file; changed → diff
  (stageable); untracked → full file, verdict-only. Markdown gets a Rendered/Source toggle —
  comment any rendered block. Use it to review an artifact (e.g. a generated plan).
- pr — \`galley pr <ref>\`: a branch's commits vs merge-base. <ref> = branch | PR number | GitHub
  URL (number/URL resolved via \`gh\`, which must be installed+authed). Checks out the branch
  (aborts if the working tree has uncommitted tracked changes); \`--base <ref>\` overrides the
  base. Verdict only: Approve = approve, reject = request-changes, no staging — you amend the
  branch and re-review.
ReviewResult.mode (repo|file|pr) tells you how to read verdicts.

## The loop
Start the desk in the background, then await events and branch on kind:
\`\`\`bash
galley --session <id> --diff working &
while ev=$(galley await); do
  [ -z "$ev" ] && continue                               # --timeout fired, no event
  case "$(jq -r .kind <<<"$ev")" in
    question)  # answer EACH — READ-ONLY (see Events); thread under each question's path/line/side
      jq -c '.questions[]' <<<"$ev" | while IFS= read -r q; do   # one object per line — space-safe
        galley status --body "Reading X to answer…"        # live progress
        galley comment --path "$(jq -r .path<<<"$q")" \\
          --line "$(jq -r .lineNumber<<<"$q")" --side "$(jq -r .side<<<"$q")" --body "…"
      done ;;
    review)    # act on the ReviewResult, then \`galley reload\` to show your edits
      r=$(jq .result <<<"$ev") ;;
  esac
done
\`\`\`
- \`galley await [--timeout <s>]\` — block for the next event, print one tagged JSON envelope,
  exit. No --timeout → holds open; --timeout <s> → empty stdout (204) after <s>s, re-poll. Exit
  non-zero = no live desk (start one). After handling ANY event, await again immediately — more
  may already be queued (the human keeps working while you act).
- \`galley comment --path <f> --line <n> [--side additions|deletions] --body "…"\` — agent reply.
  Live desk → posts over HTTP (~1.5s), threaded under the matching human comment; no desk →
  appended to the saved review. Match path/line/side. Agent comments are never echoed back as
  requestedChanges.
- \`galley status --body "…"\` — ephemeral one-line "doing X now" beside the reviewer's spinner.
  Cleared by your next comment; stale after ~90s (keep posting through long work); never
  persisted; exits 0 even with no desk.
- \`galley reload [--guide <file>]\` — re-diff the working tree into the live desk (your edits are
  NOT auto-re-diffed). Anything you edit resets to pending on reload — decisions, approvals, and
  skims alike; anything you left untouched carries over. --guide swaps the guide (one desk only —
  see Between rounds).
- \`galley stop [--session <id> | --all]\` — shut down this repo's live desk(s) (--all = every
  session). Idempotent, exits 0 with {stopped:[…]} whether or not a desk was running — call it
  when the review session is over (the human said done / the task is complete) so desks don't
  linger. All review state is persisted; a later start restores the session.

## Events
await yields exactly one:
- {"kind":"question","question":{path,lineNumber,side,body,mode,session},"questions":[…]} —
  reviewer wants an answer NOW. \`questions\` holds every question batched into this delivery
  (arrival order; \`question\` is the oldest, kept for compatibility) — answer EACH. A question wants
  an ANSWER, not a code change: answering is READ-ONLY — read for context, reply with \`galley
  comment\` at path/lineNumber/side, and NEVER edit tracked files (the "Between rounds" rule) unless
  the question's own text asks for a change (then edit + \`galley reload\`). Questions are a live
  side-channel — never in a Send/ReviewResult except openQuestions below. Slow answer → post
  \`galley status\` lines so the human sees progress.
- {"kind":"review","result":{…ReviewResult…}} — reviewer clicked Send. Act on result.

## ReviewResult
The \`result\` field of a review event:
- session, repoRoot, mode, staged, head (sha|null), baseDiffHash (hash of the reviewed diff)
- accepted[], rejected[]: {path, lineNumber, side, title}
- requestedChanges[]: {path, lineNumber, side, body}
- overallNote? — optional note about the WHOLE review (absent if blank): an overall remark, or an
  afterthought instruction for after applying (e.g. "run the formatter"). Not tied to any line.
- stagedFiles[], approvedFiles[]
- openQuestions[]: {path,lineNumber,side,body,mode,session} — questions you never answered, folded
  into this Send (superseding queued live question events). Answer each with \`galley comment\`
  (READ-ONLY, as a live question) while acting on the round.
- artifacts: {resultJson, sessionDir} under ~/.galley/<repoHash>/<session>/ (repoHash =
  sha256(abs repo root)[:16])
The arrays above ARE the review — act on them directly; there's no prose summary to parse.
Each changed file ends pending | approved (no objections → listed in approvedFiles) |
changes-requested (a rejected hunk and/or a requested change).
File-poll fallback (can't hold a long-poll / background the desk): every Send (over)writes the same
ReviewResult to artifacts.resultJson — watch sessionDir, read the newest *-result.json (new mtime =
new Send). Live questions arrive only via await, so a file-poller sees Sends but not Asks.

## How to act on a review — one path per item, don't mix
- rejected → revert that change; the reviewer doesn't want it.
- requestedChanges (a comment) → make the edit at path:lineNumber.
- accepted → leave it; don't re-touch.
- approvedFiles → signed off as-is; leave the whole file unless a requested change forces a touch
  (which re-opens it for re-review).
- stagedFiles → already staged by the reviewer; don't touch unless a requested change requires it.
In pr mode the diff is committed changes: amend the branch/commits to apply the review, leaving
approved hunks as-is (rather than editing the working tree).
Then \`galley reload\` to surface your edits, and \`galley await\` for the next round.

## Guided review (optional)
Attach with \`galley <mode> --guide <file>\`: an overview page + your files in order with per-file
orientation (schema below). Galley validates + renders it (markdown in prose fields, raw HTML
stripped) and runs no model — content and order are yours. Write the guide OUTSIDE the working tree
(temp or gitignored): working mode surfaces untracked files, so an in-repo guide shows as a stray
addition. Stamped to its diff and surviving reload/restart; once a reload advances past it it's
flagged stale — regenerate and swap via \`galley reload --guide <new>\` (one desk only — see Between
rounds).

### Guide JSON schema
One JSON object:
- title? — overview heading; falls back to branch/ref.
- overview (required, non-empty) — one-paragraph changeset overview.
- prDescription? — author/PR intent, shown on the overview page.
- files (required, non-empty array) — one entry per reviewed file:
  - path (required, non-empty) — repo-relative; must be a file in the diff.
  - orientation (required, non-empty) — the lens to read this file with: its role, the
    problem it solves, what to expect before opening it, what's non-obvious or worth
    scrutinizing. Orientation, not a changelog — the reviewer already sees the diff. Shown
    in the file's diff header.
  - order? — ascending review order; defaults to array position.
  - category? — group label (default "Changes"). Files group by adjacency in review order, so a
    label repeated non-adjacently makes a second section — keep a category's files together.
  - flag? — raises a flag on the file for closer scrutiny; the text is the note (what to
    double-check, what's risky). Omit unless the file genuinely warrants it.
  - skim? / skimReason? — mark the WHOLE file skimmable; skimReason is a short why ("generated",
    "lockfile churn"). See "When to skim / focused review".
  - skimBlocks? — collapse PARTS of the file: an array of { lines, reason? } where lines is a
    new-file-side [start, end] span (or a single line number) of the diff you read, and reason is a
    short label ("import-only"). The server resolves each span to the enclosing change block(s).
  - movedFrom? — repo-relative OLD path of a file you moved AND edited (this entry's \`path\` is the
    NEW path). The desk merges the deletion + untracked addition into one rename-changed entry so
    only the real edits show, with a "moved from" badge; its blocks are verdict-only (no per-block
    staging), and whole-file Approve stages both old and new paths as one rename. Working repo mode
    only; may carry a whole-file \`skim\` but NOT \`skimBlocks\`. On a new guide an unresolvable
    movedFrom aborts the launch naming it; on a carried-forward guide it drops silently, the pair
    falling back to delete+add. Pure (unedited) renames need no declaration — git detects committed
    ones and the desk auto-pairs identical-content working moves, both shown as a muted
    "renamed old → new · no changes" row (see the collapse note above).
- focused? — top-level boolean; badges the overview ("focused review — mechanical churn skimmed")
  so the human knows attention was deliberately shaped. Display-only.
A skimmed part collapses behind a one-click "expand" strip (nothing is ever hidden). A file skimmed
whole (or every block skimmed), or a pure rename, leaves the default flow — it drops into a collapsed
"Skimmed" group with no progress or completion weight, so skim only what genuinely needs no eyes.

### When to skim / focused review
Skim ONLY on request ("give me a focused review"; "ignore the import churn, show me the real
changes") — a plain guided review skims nothing. Skim LOWERS attention — the opposite of flag; never
skim your own risky or non-obvious changes. Given a focused review, set \`focused: true\` and apply
this default churn policy without item-by-item instruction:
- whole-file skim — lockfiles, generated/compiled output, vendored code, snapshot files.
- skimBlocks — import/re-export-only blocks, formatting-only hunks, mechanical rename ripples
  (call-site churn where only an identifier changed).
- movedFrom — files moved and edited, so only the real edits show.
- never skim — logic, behavior-changing config (CI, tsconfig, package.json deps), your own risky
  changes.

Validation: beyond the (required, non-empty) fields above — a file's \`path\` must appear in the
diff; each skimBlocks span must resolve to a change block; \`movedFrom\` must name a full deletion
paired with the untracked addition at \`path\`, in working repo mode, not combined with skimBlocks;
\`focused\` must be a boolean. An unreadable file, invalid JSON, or any violation aborts the launch
naming the offending field.

## Between rounds — reload vs restart, and the desk lock
- Don't edit tracked files mid-round: the reviewer wouldn't see the edits and their in-flight
  decisions would be invalidated. Edit between rounds, then \`galley reload\`.
- Full restart (Ctrl-C, then \`galley --session <id>\`) is only for changing the diff source
  (working ↔ staged) or the mode.
- A live desk writes <sessionDir>/desk.lock (with its url) and removes it on exit; trust a lock
  only if the server actually answers. The lock url is always loopback-reachable, so your
  subcommands work unchanged even when the desk is bound beyond loopback (--host <addr> /
  GALLEY_HOST, for remote-dev — the browser url printed at start differs then; operator concern,
  not yours).
- A desk with no open tab and no attached agent for 2h auto-exits (--idle-timeout <min> at start
  overrides; 0 = never). An in-flight await pins it alive. Nothing is lost — state persists on
  every save and a restart reopens the session on the same port, so the old tab self-heals.
- The reviewer keeps ONE tab across rounds: start is idempotent (a live desk is reused, never
  duplicated) and each repo+session binds a stable port, so a restarted/crashed desk reattaches
  to the same origin and the open tab self-heals within seconds — don't tell the reviewer to
  switch tabs. Pass explicit --session/--port only to run a second, separate desk.

## Settings & errors
- The human's display prefs live in a desk panel (persisted to ~/.galley/settings.json) — you
  don't set them. Note: with "Approve stages file" OFF, approving is verdict-only and stagedFiles
  may be empty even for approved files. The "Open in editor" command ({repo}/{file}/{line}
  placeholders; known GUI editors only) has no effect on review state.
- Error responses are {error, code, fix, docs} — honor fix. PATCH_CONFLICT (409) = the working
  tree changed since the desk loaded; reload state and retry.`;
