import { S, D } from "./store";

export function currentFile() { return S.state.files[S.fileIndex]; }
export function currentChanges() { return S.state.changes.filter((c: any) => c.path === currentFile().path); }
export function currentComments() { return S.state.comments.filter((c: any) => c.path === currentFile().path); }

export function changeStableKey(part: any) {
  const side = part.additions > 0 ? "additions" : "deletions";
  const lineNumber = (side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1;
  return `${side}:${lineNumber}:${part.deletions || 0}:${part.additions || 0}`;
}

export function deriveChanges(diff: any, path: string, previous = new Map()) {
  const derived: any[] = [];
  diff.hunks.forEach((h: any, hunkIndex: number) => {
    (h.hunkContent || []).forEach((part: any, contentIndex: number) => {
      if (part.type !== "change") return;
      const side = part.additions > 0 ? "additions" : "deletions";
      const lineNumber = (side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1;
      const stableKey = changeStableKey(part);
      const id = `${path}:${stableKey}`;
      const prev: any = previous.get(id);
      const status = (S.state.stagedChangeKeys || []).includes(`${path}:${stableKey}`) ? "accepted" : prev?.status || "pending";
      derived.push({ id, path, hunkIndex, changeIndex: contentIndex, stableKey, side, lineNumber, endLine: (side === "additions" ? part.additionLineIndex + (part.additions || 1) : part.deletionLineIndex + (part.deletions || 1)), title: `${part.deletions || 0} removed · ${part.additions || 0} added`, status, stageable: prev?.stageable, contentHash: prev?.contentHash, reviewedHash: prev?.reviewedHash });
    });
  });
  return derived;
}

export function ensureChangesFromFileDiff(diff = D.fileDiff) {
  if (!diff) return;
  const path = currentFile().path;
  const previous = new Map(S.state.changes.filter((c: any) => c.path === path).map((c: any) => [c.id, c]));
  const derived = deriveChanges(diff, path, previous);
  S.state.changes = S.state.changes.filter((c: any) => c.path !== path).concat(derived);
}

export function findChangePosition(diff: any, stableKey: string) {
  for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
    const h = diff.hunks[hunkIndex];
    for (let changeIndex = 0; changeIndex < (h.hunkContent || []).length; changeIndex++) {
      const part = h.hunkContent[changeIndex];
      if (part?.type === "change" && changeStableKey(part) === stableKey) return { hunkIndex, changeIndex };
    }
  }
  return null;
}

export function applyDecisionToDiff(diff: any, change: any, status: string) {
  const pos = findChangePosition(diff, change.stableKey);
  if (!pos) return diff;
  try { return D.diffAcceptRejectHunk(diff, pos.hunkIndex, { type: status === "accepted" ? "accept" : "reject", changeIndex: pos.changeIndex }); } catch { return diff; }
}

export function replayDecisions(diff: any) {
  for (const change of currentChanges().filter((c: any) => c.status !== "pending")) diff = applyDecisionToDiff(diff, change, change.status);
  return diff;
}
