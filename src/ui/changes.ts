import type { ChangeContent, FileDiffMetadata } from "@pierre/diffs";
import { S, D } from "./store";
import type { ChangeState, ReviewComment, ReviewState } from "./types";

type ReviewFile = ReviewState["files"][number];
type ChangeStatus = ChangeState["status"];

// The file the diff is currently showing. A `preview` (an unchanged file the reviewer opened
// to read/comment on) takes precedence over the indexed review file when set.
export function currentFile(): ReviewFile { return S.preview ?? S.state.files[S.fileIndex]; }
// Split view only makes sense for a two-sided diff. A new file (no old side), a deleted file
// (no new side), or a view-only full file (old === new — including any preview) render
// single-column, so split is a no-op — used to render them unified and to disable the toggle.
export function currentSplittable(): boolean {
  const f = S.preview ?? S.state?.files?.[S.fileIndex];
  if (!f) return true;
  const o = f.oldFile?.contents ?? "", n = f.newFile?.contents ?? "";
  return o !== "" && n !== "" && o !== n;
}
export function currentChanges(): ChangeState[] { return S.state.changes.filter((c) => c.path === currentFile().path); }
export function currentComments(): ReviewComment[] { return S.state.comments.filter((c) => c.path === currentFile().path); }

export function changeStableKey(part: ChangeContent) {
  const side = part.additions > 0 ? "additions" : "deletions";
  const lineNumber = (side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1;
  return `${side}:${lineNumber}:${part.deletions || 0}:${part.additions || 0}`;
}

export function deriveChanges(diff: FileDiffMetadata, path: string, previous = new Map<string, ChangeState>()): ChangeState[] {
  const derived: ChangeState[] = [];
  diff.hunks.forEach((h, hunkIndex) => {
    (h.hunkContent || []).forEach((part, contentIndex) => {
      if (part.type !== "change") return;
      const side = part.additions > 0 ? "additions" : "deletions";
      const lineNumber = (side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1;
      const stableKey = changeStableKey(part);
      const id = `${path}:${stableKey}`;
      const prev = previous.get(id);
      // Status comes from the explicit decision record (source of truth), not from
      // whether the hunk happens to be staged.
      const decision = (S.state.decisions || []).find((d) => d.key === id);
      const status: ChangeStatus = decision?.status ?? "pending";
      derived.push({ id, path, hunkIndex, changeIndex: contentIndex, stableKey, side, lineNumber, endLine: (side === "additions" ? part.additionLineIndex + (part.additions || 1) : part.deletionLineIndex + (part.deletions || 1)), title: `${part.deletions || 0} removed · ${part.additions || 0} added`, status, stageable: prev?.stageable, contentHash: prev?.contentHash, reviewedHash: decision?.reviewedHash ?? prev?.reviewedHash });
    });
  });
  return derived;
}

export function ensureChangesFromFileDiff(diff = D.fileDiff) {
  if (!diff) return;
  const path = currentFile().path;
  const previous = new Map(S.state.changes.filter((c) => c.path === path).map((c) => [c.id, c]));
  const derived = deriveChanges(diff, path, previous);
  S.state.changes = S.state.changes.filter((c) => c.path !== path).concat(derived);
}

export function findChangePosition(diff: FileDiffMetadata, stableKey: string) {
  for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
    const h = diff.hunks[hunkIndex];
    for (let changeIndex = 0; changeIndex < (h.hunkContent || []).length; changeIndex++) {
      const part = h.hunkContent[changeIndex];
      if (part?.type === "change" && changeStableKey(part) === stableKey) return { hunkIndex, changeIndex };
    }
  }
  return null;
}

export function applyDecisionToDiff(diff: FileDiffMetadata, change: ChangeState, status: ChangeStatus): FileDiffMetadata {
  const pos = change.stableKey ? findChangePosition(diff, change.stableKey) : null;
  if (!pos) return diff;
  try { return D.diffAcceptRejectHunk(diff, pos.hunkIndex, { type: status === "accepted" ? "accept" : "reject", changeIndex: pos.changeIndex }); } catch { return diff; }
}

export function replayDecisions(diff: FileDiffMetadata): FileDiffMetadata {
  for (const change of currentChanges().filter((c) => c.status !== "pending")) diff = applyDecisionToDiff(diff, change, change.status);
  return diff;
}
