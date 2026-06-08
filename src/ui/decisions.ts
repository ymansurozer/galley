import { S, D, toast, api, persist } from "./store";
import { currentFile, applyDecisionToDiff, fileObjections } from "./changes";
import { render, deferRender } from "./render";
import { nextFileIndex } from "./guide";
import type { ChangeState, Decision } from "./types";

// The explicit decision record is the source of truth for accept/reject (decoupled
// from git staging). Every status change must go through these so it survives reload.
function recordDecision(change: ChangeState, status: Decision["status"]) {
  S.state.decisions = S.state.decisions || [];
  const key = `${change.path}:${change.stableKey}`;
  const entry: Decision = {
    key,
    status,
    reviewedHash: change.contentHash,
    path: change.path,
    lineNumber: change.lineNumber,
    side: change.side,
    title: change.title,
  };
  const i = S.state.decisions.findIndex((d) => d.key === key);
  if (i >= 0) S.state.decisions[i] = entry;
  else S.state.decisions.push(entry);
}
function clearDecisions(path: string) {
  S.state.decisions = (S.state.decisions || []).filter((d) => d.path !== path);
}

// Sign off on the current file: accept any still-pending hunks (un-objected lines you've
// reviewed and didn't reject), mark the file finished against its current content hash, stage
// it when it's a clean approval and the "Approve stages file" setting is on, then advance.
// The displayed terminal state (approved vs changes-requested) is derived from objections.
export async function approveCurrentFile() {
  const file = currentFile();
  const path = file.path;
  S.state.changes
    .filter((c) => c.path === path && c.status === "pending")
    .forEach((c) => {
      c.status = "accepted";
      c.reviewedHash = c.contentHash;
      recordDecision(c, "accepted");
    });
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(path)) S.state.decisionFiles.push(path);
  S.state.reviewedFiles = S.state.reviewedFiles || [];
  if (!S.state.reviewedFiles.includes(path)) S.state.reviewedFiles.push(path);
  S.state.reviewedFileHashes = S.state.reviewedFileHashes || {};
  S.state.reviewedFileHashes[path] = file.contentHash;
  // A file with objections (a rejected hunk or open requested-change comment) is "changes
  // requested" — the agent still has work on it, so never stage it. Clean → stage if enabled.
  const clean = !fileObjections(path);
  if (clean && S.settings.stageOnAccept) {
    await api("/api/stage", { method: "POST", body: JSON.stringify({ path }) });
    S.state.stagedFiles = S.state.stagedFiles || [];
    if (!S.state.stagedFiles.includes(path)) S.state.stagedFiles.push(path);
  }
  persist();
  const label = clean ? "Approved" : "Marked reviewed";
  // Every changed file signed off → the review is done: prompt to send it back to the agent.
  if (S.state.files.every((f) => S.state.reviewedFiles!.includes(f.path))) {
    toast(`${label} — review complete`);
    render();
    S.promptFinish?.();
    return;
  }
  const next = nextFileIndex(S.fileIndex);
  if (next !== null && S.selectFile) {
    toast(`${label} — next file`);
    S.selectFile(next);
  } else {
    toast(`${label} — last file`);
    render();
  }
}

// Undo a file's review: clear hunk decisions, the finished/sign-off marker + its hash, and unstage.
export async function resetReview(path: string) {
  S.state.changes.filter((c) => c.path === path).forEach((c) => (c.status = "pending"));
  clearDecisions(path);
  S.state.stagedChangeKeys = (S.state.stagedChangeKeys || []).filter(
    (k) => !k.startsWith(`${path}:`),
  );
  S.state.decisionFiles = (S.state.decisionFiles || []).filter((p) => p !== path);
  S.state.reviewedFiles = (S.state.reviewedFiles || []).filter((p) => p !== path);
  if (S.state.reviewedFileHashes) delete S.state.reviewedFileHashes[path];
  S.state.stagedFiles = (S.state.stagedFiles || []).filter((p) => p !== path);
  // Unstage is a git-index op the UI state already reflects — fire it without blocking so the
  // re-render (and its indicator) start immediately.
  api("/api/unstage", { method: "POST", body: JSON.stringify({ path }) }).catch(() => {});
  // Reset restores hunks the approval had collapsed, which re-tokenizes a big file — show the
  // "Rendering…" indicator during it (deferRender(true) shows it for any big file).
  deferRender(true);
  toast("Reset review");
  persist();
}

// Per-hunk accept/reject is now a pure verdict — staging happens only when the file is approved
// (so a changes-requested file is never left partially staged).
export async function acceptChange(id: string, status: Decision["status"]) {
  const change = S.state.changes.find((c) => c.id === id);
  if (!change || change.status === status) return;
  change.status = status;
  change.reviewedHash = change.contentHash;
  recordDecision(change, status);
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(change.path)) S.state.decisionFiles.push(change.path);
  if (D.fileDiff) D.fileDiff = applyDecisionToDiff(D.fileDiff, change, status);
  toast(status === "rejected" ? "Rejected" : "Accepted");
  render();
  persist();
}
