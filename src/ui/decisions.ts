import { S, D, toast, api, persist } from "./store";
import { currentFile, applyDecisionToDiff } from "./changes";
import { render } from "./render";
import type { ChangeState } from "./types";

type ChangeStatus = ChangeState["status"];

export function toggleReviewed(path: string) {
  S.state.reviewedFiles = S.state.reviewedFiles || [];
  if (S.state.reviewedFiles.includes(path)) { S.state.reviewedFiles = S.state.reviewedFiles.filter((p) => p !== path); toast("Marked unviewed"); }
  else { S.state.reviewedFiles.push(path); toast("Marked viewed"); }
  render(); persist();
}

export async function resetReview(path: string) {
  S.state.changes.filter((c) => c.path === path).forEach((c) => (c.status = "pending"));
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
  S.state.changes.filter((c) => c.path === path && c.status === "pending").forEach((c) => { c.status = "accepted"; c.reviewedHash = c.contentHash; });
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(path)) S.state.decisionFiles.push(path);
  await api("/api/stage", { method: "POST", body: JSON.stringify({ path }) });
  S.state.stagedFiles = S.state.stagedFiles || [];
  if (!S.state.stagedFiles.includes(path)) S.state.stagedFiles.push(path);
  render(); toast("Kept and staged file"); persist();
}

export async function stageFile(path: string, force = false) {
  if (!force && needsStageConfirmation(path)) { S.pendingStagePath = path; S.modalOpen = true; return; }
  S.state.changes.filter((c) => c.path === path && c.status === "pending").forEach((c) => { c.status = "accepted"; c.reviewedHash = c.contentHash; });
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

export async function acceptChange(id: string, status: ChangeStatus) {
  const change = S.state.changes.find((c) => c.id === id);
  if (!change || change.status === status) return;
  if (status === "accepted" && change.stageable) {
    const result = await api<{ error?: string }>("/api/stage-change", { method: "POST", body: JSON.stringify({ path: change.path, stableKey: change.stableKey }) });
    if (result.error) { toast(`Could not stage change: ${result.error}`); return; }
    S.state.stagedChangeKeys = S.state.stagedChangeKeys || [];
    const key = `${change.path}:${change.stableKey}`;
    if (!S.state.stagedChangeKeys.includes(key)) S.state.stagedChangeKeys.push(key);
  }
  change.status = status;
  change.reviewedHash = change.contentHash;
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(change.path)) S.state.decisionFiles.push(change.path);
  if (D.fileDiff) D.fileDiff = applyDecisionToDiff(D.fileDiff, change, status);
  toast(status === "accepted" ? "Accepted and staged" : "Rejected");
  render(); persist();
}
