import { S, D, toast, api, persist } from "./store";
import { currentFile, applyDecisionToDiff } from "./changes";
import { render } from "./render";
import { nextFileIndex } from "./guide";
import type { ChangeState, Decision } from "./types";

type ChangeStatus = ChangeState["status"];

// The explicit decision record is the source of truth for accept/reject (decoupled
// from git staging). Every status change must go through these so it survives reload.
function recordDecision(change: ChangeState, status: Decision["status"]) {
  S.state.decisions = S.state.decisions || [];
  const key = `${change.path}:${change.stableKey}`;
  const entry: Decision = { key, status, reviewedHash: change.contentHash, path: change.path, lineNumber: change.lineNumber, side: change.side, title: change.title };
  const i = S.state.decisions.findIndex((d) => d.key === key);
  if (i >= 0) S.state.decisions[i] = entry; else S.state.decisions.push(entry);
}
function clearDecisions(path: string) {
  S.state.decisions = (S.state.decisions || []).filter((d) => d.path !== path);
}

export function toggleReviewed(path: string) {
  S.state.reviewedFiles = S.state.reviewedFiles || [];
  if (S.state.reviewedFiles.includes(path)) {
    // Un-viewing just toggles — stay on the file.
    S.state.reviewedFiles = S.state.reviewedFiles.filter((p) => p !== path);
    toast("Marked unviewed"); render(); persist(); return;
  }
  // Marking viewed advances to the next file (guide order if guided, else sequential);
  // on the last file there's nowhere to go, so just re-render in place.
  S.state.reviewedFiles.push(path);
  persist();
  const next = nextFileIndex(S.fileIndex);
  if (next !== null && S.selectFile) { toast("Viewed — next file"); S.selectFile(next); }
  else { toast(next === null ? "Viewed — last file" : "Marked viewed"); render(); }
}

export async function resetReview(path: string) {
  S.state.changes.filter((c) => c.path === path).forEach((c) => (c.status = "pending"));
  clearDecisions(path);
  S.state.stagedChangeKeys = (S.state.stagedChangeKeys || []).filter((k) => !k.startsWith(`${path}:`));
  S.state.decisionFiles = (S.state.decisionFiles || []).filter((p) => p !== path);
  S.state.stagedFiles = (S.state.stagedFiles || []).filter((p) => p !== path);
  await api("/api/unstage", { method: "POST", body: JSON.stringify({ path }) }).catch(() => {});
  if (path === currentFile().path) D.fileDiff = D.parseDiffFromFile(currentFile().oldFile, currentFile().newFile);
  render(); toast("Reset decisions"); persist();
}

export function needsStageConfirmation(path: string) {
  return S.state.changes.some((c) => c.path === path && c.status === "pending") || S.state.comments.some((c) => c.path === path && c.status === "open" && c.role !== "agent");
}

export async function keepAllCurrentFile() {
  const path = currentFile().path;
  S.state.changes.filter((c) => c.path === path && c.status === "pending").forEach((c) => { c.status = "accepted"; c.reviewedHash = c.contentHash; recordDecision(c, "accepted"); });
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(path)) S.state.decisionFiles.push(path);
  if (S.settings.stageOnAccept) { // verdict-only when off
    await api("/api/stage", { method: "POST", body: JSON.stringify({ path }) });
    S.state.stagedFiles = S.state.stagedFiles || [];
    if (!S.state.stagedFiles.includes(path)) S.state.stagedFiles.push(path);
  }
  render(); toast(S.settings.stageOnAccept ? "Kept and staged file" : "Kept file"); persist();
}

export async function stageFile(path: string, force = false) {
  if (!force && needsStageConfirmation(path)) { S.pendingStagePath = path; S.modalOpen = true; return; }
  S.state.changes.filter((c) => c.path === path && c.status === "pending").forEach((c) => { c.status = "accepted"; c.reviewedHash = c.contentHash; recordDecision(c, "accepted"); });
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(path)) S.state.decisionFiles.push(path);
  S.state.comments.filter((c) => c.path === path && c.status === "open").forEach((c) => (c.status = "resolved"));
  await api("/api/stage", { method: "POST", body: JSON.stringify({ path }) });
  S.state.stagedFiles = S.state.stagedFiles || [];
  if (!S.state.stagedFiles.includes(path)) S.state.stagedFiles.push(path);
  render(); toast("File staged"); persist();
}

export async function unstageFile(path: string) {
  await api("/api/unstage", { method: "POST", body: JSON.stringify({ path }) }).catch(() => {});
  S.state.stagedFiles = (S.state.stagedFiles || []).filter((p) => p !== path);
  render(); toast("File unstaged"); persist();
}

export async function acceptChange(id: string, status: Decision["status"]) {
  const change = S.state.changes.find((c) => c.id === id);
  if (!change || change.status === status) return;
  if (status === "accepted" && change.stageable && S.settings.stageOnAccept) {
    const result = await api<{ error?: string }>("/api/stage-change", { method: "POST", body: JSON.stringify({ path: change.path, stableKey: change.stableKey }) });
    if (result.error) { toast(`Could not stage change: ${result.error}`); return; }
    S.state.stagedChangeKeys = S.state.stagedChangeKeys || [];
    const key = `${change.path}:${change.stableKey}`;
    if (!S.state.stagedChangeKeys.includes(key)) S.state.stagedChangeKeys.push(key);
  }
  change.status = status;
  change.reviewedHash = change.contentHash;
  recordDecision(change, status);
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(change.path)) S.state.decisionFiles.push(change.path);
  if (D.fileDiff) D.fileDiff = applyDecisionToDiff(D.fileDiff, change, status);
  toast(status === "rejected" ? "Rejected" : (change.stageable && S.settings.stageOnAccept) ? "Accepted and staged" : "Accepted");
  render(); persist();
}
