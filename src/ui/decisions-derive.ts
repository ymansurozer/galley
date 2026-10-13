import type { ChangeContent } from "@pierre/diffs";
import type { ChangeState, Decision, ReviewState } from "./types";

type ReviewFile = ReviewState["files"][number];

// The key a change block (and the decision on it, `path:stableKey`) goes by. It must equal the
// server's changeStableKeyFromBlock (git.ts): a file signed off from the sidebar before it was
// ever opened records its decisions against the server's blocks, and opening it re-derives them
// here (changes.ts deriveChanges), matching each decision back by this key.
export function changeStableKey(part: ChangeContent) {
  const side = part.additions > 0 ? "additions" : "deletions";
  const lineNumber = (side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1;
  return `${side}:${lineNumber}:${part.deletions || 0}:${part.additions || 0}`;
}

// The explicit decision record is the source of truth for accept/reject (decoupled
// from git staging). Every status change must go through these so it survives reload.
export function recordDecision(
  state: ReviewState,
  change: ChangeState,
  status: Decision["status"],
) {
  state.decisions = state.decisions || [];
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
  const i = state.decisions.findIndex((d) => d.key === key);
  if (i >= 0) state.decisions[i] = entry;
  else state.decisions.push(entry);
}

// Sign off on a file: accept any still-pending blocks (un-objected lines the reviewer didn't
// reject) and mark it finished against its current content hash. Staging is the caller's — it's a
// git-index op. The displayed terminal state (approved vs changes-requested) is derived from
// objections, never recorded.
export function signOff(state: ReviewState, file: ReviewFile) {
  const path = file.path;
  for (const c of state.changes) {
    if (c.path !== path || c.status !== "pending") continue;
    c.status = "accepted";
    c.reviewedHash = c.contentHash;
    recordDecision(state, c, "accepted");
  }
  state.decisionFiles = state.decisionFiles || [];
  if (!state.decisionFiles.includes(path)) state.decisionFiles.push(path);
  state.reviewedFiles = state.reviewedFiles || [];
  if (!state.reviewedFiles.includes(path)) state.reviewedFiles.push(path);
  state.reviewedFileHashes = state.reviewedFileHashes || {};
  state.reviewedFileHashes[path] = file.contentHash;
}

// Everything a file's Reset clears, captured first so Undo can put back exactly that.
export type FileReview = {
  path: string;
  changes: Map<string, Pick<ChangeState, "status" | "reviewedHash">>;
  decisions: Decision[];
  decided: boolean;
  reviewed: boolean;
  reviewedHash?: string;
  staged: boolean;
  stagedChangeKeys: string[];
};

const ownKey = (path: string) => (k: string) => k.startsWith(`${path}:`);

export function captureFileReview(state: ReviewState, path: string): FileReview {
  const changes = state.changes.filter((c) => c.path === path);
  return {
    path,
    changes: new Map(
      changes.map((c) => [c.id, { status: c.status, reviewedHash: c.reviewedHash }]),
    ),
    decisions: (state.decisions ?? []).filter((d) => d.path === path).map((d) => ({ ...d })),
    decided: !!state.decisionFiles?.includes(path),
    reviewed: state.reviewedFiles.includes(path),
    reviewedHash: state.reviewedFileHashes?.[path],
    staged: state.stagedFiles.includes(path),
    stagedChangeKeys: (state.stagedChangeKeys ?? []).filter(ownKey(path)),
  };
}

// A file's Reset: its blocks back to pending, its decisions, sign-off and hash gone, and its
// staging record dropped (the caller unstages the index).
export function clearFileReview(state: ReviewState, path: string) {
  state.changes.filter((c) => c.path === path).forEach((c) => (c.status = "pending"));
  state.decisions = (state.decisions || []).filter((d) => d.path !== path);
  state.stagedChangeKeys = (state.stagedChangeKeys || []).filter((k) => !ownKey(path)(k));
  state.decisionFiles = (state.decisionFiles || []).filter((p) => p !== path);
  state.reviewedFiles = (state.reviewedFiles || []).filter((p) => p !== path);
  if (state.reviewedFileHashes) delete state.reviewedFileHashes[path];
  state.stagedFiles = (state.stagedFiles || []).filter((p) => p !== path);
}

// Undo a Reset: put the captured review back over whatever the file holds now. The staging
// record is restored here; re-staging the index is the caller's.
export function restoreFileReview(state: ReviewState, prior: FileReview) {
  const { path } = prior;
  for (const c of state.changes) {
    const was = c.path === path ? prior.changes.get(c.id) : undefined;
    if (!was) continue;
    c.status = was.status;
    c.reviewedHash = was.reviewedHash;
  }
  state.decisions = (state.decisions || []).filter((d) => d.path !== path);
  state.decisions.push(...prior.decisions);
  const restore = (list: string[] | undefined, on: boolean) => {
    const rest = (list || []).filter((p) => p !== path);
    return on ? [...rest, path] : rest;
  };
  state.decisionFiles = restore(state.decisionFiles, prior.decided);
  state.reviewedFiles = restore(state.reviewedFiles, prior.reviewed);
  state.stagedFiles = restore(state.stagedFiles, prior.staged);
  state.reviewedFileHashes = state.reviewedFileHashes || {};
  if (prior.reviewedHash) state.reviewedFileHashes[path] = prior.reviewedHash;
  else delete state.reviewedFileHashes[path];
  state.stagedChangeKeys = (state.stagedChangeKeys || []).filter((k) => !ownKey(path)(k));
  state.stagedChangeKeys.push(...prior.stagedChangeKeys);
}
