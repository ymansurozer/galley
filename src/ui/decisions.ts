import { S, toast, api, persist } from "./store";
import { currentFile, fileFinished, fileObjections, flowIndex } from "./changes";
import { render, deferRender } from "./render";
import { nextUnreviewedFileIndex, guideProgress } from "./guide";
import {
  captureFileReview,
  clearFileReview,
  recordDecision,
  restoreFileReview,
  signOff,
  type FileReview,
} from "./decisions-derive";
import type { Decision, ReviewState } from "./types";

type ReviewFile = ReviewState["files"][number];

// Stage a whole file. A working-mode move pair (issue 02) stages BOTH paths — `git add`-ing the
// old (deleted) path records the deletion, so the index ends with a rename. Only in working-repo
// mode: pr approve is a pure verdict, and staged mode can't contain these pairs. stagedFiles
// still records the new path once, as for any file.
async function stageFile(file: ReviewFile) {
  const path = file.path;
  const moved = file.oldPath && file.newPath && file.oldPath !== file.newPath;
  const pairMove = moved && S.state.mode === "repo" && !S.state.staged;
  const body = pairMove ? { paths: [file.oldPath, path] } : { path };
  await api("/api/stage", { method: "POST", body: JSON.stringify(body) });
  S.state.stagedFiles = S.state.stagedFiles || [];
  if (!S.state.stagedFiles.includes(path)) S.state.stagedFiles.push(path);
}

export function approveCurrentFile() {
  return approveFile(currentFile().path, { advance: true });
}

// Sign off on a file (signOff), stage it when it's a clean approval and the "Approve stages file"
// setting is on, then — with `advance`, the ⇧A flow — move on to the next unreviewed file. The
// sidebar's status icon signs off without it: the active file stays put and re-renders in place,
// so a sign-off on the active file shows in its header at once.
export async function approveFile(path: string, { advance }: { advance: boolean }) {
  // A preview (an unchanged file opened to read) isn't in the review: nothing to sign off.
  const file = S.state.files.find((f) => f.path === path);
  if (!file) return;
  signOff(S.state, file);
  // A file with objections (a rejected hunk or open requested-change comment) is "changes
  // requested" — the agent still has work on it, so never stage it. Clean → stage if enabled.
  const clean = !fileObjections(path);
  if (clean && S.settings.stageOnAccept) await stageFile(file);
  persist();
  const label = clean ? "Approved" : "Marked reviewed";
  // The review-complete gate is over in-flow files only (issue 01/07): fully-skimmed files and
  // pure renames left the flow, so they never block completion (and are never auto-approved).
  // One flow-index pass instead of per-file predicate rescans (see flow-index.ts).
  const ix = flowIndex();
  const scope = S.state.files.filter((f) => !ix.outOfFlow.has(f.path));
  // Every in-flow file signed off → the review is done: prompt to send it back to the agent.
  if (scope.every((f) => S.state.reviewedFiles!.includes(f.path))) {
    toast(`${label} — review complete`);
    render();
    S.promptFinish?.();
    return;
  }
  // Each sign-off toasts the running score ("7 of 12 files · 58%") so progress is felt at the
  // moment it moves, not just visible in the bar. % matches the strip (LOC-weighted by default).
  const done = scope.filter((f) => ix.reviewState(f.path) !== "pending").length;
  toast(`${label} — ${done} of ${scope.length} files · ${guideProgress().pct}%`);
  // Seek the next unreviewed file, wrapping past the end so a reviewer who jumped ahead is
  // carried back to the files they skipped instead of dead-ending here.
  const next = advance ? nextUnreviewedFileIndex(S.fileIndex) : null;
  if (next !== null && S.selectFile) S.selectFile(next);
  else render();
}

// The sidebar's status icon: sign a pending file off where it stands, or reset a finished one —
// Reset's Undo is the safety net against a stray click.
export function toggleSignOff(path: string) {
  if (fileFinished(path)) resetReview(path);
  else void approveFile(path, { advance: false });
}

// Undo a file's review: clear hunk decisions, the finished/sign-off marker + its hash, and unstage.
// The toast's Undo puts back exactly what this cleared, the index included.
export function resetReview(path: string) {
  const state = S.state;
  const prior = captureFileReview(state, path);
  clearFileReview(state, path);
  // Unstage is a git-index op the UI state already reflects — fire it without blocking so the
  // re-render (and its indicator) start immediately.
  const unstaged = api("/api/unstage", { method: "POST", body: JSON.stringify({ path }) }).catch(
    () => {},
  );
  // Reset restores hunks the approval had collapsed, which re-tokenizes a big file — show the
  // "Rendering…" indicator during it (deferRender(true) shows it for any big file).
  deferRender(true);
  toast("Reset review", { label: "Undo", run: () => void undoReset(state, prior, unstaged) });
  persist();
}

async function undoReset(state: ReviewState, prior: FileReview, unstaged: Promise<unknown>) {
  // A reload since the Reset swapped the state out; the capture describes the one it replaced.
  if (S.state !== state) return;
  restoreFileReview(state, prior);
  deferRender(true);
  toast("Reset undone");
  persist();
  // Re-stage once the Reset's unstage has landed, through the endpoints that staged it.
  await unstaged;
  const file = state.files.find((f) => f.path === prior.path);
  if (prior.staged && file) await stageFile(file).catch(() => {});
  for (const key of prior.stagedChangeKeys) {
    const stableKey = key.slice(prior.path.length + 1);
    await api("/api/stage-change", {
      method: "POST",
      body: JSON.stringify({ path: prior.path, stableKey }),
    }).catch(() => {});
  }
}

// Reject a whole file in one action, for the oversized-file card (issue 05): its blocks aren't
// visible there, so the honest equivalent of per-block reject is to reject every change block
// through the SAME decisions path. They flow into result.rejected like any rejected hunk — no new
// verdict kind, no new result semantics. Only meaningful when the file has change blocks (a
// hunk-less added file has none — the card hides the action there).
export async function rejectFile(path: string) {
  const blocks = S.state.changes.filter((c) => c.path === path);
  if (!blocks.length) return;
  for (const c of blocks) {
    c.status = "rejected";
    c.reviewedHash = c.contentHash;
    recordDecision(S.state, c, "rejected");
  }
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(path)) S.state.decisionFiles.push(path);
  toast("Rejected file");
  render();
  persist();
}

// Per-hunk accept/reject is now a pure verdict — staging happens only when the file is approved
// (so a changes-requested file is never left partially staged).
export async function acceptChange(id: string, status: Decision["status"]) {
  const change = S.state.changes.find((c) => c.id === id);
  if (!change || change.status === status) return;
  change.status = status;
  change.reviewedHash = change.contentHash;
  recordDecision(S.state, change, status);
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(change.path)) S.state.decisionFiles.push(change.path);
  // No need to apply the decision to D.fileDiff here: renderCenter unconditionally rebuilds
  // D.fileDiff from the raw diff (parse → ensureChanges → replayDecisions) every render, so a
  // pre-render mutation is thrown away — the replay below picks the new status up from the record.
  toast(status === "rejected" ? "Rejected" : "Accepted");
  render();
  persist();
}
