import type { ChangeContent, FileDiffMetadata } from "@pierre/diffs";
import type { ChangeState, Decision, ReviewState, Side } from "./types";

type ReviewFile = ReviewState["files"][number];

// The key a change block (and the decision on it, `path:stableKey`) goes by. It must equal the
// server's changeStableKeyFromBlock (git.ts): a file signed off from the sidebar before it was
// ever opened records its decisions against the server's blocks, and opening it re-derives them
// here (changes-derive.ts deriveChanges), matching each decision back by this key.
export function changeStableKey(part: ChangeContent) {
  const side = part.additions > 0 ? "additions" : "deletions";
  const lineNumber = (side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1;
  return `${side}:${lineNumber}:${part.deletions || 0}:${part.additions || 0}`;
}

// The display lines a change's rows show on each side of the rendered (decision-replayed) diff,
// first to last, or null for a side it has no rows on. A replace shows both. A change's hunk and
// change indexes hold in the replayed diff (syncDisplayAnchors reads its anchors the same way).
// A change without a part to read there — one adopted from a poll, whose server block carries no
// change index until the next render re-derives it — spans its own side's anchors.
export type ChangeSpan = Record<Side, [number, number] | null>;

export function changeSpan(
  change: ChangeState,
  rendered: Pick<FileDiffMetadata, "hunks">,
): ChangeSpan {
  const part =
    change.changeIndex === undefined
      ? undefined
      : rendered.hunks[change.hunkIndex]?.hunkContent?.[change.changeIndex];
  if (part?.type !== "change") {
    const own: [number, number] = [
      change.displayLineNumber ?? change.lineNumber,
      change.displayEndLine ?? change.endLine ?? change.lineNumber,
    ];
    return change.side === "additions"
      ? { additions: own, deletions: null }
      : { additions: null, deletions: own };
  }
  const lines = (index: number, count: number): [number, number] | null =>
    count ? [index + 1, index + count] : null;
  return {
    additions: lines(part.additionLineIndex, part.additions),
    deletions: lines(part.deletionLineIndex, part.deletions),
  };
}

export function spanHolds(span: ChangeSpan, side: Side, line: number) {
  const s = span[side];
  return !!s && line >= s[0] && line <= s[1];
}

// The pending change whose rows show this display line, on either side: what ⇧Y / ⇧N act on and
// what the cursor's rail marks. A decided change has folded into plain lines, so it never answers.
export function pendingChangeAt(
  changes: readonly ChangeState[],
  rendered: Pick<FileDiffMetadata, "hunks">,
  side: Side,
  line: number,
): ChangeState | null {
  for (const c of changes) {
    if (c.status !== "pending") continue;
    if (spanHolds(changeSpan(c, rendered), side, line)) return c;
  }
  return null;
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

// A block's sign-off records its contentHash at sign-off (ReviewState.signedOffBlocks). A block
// the tab derived differently from git has none, and records "".
export function blockSignedOff(signed: ReviewState["signedOffBlocks"], c: ChangeState) {
  return signed?.[c.id] === (c.contentHash ?? "");
}

// Sign off on a file: accept any still-pending blocks (un-objected lines the reviewer didn't
// reject), sign off every block, and mark the file finished against its current content hash.
// Staging is the caller's — it's a git-index op. The displayed terminal state (approved vs
// changes-requested) is derived from objections, never recorded.
export function signOff(state: ReviewState, file: ReviewFile) {
  signOffStep(
    state,
    file,
    state.changes.filter((c) => c.path === file.path),
  );
}

// Sign off on one step of a split file, a guide part or its Rest (`blocks`), as signOff does a
// file: accept its still-pending blocks and sign each of its blocks off. The sign-off that leaves
// no block of the file unsigned marks the file finished too, so a file whose parts are all signed
// off is approved (or not) exactly as an unsplit one, in the desk and in the agent's ReviewResult.
// `skimmed` are the blocks of the file's steps that left the flow (steps.ts outOfFlowBlocks): the
// reviewer is never asked to sign those, so the sign-off that leaves only them signs them off too,
// as an unsplit file's sign-off covers its skimmed blocks. A file with no block in the flow stays
// out of it, signed off only block by block.
export function signOffStep(
  state: ReviewState,
  file: ReviewFile,
  blocks: ChangeState[],
  skimmed: ChangeState[] = [],
) {
  const path = file.path;
  const signed = (state.signedOffBlocks = state.signedOffBlocks || {});
  const sign = (c: ChangeState) => {
    if (c.status === "pending") {
      c.status = "accepted";
      c.reviewedHash = c.contentHash;
      recordDecision(state, c, "accepted");
    }
    signed[c.id] = c.contentHash ?? "";
  };
  blocks.forEach(sign);
  state.decisionFiles = state.decisionFiles || [];
  if (!state.decisionFiles.includes(path)) state.decisionFiles.push(path);
  const skimmedIds = new Set(skimmed.map((c) => c.id));
  const own = state.changes.filter((c) => c.path === path);
  const unsigned = own.filter((c) => !blockSignedOff(signed, c));
  if (unsigned.some((c) => !skimmedIds.has(c.id))) return;
  if (unsigned.length) {
    if (own.every((c) => skimmedIds.has(c.id))) return;
    unsigned.forEach(sign);
  }
  state.reviewedFiles = state.reviewedFiles || [];
  if (!state.reviewedFiles.includes(path)) state.reviewedFiles.push(path);
  state.reviewedFileHashes = state.reviewedFileHashes || {};
  state.reviewedFileHashes[path] = file.contentHash;
}

// Everything a Reset clears, captured first so Undo can put back exactly that. A file's Reset
// covers all of it; a step's (`keys`, its blocks' ids) covers its own blocks and the file's
// sign-off, which no longer holds once a part is pending.
export type FileReview = {
  path: string;
  keys: string[] | null;
  changes: Map<string, Pick<ChangeState, "status" | "reviewedHash">>;
  decisions: Decision[];
  signedOff: Record<string, string>;
  decided: boolean;
  reviewed: boolean;
  reviewedHash?: string;
  staged: boolean;
  stagedChangeKeys: string[];
};

// Whether a `path:stableKey` key falls in a Reset's scope.
const inScope = (path: string, keys: string[] | null) => (k: string) =>
  keys ? keys.includes(k) : k.startsWith(`${path}:`);

export function captureFileReview(
  state: ReviewState,
  path: string,
  blocks?: ChangeState[],
): FileReview {
  const keys = blocks ? blocks.map((c) => c.id) : null;
  const own = inScope(path, keys);
  const changes = state.changes.filter((c) => c.path === path && own(c.id));
  return {
    path,
    keys,
    changes: new Map(
      changes.map((c) => [c.id, { status: c.status, reviewedHash: c.reviewedHash }]),
    ),
    decisions: (state.decisions ?? [])
      .filter((d) => d.path === path && own(d.key))
      .map((d) => ({ ...d })),
    signedOff: Object.fromEntries(
      Object.entries(state.signedOffBlocks ?? {}).filter(([k]) => own(k)),
    ),
    decided: !!state.decisionFiles?.includes(path),
    reviewed: state.reviewedFiles.includes(path),
    reviewedHash: state.reviewedFileHashes?.[path],
    // A step's Reset leaves the file's staging record to the file.
    staged: !keys && state.stagedFiles.includes(path),
    stagedChangeKeys: (state.stagedChangeKeys ?? []).filter(own),
  };
}

// A Reset (of the file, or of a step's `blocks`): those blocks back to pending, their decisions
// and sign-offs gone, the file's sign-off and hash gone, and the staging records dropped (the
// caller unstages the index). The file stays decided while a decision outside the step remains.
export function clearFileReview(state: ReviewState, path: string, blocks?: ChangeState[]) {
  const own = inScope(path, blocks ? blocks.map((c) => c.id) : null);
  state.changes.filter((c) => c.path === path && own(c.id)).forEach((c) => (c.status = "pending"));
  state.decisions = (state.decisions || []).filter((d) => d.path !== path || !own(d.key));
  for (const k of Object.keys(state.signedOffBlocks ?? {}))
    if (own(k)) delete state.signedOffBlocks![k];
  state.stagedChangeKeys = (state.stagedChangeKeys || []).filter((k) => !own(k));
  if (!state.decisions.some((d) => d.path === path))
    state.decisionFiles = (state.decisionFiles || []).filter((p) => p !== path);
  state.reviewedFiles = (state.reviewedFiles || []).filter((p) => p !== path);
  if (state.reviewedFileHashes) delete state.reviewedFileHashes[path];
  if (!blocks) state.stagedFiles = (state.stagedFiles || []).filter((p) => p !== path);
}

// Undo a Reset: put the captured review back over whatever the file holds now. Staging is the
// caller's — it re-stages from `prior.staged`/`prior.stagedChangeKeys` and records each stage
// only once the index took it.
export function restoreFileReview(state: ReviewState, prior: FileReview) {
  const { path } = prior;
  const own = inScope(path, prior.keys);
  for (const c of state.changes) {
    const was = c.path === path ? prior.changes.get(c.id) : undefined;
    if (!was) continue;
    c.status = was.status;
    c.reviewedHash = was.reviewedHash;
  }
  state.decisions = (state.decisions || []).filter((d) => d.path !== path || !own(d.key));
  state.decisions.push(...prior.decisions);
  const signed = (state.signedOffBlocks = state.signedOffBlocks || {});
  for (const k of Object.keys(signed)) if (own(k)) delete signed[k];
  Object.assign(signed, prior.signedOff);
  const restore = (list: string[] | undefined, on: boolean) => {
    const rest = (list || []).filter((p) => p !== path);
    return on ? [...rest, path] : rest;
  };
  state.decisionFiles = restore(state.decisionFiles, prior.decided);
  state.reviewedFiles = restore(state.reviewedFiles, prior.reviewed);
  state.reviewedFileHashes = state.reviewedFileHashes || {};
  if (prior.reviewedHash) state.reviewedFileHashes[path] = prior.reviewedHash;
  else delete state.reviewedFileHashes[path];
}

// A file signed off before its blocks were known accepts them once they're derived — exactly
// what the sign-off would have recorded. An untracked add carries no server block, so signing it
// off unopened (the sidebar, the oversized card) accepted nothing; opening it derives its block
// client-side. Only while that sign-off is current: the hash it recorded still matches the file.
// Returns whether any block was accepted (the caller saves).
export function acceptSignedOffBlocks(state: ReviewState, file: ReviewFile): boolean {
  const path = file.path;
  const h = state.reviewedFileHashes?.[path];
  const current = state.reviewedFiles.includes(path) && !!h && h === file.contentHash;
  if (!current || !state.changes.some((c) => c.path === path && c.status === "pending"))
    return false;
  signOff(state, file);
  return true;
}
