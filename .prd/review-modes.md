---
status: done
created_at: 2026-06-03
completed_at: 2026-06-03
---

> **Resolved in implementation (interview deltas):** PR mode **checks out** the ref (aborts if
> tracked changes are uncommitted; untracked files don't block) and diffs against the merge-base
> — `gh` PR-number fetch is out of scope. File-mode accept/reject **stages** when the file is
> tracked+changed, **verdict-only** when untracked. **Comark** markdown rendering is deferred to
> a post-UI-architecture item (markdown shows as raw text for now). Sessions are mode-prefixed
> (`<branch>` / `file-…` / `pr-…`); `await`/`comment`/`reload` auto-discover the lone live desk.
> Deep module shipped as `buildDiffSource`; `ReviewState.mode` + `ChangeState.stageable` +
> `ReviewResult.mode` thread it through.

## Problem Statement

Galley only reviews the local working-tree (or staged) diff of a whole repository. That misses
two real workflows and wastes space in a third:

1. **Single-file review of non-git artifacts.** When the reviewer asks a model to produce
   something — e.g. a plan written to a temp or config folder — that file isn't tracked by
   git, so there's no diff to review. The reviewer still wants to read it and leave
   interactive comments.
2. **PR / branch review.** The reviewer wants to review changes that are already committed on
   a branch or PR, diffed against a base — not just uncommitted working-tree changes. In that
   world the current accept→stage mechanic is meaningless because the files are already
   committed.
3. **Wasted file tree.** When only one file changed (in the tree or a PR), the file-tree
   sidebar is dead weight; the view should simplify to just the changes.

## Solution

Introduce explicit **review modes** with a simplified single-file view:

- **Repo review** (today's behavior) — working-tree or staged diff of the repo.
- **File review** — `galley file <path>` reviews one file, tracked or untracked/newly-created.
  Show the full file; overlay the diff if the file has changes, otherwise just show the full
  file for commenting.
- **PR review** — review a branch/PR's committed changes diffed against a base. Accept/reject
  no longer stage; they become review **verdicts** (approve / request-changes / per-hunk
  notes) that feed the agent.
- **Single-file simplified view** — whenever the review contains exactly one file (any mode),
  hide the file tree and show only the diff/file.

## User Stories

1. As a reviewer, I want to run Galley on a single file path, so that I can review one file
   without the repo-wide tree.
2. As a reviewer, I want to review a freshly-created, untracked file (like an AI-generated
   plan), so that I can comment on it before it's used or committed.
3. As a reviewer, when a file has no git changes, I want to see its full contents, so that I
   can comment on any line.
4. As a reviewer, when a file does have changes, I want to see the diff (with full context
   available), so that I can review what changed.
5. As a reviewer reviewing an untracked new file, I want every line treated as reviewable, so
   that I can comment anywhere even though git sees no "diff."
6. As a coding agent, I want to point Galley at a plan file I just wrote, so that the human
   can steer it interactively, the same way they steer code.
7. As a reviewer, when only one file is in the review, I want the file tree hidden, so that I
   get a focused, uncluttered view.
8. As a reviewer, I want to review a PR by branch name or ref, so that I can review committed
   work, not just my working tree.
9. As a reviewer reviewing a PR, I want the diff computed against the right base, so that I
   see exactly what the PR introduces.
10. As a reviewer reviewing a PR, I want accept/reject to mean "approve / request changes" on
    that hunk rather than "stage it," because the change is already committed.
11. As a reviewer, I want to send a PR review verdict plus comments to the agent, so that it
    can address requested changes on the branch.
12. As a coding agent, I want the `ReviewResult` to clearly reflect which mode produced it, so
    that I interpret accept/reject correctly (staged vs verdict).
13. As a reviewer, I want comments on an untracked file to persist across sessions keyed to
    that file, so that I can resume.
14. As a reviewer, I want to switch the diff source (working vs staged vs file vs PR) via clear
    invocation, so that I don't have to guess flags.
15. As a maintainer, I want a single abstraction for "where the diff comes from," so that modes
    don't each reimplement diff acquisition.

## Implementation Decisions

- **Mode on the state.** `ReviewState` gains a `mode: "repo" | "file" | "pr"` and, for file
  mode, a way to express "no diff, show full file." The `ReviewResult` surfaces the mode so
  the agent interprets decisions correctly.
- **Diff-source abstraction (deep module).** Extract a single "diff source" module that
  produces the parsed files + change blocks for each mode: repo (working/staged, today's git
  diff), file (a path: if tracked & changed → diff vs HEAD; if untracked/new → synthesize an
  all-additions diff against empty, or a full-file view), and PR (`base...head`). The
  review-state builder becomes a thin caller over this. Keeps `parseUnifiedDiff` and the
  change-block logic reused, not duplicated.
- **CLI surface.** `galley file <path>` for file mode; `galley pr <branch|ref>` (optionally
  `--base <ref>`) for PR mode; default stays repo mode. PR mode may shell out to `git fetch`/
  `gh pr checkout` to obtain the branch.
- **Untracked/new file.** Represented as a synthetic diff (all lines added) so the existing
  change/comment machinery works unchanged; the simplified view renders it as a full file.
- **Single-file view.** Purely a UI affordance keyed off `files.length === 1`: hide the tree
  pane, widen the diff. No data-model change.
- **PR verdicts.** In PR mode, `ChangeState.status` is reinterpreted: accept/reject become
  approve/request-changes and do **not** touch the git index. `buildReviewSummary` /
  `buildReviewResult` emit verdicts + comments instead of "staged files / accepted line
  changes." Staging endpoints are inert in PR mode.

## Testing Decisions

- A good test asserts **what diff/state a mode produces** from given inputs, not how it calls
  git. Feed known unified-diff strings and a known file path to the diff-source module and
  assert the parsed files, change blocks, and (for untracked files) the synthetic
  all-additions representation.
- **Modules to test:** the diff-source abstraction (repo/file/pr → files+changes, including
  untracked-file synthesis and the "no changes → full file" case); the
  summary/result builders in PR mode (verdicts vs staged). `parseUnifiedDiff` is already pure
  and gains coverage here.
- **Prior art:** none yet; use the `node:test` runner introduced by the live-desk-robustness
  PRD. Fixtures: a small temp git repo created in the test (like the manual smoke scripts) for
  the git-backed paths, and inline strings for the pure parser.

## Out of Scope

- Editing the file's contents inside the desk (review/comment only).
- Posting the review back to GitHub via API (verdicts feed the local agent; GitHub write-back
  is a later concern).
- Multi-file PR review UX beyond what repo mode already provides (ordering/guidance is the
  guided-review PRD).
- Directory/glob review of many untracked files at once.

## Further Notes

File review unlocks Galley as a general "review any artifact with a human" surface, not just a
code reviewer — which is why untracked-file support is first-class, not a special case. PR mode
is where accept/reject semantics fork; the mode flag on `ReviewResult` is the contract that
keeps the agent honest about what a decision means.
