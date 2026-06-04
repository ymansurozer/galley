import { S, D, $, show, toast, api, persist } from "./store";
import { currentFile, applyDecisionToDiff } from "./changes";
import { render } from "./render";

export function toggleReviewed(path: string) {
  S.state.reviewedFiles = S.state.reviewedFiles || [];
  if (S.state.reviewedFiles.includes(path)) { S.state.reviewedFiles = S.state.reviewedFiles.filter((p: string) => p !== path); toast("Marked unviewed"); }
  else { S.state.reviewedFiles.push(path); toast("Marked viewed"); }
  render(); persist();
}

export async function resetReview(path: string) {
  S.state.changes.filter((c: any) => c.path === path).forEach((c: any) => (c.status = "pending"));
  S.state.stagedChangeKeys = (S.state.stagedChangeKeys || []).filter((k: string) => !k.startsWith(`${path}:`));
  S.state.decisionFiles = (S.state.decisionFiles || []).filter((p: string) => p !== path);
  S.state.stagedFiles = (S.state.stagedFiles || []).filter((p: string) => p !== path);
  await api("/api/unstage", { method: "POST", body: JSON.stringify({ path }) }).catch(() => {});
  if (path === currentFile().path) D.fileDiff = D.parseDiffFromFile(currentFile().oldFile, currentFile().newFile);
  render(); toast("Reset decisions"); persist();
}

export function needsStageConfirmation(path: string) {
  return S.state.changes.some((c: any) => c.path === path && c.status === "pending") || S.state.comments.some((c: any) => c.path === path && c.status === "open" && c.role !== "agent");
}

export async function keepAllCurrentFile() {
  const path = currentFile().path;
  S.state.changes.filter((c: any) => c.path === path && c.status === "pending").forEach((c: any) => { c.status = "accepted"; c.reviewedHash = c.contentHash; });
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(path)) S.state.decisionFiles.push(path);
  await api("/api/stage", { method: "POST", body: JSON.stringify({ path }) });
  S.state.stagedFiles = S.state.stagedFiles || [];
  if (!S.state.stagedFiles.includes(path)) S.state.stagedFiles.push(path);
  render(); toast("Kept and staged file"); persist();
}

export async function stageFile(path: string, force = false) {
  if (!force && needsStageConfirmation(path)) { S.pendingStagePath = path; show($("stageModal")); return; }
  S.state.changes.filter((c: any) => c.path === path && c.status === "pending").forEach((c: any) => { c.status = "accepted"; c.reviewedHash = c.contentHash; });
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(path)) S.state.decisionFiles.push(path);
  S.state.comments.filter((c: any) => c.path === path && c.status === "open").forEach((c: any) => (c.status = "resolved"));
  await api("/api/stage", { method: "POST", body: JSON.stringify({ path }) });
  S.state.stagedFiles = S.state.stagedFiles || [];
  if (!S.state.stagedFiles.includes(path)) S.state.stagedFiles.push(path);
  render(); toast("File staged"); persist();
}

export async function unstageFile(path: string) {
  await api("/api/unstage", { method: "POST", body: JSON.stringify({ path }) }).catch(() => {});
  S.state.stagedFiles = (S.state.stagedFiles || []).filter((p: string) => p !== path);
  render(); toast("File unstaged"); persist();
}

export async function acceptChange(id: string, status: string) {
  const change = S.state.changes.find((c: any) => c.id === id);
  if (!change || change.status === status) return;
  if (status === "accepted" && change.stageable) {
    const result = await api("/api/stage-change", { method: "POST", body: JSON.stringify({ path: change.path, stableKey: change.stableKey }) });
    if (result.error) { toast(`Could not stage change: ${result.error}`); return; }
    S.state.stagedChangeKeys = S.state.stagedChangeKeys || [];
    const key = `${change.path}:${change.stableKey}`;
    if (!S.state.stagedChangeKeys.includes(key)) S.state.stagedChangeKeys.push(key);
  }
  change.status = status;
  change.reviewedHash = change.contentHash;
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(change.path)) S.state.decisionFiles.push(change.path);
  D.fileDiff = applyDecisionToDiff(D.fileDiff, change, status);
  toast(status === "accepted" ? "Accepted and staged" : "Rejected");
  render(); persist();
}
