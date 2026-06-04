---
name: galley
description: Drive Galley — a living browser surface where a human reviews a git diff (accept/reject changes, leave comments) and the coding agent acts on their decisions and replies in the same tab. Use after making code changes the user should review, when the user asks to "open the Galley", or to collaborate on a diff turn-by-turn.
license: MIT
metadata:
  homepage: https://github.com/OWNER/galley
---

# Galley

Galley is a **living** browser surface for a git diff (working tree or staged). A human
reviews the diff — accepting/rejecting changes and leaving comments — and clicks **Send to
agent**. The desk does **not** close on send: it keeps running across rounds. The agent
attaches to it, receives each send, posts replies that appear in the open tab live, and the
human keeps going in the same tab.

The review is the human's; the agent acts on the decisions and answers questions. No model
runs inside the desk.

## Getting the tool

`galley` is a small Node CLI. If it isn't already on PATH, it lives in the same repo as
this skill — `pnpm install && pnpm build` there, then run via `node dist/cli.js` (or `pnpm
dev --`). Requires Node 18+ and `git`.

## Review modes

`galley` reviews in one of three modes. `await`/`comment`/`reload` auto-target the lone live
desk for the repo, so you usually don't pass `--session`.

| Start command | Mode | What's reviewed | accept/reject means |
|---|---|---|---|
| `galley` | repo (default) | working-tree (or `--diff staged`) diff | accept = **stage** the hunk |
| `galley file <path>` | file | one file — tracked or untracked/new. No changes → full file; changed → diff. | tracked+changed → **stage**; untracked → **verdict** |
| `galley pr <ref>` | pr | a branch's committed changes vs its base | **verdict only**: accept = approve, reject = request-changes (no staging) |

- **File mode** is for reviewing an artifact (e.g. a generated plan in a temp/config folder)
  and commenting on it. An untracked file shows in full and is commented, not staged.
- **PR mode** checks out `<ref>` (aborts if the working tree has uncommitted tracked changes),
  diffs against the merge-base with the default branch, and produces verdicts; you then amend
  the branch and re-review. `--base <ref>` overrides the base branch.
- The `ReviewResult` includes `mode` (`repo`/`file`/`pr`) so you interpret accept/reject right.

## The loop — three commands

| Command | Role |
|---|---|
| `galley …` (above) | Start the persistent desk for the chosen mode (opens the tab, stays up until Ctrl-C). |
| `galley await [--session <id>]` | Block until the next desk **event**, print it as a tagged JSON envelope, exit. Loop and branch on `kind`. |
| `galley comment [--session <id>] --path <f> --line <n> --body "…"` | Post a reply (an answer to a question, or a note); appears in the open tab within ~1.5s. |

`galley await` yields one of two events:

- `{"kind":"question","question":{…}}` — the reviewer asked a **question** and wants an answer
  **now**. Answer it immediately with `galley comment` at its path/line/side. Questions are a
  live side-channel; they are **not** included in the Send/ReviewResult.
- `{"kind":"review","result":{…ReviewResult…}}` — the reviewer clicked **Send to Agent**. Act
  on `result` (revert rejected, make requested changes, leave accepted).

```bash
# 1. Start the desk once, in the background. It stays alive.
galley --session <id> --diff working &

# 2. Loop on events. Branch: answer questions instantly; act on Sends.
while ev=$(galley await --session <id>); do
  [ -z "$ev" ] && continue                                  # timeout, no event — re-wait
  case "$(printf '%s' "$ev" | jq -r .kind)" in
    question)   # answer now, threaded at the question's location
      q=$(printf '%s' "$ev" | jq .question)
      galley comment --session <id> \
        --path "$(jq -r .path <<<"$q")" --line "$(jq -r .lineNumber <<<"$q")" \
        --side "$(jq -r .side <<<"$q")" --body "…your answer…" ;;
    review)     # act on the ReviewResult
      result=$(printf '%s' "$ev" | jq .result)
      #  ... revert rejected, make requested changes, leave accepted ...
      ;;
  esac
done
```

The desk's banner (`Galley [<session>]: <url>`) prints to **stderr**; the desk process
prints nothing to stdout and runs until Ctrl-C. `galley await` prints one event envelope per
call (a `question` or a `review`).

## Start options

`galley --session <id>` accepts:

| Flag | Default | Meaning |
|---|---|---|
| `--session <id>` | current git branch | Stable identity of the review. Reuse to iterate. |
| `--diff working\|staged` | `working` | Which diff to review. |
| `--repo <path>` | cwd | Repo to review. |
| `--path <path>` | whole repo | Limit the diff to a path. |
| `--no-open` | opens browser | Don't auto-open the browser. |
| `--port <n>` | random | Server port. |

## await exit semantics

| `galley await` | Meaning | What to do |
|---|---|---|
| exit 0, `{"kind":"question","question":{…}}` | The reviewer asked a question, wants an answer now. | Answer with `galley comment` at the question's `path`/`lineNumber`/`side`. |
| exit 0, `{"kind":"review","result":{…}}` | The reviewer clicked **Send**. | Act on `result` (a `ReviewResult`). |
| exit 0, empty stdout | Long-poll timed out before any event. | Call `await` again. |
| non-zero | No live desk for this session. | Start it: `galley --session <id>`. |

### Question event

```json
{ "kind": "question",
  "question": { "path": "src/app.ts", "lineNumber": 12, "side": "additions",
                "body": "why merge-base here?", "mode": "pr", "session": "feature-x" } }
```

Read the file/diff for context (you have the repo), then answer with `galley comment` matching
`path`/`lineNumber`/`side` so the reply threads under the question. Answer promptly — the human
is waiting in the tab. Questions are resolved live and never appear in a `ReviewResult`.

## ReviewResult

This is the `result` field of a `{"kind":"review", …}` event from `galley await`.

```json
{
  "session": "feature-x",
  "repoRoot": "/abs/path",
  "staged": false,
  "head": "<sha or null>",
  "baseDiffHash": "<hash of the diff this review was built against>",
  "summaryMarkdown": "Please address this review...",
  "accepted":         [{ "path": "a.ts", "lineNumber": 12, "side": "additions", "title": "1 removed · 2 added" }],
  "rejected":         [{ "path": "b.ts", "lineNumber": 40, "side": "additions", "title": "0 removed · 3 added" }],
  "requestedChanges": [{ "path": "c.ts", "lineNumber": 7,  "side": "additions", "body": "extract this into a helper" }],
  "stagedFiles": ["a.ts"],
  "artifacts": {
    "resultJson": "~/.galley/<repoHash>/<session>/<id>-result.json",
    "summaryMd":  "~/.galley/<repoHash>/<session>/<id>-send-review.md",
    "sessionDir": "~/.galley/<repoHash>/<session>/"
  }
}
```

`summaryMarkdown` is a ready-to-use prompt body. The structured arrays are there when you
need to act precisely. The same payload is persisted at `artifacts.resultJson` — agents that
can't long-poll can stat that file instead of using `await`.

## How to act on a review — one path per item, don't mix

| Item | Action |
|---|---|
| **Rejected change** | Revert that change. The reviewer does not want it. |
| **Requested change** (a comment) | Make the edit it asks for, at `path:lineNumber`. (Questions are not here — they arrive as their own `question` events and are answered live.) |
| **Accepted change** | Leave it. Do not re-touch accepted hunks. |
| **Staged file** | Already staged by the reviewer. Don't touch unless a requested change requires it. |
| **Next round** | Call `galley await` again to wait for the reviewer's next Send. |

The live desk shows the diff captured when it started; new comments appear live, but **code
edits you make are not re-diffed into the open desk**. To review a fresh diff after editing,
restart the desk (`Ctrl-C`, then `galley --session <id>`). On restart, decisions
reconcile against the new diff: a hunk whose **content you changed** resets to pending
(stale), and untouched decisions carry over.

## Replying to the reviewer

```bash
galley comment --session <id> --path src/list.ts --line 33 --side additions \
  --body "This prints a dim summary footer with counts + elapsed time."
```

If a desk is live the comment posts over HTTP and appears within ~1.5s; otherwise it is
appended to the saved review for the next open. Match the reviewer's `path`, `lineNumber`,
and `side` to thread under their comment. Agent comments are not echoed back as requested
changes.

## Concurrency: respect the desk lock

A live desk writes `<sessionDir>/desk.lock` (with its `url`) and removes it on exit. The desk
shows the diff it captured at startup and does **not** re-diff your edits. Do not edit tracked
files while the reviewer is mid-round — they wouldn't see the edits and their in-flight
decisions would be invalidated. Edit between rounds, then restart the desk to surface the new
diff.

## Errors

Error responses are `{ "error", "code", "fix", "docs" }`. Honor `fix`. Notably
`PATCH_CONFLICT` (409) means the working tree changed since the desk loaded — reload state and
retry.

## AGENTS.md snippet

> After making changes the user should review, start `galley --session $TASK_ID --diff
> working` in the background (it stays up). Then loop on `galley await --session $TASK_ID`
> and branch on the event `kind`: for `"question"`, answer it now with `galley comment` at
> the question's path/line/side; for `"review"`, act on `.result` — revert rejected, make
> requested, leave accepted, don't touch staged unless required. Restart the desk after
> editing code so the new diff shows.
