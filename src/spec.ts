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
Pick one at start. await/comment/status/reload auto-target the lone live desk, so --session is
usually unneeded.
- repo (default) — \`galley\`: working-tree diff; \`--diff staged\` for the index; \`--path <p>\`
  limits to a path. Untracked (new) files show as full-file additions. Approve stages the file
  (toggle); accept/reject are verdicts.
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
while ev=$(galley await --session <id>); do
  [ -z "$ev" ] && continue                               # --timeout fired, no event
  case "$(jq -r .kind <<<"$ev")" in
    question)  # answer NOW at the question's path/line/side; thread under it
      q=$(jq .question <<<"$ev")
      galley status --session <id> --body "Reading X to answer…"        # live progress
      galley comment --session <id> --path "$(jq -r .path<<<"$q")" \\
        --line "$(jq -r .lineNumber<<<"$q")" --side "$(jq -r .side<<<"$q")" --body "…" ;;
    review)    # act on the ReviewResult, then \`galley reload\` to show your edits
      r=$(jq .result <<<"$ev") ;;
  esac
done
\`\`\`
- \`galley await [--timeout <s>]\` — block for the next event, print one tagged JSON envelope,
  exit. No --timeout → holds open; --timeout <s> → empty stdout (204) after <s>s, re-poll. Exit
  non-zero = no live desk (start one).
- \`galley comment --path <f> --line <n> [--side additions|deletions] --body "…"\` — agent reply.
  Live desk → posts over HTTP (~1.5s), threaded under the matching human comment; no desk →
  appended to the saved review. Match path/line/side. Agent comments are never echoed back as
  requestedChanges.
- \`galley status --body "…"\` — ephemeral one-line "doing X now" beside the reviewer's spinner.
  Cleared by your next comment; stale after ~90s (keep posting through long work); never
  persisted; exits 0 even with no desk.
- \`galley reload [--guide <file>]\` — re-diff the working tree into the live desk (your edits are
  NOT auto-re-diffed). Decisions reconcile: a hunk whose content you changed resets to pending,
  untouched ones carry over. --guide swaps the guide.

## Events
await yields exactly one:
- {"kind":"question","question":{path,lineNumber,side,body,mode,session}} — reviewer wants an
  answer NOW. Read the file for context, answer with \`galley comment\` at path/lineNumber/side.
  Questions are a live side-channel: NEVER in a Send/ReviewResult. Slow answer → post \`galley
  status\` lines so the human sees progress, not a static spinner.
- {"kind":"review","result":{…ReviewResult…}} — reviewer clicked Send. Act on result.

## ReviewResult
The \`result\` field of a review event:
- session, repoRoot, mode, staged, head (sha|null), baseDiffHash (hash of the reviewed diff)
- summaryMarkdown — a ready-to-use prompt body (the arrays below are for acting precisely)
- accepted[], rejected[]: {path, lineNumber, side, title}
- requestedChanges[]: {path, lineNumber, side, body}
- stagedFiles[], approvedFiles[]
- artifacts: {resultJson, summaryMd, sessionDir}, all under
  ~/.galley/<repoHash>/<session>/ where repoHash = sha256(abs repo root)[:16]
Each changed file ends pending | approved (no objections → listed in approvedFiles) |
changes-requested (a rejected hunk and/or a requested change). Editing a file's content
invalidates its approval → after \`galley reload\` it returns to pending for re-review.
File-poll fallback (harness can't hold a long-poll / background the desk): every Send
(over)writes the same ReviewResult to artifacts.resultJson; watch sessionDir, read the newest
*-result.json (changed mtime = new Send). Live questions arrive only via await, so a pure
file-poller sees Sends but not Asks.

## How to act on a review — one path per item, don't mix
- rejected → revert that change; the reviewer doesn't want it.
- requestedChanges (a comment) → make the edit at path:lineNumber.
- accepted → leave it; don't re-touch.
- approvedFiles → signed off as-is; leave the whole file unless a requested change forces a touch
  (which re-opens it for re-review).
- stagedFiles → already staged by the reviewer; don't touch unless a requested change requires it.
Then \`galley reload\` to surface your edits, and \`galley await\` for the next round.

## Guided review (optional)
Attach with \`galley <mode> --guide <file>\`: an overview page + files in your order, each with
orientation/category, files worth scrutinizing flagged. Galley validates+renders it (markdown in prose fields,
raw HTML stripped) and runs no model — content and order are yours. Write the guide OUTSIDE the
working tree (a temp or gitignored path): working mode surfaces untracked files, so an in-repo
guide shows as a stray addition. The guide is stamped to its diff and survives reload/restart;
once a reload advances past that diff it's flagged stale — regenerate and swap via \`galley reload
--guide <new>\` (or re-run start with --guide; the live desk is reused). Never start a second desk
for a new guide.

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
  - category? — group label (default "Changes").
  - flag? — raises a flag on the file for closer scrutiny; the text is the note (what to
    double-check, what's risky). Omit unless the file genuinely warrants it.
Validation: overview a non-empty string, files a non-empty array, every file a non-empty
path+orientation; an unreadable file / invalid JSON / schema violation aborts the launch naming
the offending field.

## Between rounds — reload vs restart, and the desk lock
- Don't edit tracked files mid-round: the reviewer wouldn't see the edits and their in-flight
  decisions would be invalidated. Edit between rounds, then \`galley reload\`.
- Full restart (Ctrl-C, then \`galley --session <id>\`) is only for changing the diff source
  (working ↔ staged) or the mode.
- A live desk writes <sessionDir>/desk.lock (with its url) and removes it on exit; trust a lock
  only if the server actually answers.
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
