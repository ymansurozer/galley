---
name: galley
description: Drive Galley — a living browser surface where a human reviews a git diff (accept/reject changes, leave comments) and the coding agent acts on their decisions and replies in the same tab. Use after making code changes the user should review, when the user asks to "open the Galley", or to collaborate on a diff turn-by-turn.
license: MIT
metadata:
  homepage: https://github.com/ymansurozer/galley
---

# Galley

Galley is a **living** browser surface for a git diff (working tree or staged). A human reviews the diff — accepting/rejecting changes and leaving comments — and clicks **Send to Agent**. The desk does **not** close on send: it keeps running across rounds. The agent attaches to it, receives each send, posts replies that appear in the open tab live, and the human keeps going in the same tab.

The review is the human's; the agent acts on the decisions and answers questions. No model runs inside the desk.

## Getting the tool

`galley` is a small Node CLI (Node 20+ and `git` required). To use it across any repo, install it globally: `npm install -g @ymansurozer/galley`. To use it in just one project, add it there as a dev dependency (`npm install -D @ymansurozer/galley`) and run it with `npx @ymansurozer/galley`. Either way, invoke it as `galley …` everywhere below.

## Review modes

`galley` reviews in one of three modes. `await`/`comment`/`reload` auto-target the lone live desk for the repo, so you usually don't pass `--session`.

| Start command        | Mode           | What's reviewed                                                              | staging                                                                   |
| -------------------- | -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `galley`             | repo (default) | working-tree (or `--diff staged`) diff                                       | **Approve stages** the file (toggle); accept/reject are verdicts          |
| `galley file <path>` | file           | one file — tracked or untracked/new. No changes → full file; changed → diff. | tracked+changed → **Approve stages**; untracked → **verdict**             |
| `galley pr <ref>`    | pr             | a branch's committed changes vs its base                                     | **verdict only**: Approve = approve, reject = request-changes (no staging) |

- **Repo mode** (the default) reviews the whole working tree. `--diff staged` reviews the staged diff instead; `--path <p>` limits it to one path.
- **File mode** is for reviewing an artifact (e.g. a generated plan in a temp/config folder) and commenting on it. An untracked file shows in full and is commented, not staged. Markdown files render formatted with a Rendered/Source toggle, and you can comment on any rendered block.
- **PR mode** reviews a branch's committed changes. `<ref>` is a branch name, a PR number (`123`), or a GitHub PR URL; a number or URL is resolved to its branch via the GitHub CLI, so `gh` must be installed and authenticated for those. It checks out the branch (aborts if the working tree has uncommitted tracked changes), diffs against the merge-base, and produces verdicts; you then amend the branch and re-review. `--base <ref>` overrides the base branch (a resolved PR uses the PR's own base by default).
- The `ReviewResult` includes `mode` (`repo`/`file`/`pr`) so you interpret accept/reject right.

## The loop — start, then await / comment / reload

| Command                                                                                          | Role                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `galley …` (a mode above)                                                                        | Start the persistent desk (opens the tab, stays up until Ctrl-C). The banner prints to **stderr**; nothing is written to stdout.                                                                                                              |
| `galley await [--session <id>] [--timeout <s>]`                                                  | Block until the next desk **event**, print it as a tagged JSON envelope on stdout, and exit. Loop and branch on `kind`.                                                                                                                       |
| `galley comment [--session <id>] --path <f> --line <n> [--side additions\|deletions] --body "…"` | Post an agent reply (an answer to a question, or a note). Appears in the open tab within ~1.5s, threaded under the matching human comment.                                                                                                    |
| `galley reload [--session <id>]`                                                                 | Re-diff the working tree into the **live** desk so your code edits appear in the same tab — no restart needed. Decisions reconcile against the new diff (a hunk whose content you changed resets to pending; untouched decisions carry over). |

`galley await` yields one of two events:

- `{"kind":"question","question":{…}}` — the reviewer asked a **question** and wants an answer **now**. Answer it immediately with `galley comment` at its path/line/side. Questions are a live side-channel; they are **not** included in the Send/ReviewResult.
- `{"kind":"review","result":{…ReviewResult…}}` — the reviewer clicked **Send to Agent**. Act on `result` (revert rejected, make requested changes, leave accepted).

```bash
# 1. Start the desk once, in the background. It stays alive across rounds.
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
      #  ... then `galley reload --session <id>` to show your edits live ...
      ;;
  esac
done
```

## Start options

`galley [file <path> | pr <ref>] --session <id>` accepts:

| Flag                     | Default                                        | Meaning                                          |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------ |
| `--session <id>`         | per mode (branch / `file-<path>` / `pr-<ref>`) | Stable identity of the review. Reuse to iterate. |
| `--diff working\|staged` | `working`                                      | Which diff to review (repo mode).                |
| `--repo <path>`          | cwd                                            | Repo to review.                                  |
| `--path <path>`          | whole repo                                     | Limit a repo-mode diff to a path.                |
| `--base <ref>`           | default branch                                 | PR mode only — base to diff `<ref>` against.     |
| `--guide <file>`         | none                                           | Attach an AI guided review (see below).          |
| `--no-open`              | opens browser                                  | Don't auto-open the browser.                     |
| `--port <n>`             | random                                         | Server port.                                     |

## await exit semantics

| `galley await`                               | Meaning                                                                                    | What to do                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| exit 0, `{"kind":"question","question":{…}}` | The reviewer asked a question, wants an answer now.                                        | Answer with `galley comment` at the question's `path`/`lineNumber`/`side`. |
| exit 0, `{"kind":"review","result":{…}}`     | The reviewer clicked **Send**.                                                             | Act on `result` (a `ReviewResult`).                                        |
| exit 0, empty stdout                         | Long-poll timed out before any event (only with `--timeout <s>`; otherwise it holds open). | Call `await` again.                                                        |
| non-zero                                     | No live desk for this session.                                                             | Start it: `galley --session <id>`.                                         |

Without `--timeout`, `await` holds the connection open until an event arrives. Pass `--timeout <s>` if your harness can't keep a process blocked indefinitely — the server returns `204` (empty stdout) after `<s>` seconds and you re-poll.

### Question event

```json
{
  "kind": "question",
  "question": {
    "path": "src/app.ts",
    "lineNumber": 12,
    "side": "additions",
    "body": "why merge-base here?",
    "mode": "pr",
    "session": "feature-x"
  }
}
```

Read the file/diff for context (you have the repo), then answer with `galley comment` matching `path`/`lineNumber`/`side` so the reply threads under the question. Answer promptly — the human is waiting in the tab. Questions are resolved live and never appear in a `ReviewResult`.

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
  "accepted": [
    { "path": "a.ts", "lineNumber": 12, "side": "additions", "title": "1 removed · 2 added" }
  ],
  "rejected": [
    { "path": "b.ts", "lineNumber": 40, "side": "additions", "title": "0 removed · 3 added" }
  ],
  "requestedChanges": [
    { "path": "c.ts", "lineNumber": 7, "side": "additions", "body": "extract this into a helper" }
  ],
  "stagedFiles": ["a.ts"],
  "approvedFiles": ["a.ts"],
  "artifacts": {
    "resultJson": "~/.galley/<repoHash>/<session>/<id>-result.json",
    "summaryMd": "~/.galley/<repoHash>/<session>/<id>-send-review.md",
    "sessionDir": "~/.galley/<repoHash>/<session>/"
  }
}
```

Each changed file ends the review in one of three states: **pending** (the reviewer hasn't signed it off), **approved** (signed off with no objections → listed in `approvedFiles`), or **changes-requested** (signed off but has a rejected hunk and/or a requested change). `approvedFiles` is exactly the files with no rejected hunk and no open requested-change, whose approval was still current at Send — leave them as they are. Approval is invalidated automatically when the file's content changes, so after you edit and `galley reload`, a previously-approved file you touched returns to pending for re-review.

`summaryMarkdown` is a ready-to-use prompt body; the structured arrays are there when you need to act precisely.

### File-poll fallback (no long-poll / no background process)

If your harness can't hold a `galley await` long-poll open or background the desk, poll the result file instead of using `await`. Every **Send** (over)writes the same `ReviewResult` JSON to `artifacts.resultJson` — `~/.galley/<repoHash>/<session>/<id>-result.json`, where `<repoHash>` is the first 16 hex chars of `sha256(<absolute repo root path>)` and `<session>` is the (sanitized) session name. Watch that session dir and read the newest `*-result.json`: a changed mtime means a new Send, and the file is the exact `ReviewResult` you'd otherwise get from the `await` event. Agent replies still post with `galley comment` as usual. One caveat: live **questions** (the Ask side-channel) are delivered only through the `await` event stream, so a pure file-poll agent sees Sends but not live Asks.

## How to act on a review — one path per item, don't mix

| Item                             | Action                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rejected change**              | Revert that change. The reviewer does not want it.                                                                                            |
| **Requested change** (a comment) | Make the edit it asks for, at `path:lineNumber`. (Questions are not here — they arrive as their own `question` events and are answered live.) |
| **Accepted change**              | Leave it. Do not re-touch accepted hunks.                                                                                                     |
| **Approved file** (`approvedFiles`) | Signed off as-is. Leave the whole file alone unless a requested change elsewhere forces a touch — if so, expect it to need re-review.       |
| **Staged file**                  | Already staged by the reviewer. Don't touch unless a requested change requires it.                                                            |
| **Show your edits**              | After editing, run `galley reload` so the new diff appears in the open tab.                                                                   |
| **Next round**                   | Call `galley await` again to wait for the reviewer's next Send.                                                                               |

## Guided review (optional)

Optionally attach a **guided review** so the desk presents the changeset as a guided flow: an overview page, then the files in the order you choose, each with a summary and category, and the critical ones flagged. You generate the guide from the diff and attach it at start with `galley … --guide <file>`. Galley validates and renders it and runs no model; with no guide the desk works exactly the same.

Run **`galley guide-spec`** for the authoritative schema, field meanings, and validation rules.

The guide is attached at **start**, and survives `reload` and restarts. It is stamped against the diff it was generated for; once a `reload` advances the diff past that point, the desk flags it stale, so regenerate from the new diff and restart with a fresh `--guide`.

## Replying to the reviewer

```bash
galley comment --session <id> --path src/list.ts --line 33 --side additions \
  --body "This prints a dim summary footer with counts + elapsed time."
```

`galley comment` always posts as an **agent** reply. If a desk is live the comment posts over HTTP and appears within ~1.5s; otherwise it is appended to the saved review for the next open. Match the reviewer's `path`, `lineNumber`, and `side` to thread under their comment. Agent comments are not echoed back as requested changes.

## Surfacing your edits: reload vs restart

The live desk shows the diff captured when it started. New comments stream in live, but your **code edits are not auto-re-diffed**. Run `galley reload` to re-diff the working tree into the open tab without losing the human's in-progress decisions — decisions reconcile against the new diff (a hunk whose content you changed resets to pending; untouched ones carry over). A full restart (`Ctrl-C`, then `galley --session <id>`) is only needed to change the diff source (e.g. working ↔ staged) or the mode.

## Concurrency: respect the desk lock

A live desk writes `<sessionDir>/desk.lock` (with its `url`) and removes it on exit. Don't edit tracked files while the reviewer is mid-round — they wouldn't see the edits and their in-flight decisions would be invalidated. Edit between rounds, then `galley reload` (or restart) to surface the new diff.

## Settings

The desk has a gear-triggered settings panel (persisted per-browser): diff layout/intra-line/indicators/separators/wrapping, a shared code-highlight theme, mono font + size, show-unchanged-files, and an "Approve stages file" toggle. These are the human's display preferences — you don't set them, but note that with "Approve stages file" off, approving is verdict-only and `stagedFiles` may be empty even for approved files.

## Errors

Error responses are `{ "error", "code", "fix", "docs" }`. Honor `fix`. Notably `PATCH_CONFLICT` (409) means the working tree changed since the desk loaded — reload state and retry.
