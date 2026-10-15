import type { FileDiffMetadata } from "@pierre/diffs";
import { S, D, persist } from "./store";
import { cur } from "./contents";
import { anchorSelection, buildLineMap, identityLineMap } from "./linemap";
import { blockAt, changePosition, replayPositions } from "./replay";
import { inStep } from "./steps";
import { acceptSignedOffBlocks } from "./decisions-derive";
import { deriveChanges } from "./changes-derive";
import { deriveFlowIndex, type FlowIndex } from "./flow-index";
import type { ChangeState, ReviewComment, ReviewState, Side } from "./types";

// One-pass per-path index over the live state for BULK derivations (the tree, walkthrough,
// progress, nav seeks, completion gate) — anywhere that classifies every file per evaluation.
// The per-path predicates below stay the source of truth for one-off call sites; iterating
// files through them is O(files × changes) and froze big desks (see flow-index.ts). Build the
// index once per evaluation and never cache it across effects.
export function flowIndex(): FlowIndex {
  return deriveFlowIndex(S.state);
}

type ReviewFile = ReviewState["files"][number];
type ChangeStatus = ChangeState["status"];

// The file the diff is currently showing. A `preview` (an unchanged file the reviewer opened
// to read/comment on) takes precedence over the indexed review file when set.
export function currentFile(): ReviewFile {
  return S.preview ?? S.state.files[S.fileIndex];
}
// Split view only makes sense for a two-sided diff. A new file (no old side), a deleted file
// (no new side), or a view-only full file (old === new — including any preview) render
// single-column, so split is a no-op — used to render them unified and to disable the toggle.
export function currentSplittable(): boolean {
  const f = S.preview ?? S.state?.files?.[S.fileIndex];
  if (!f) return true;
  // Two-sided-ness is a property of the contents, which now arrive via the per-file fetch
  // (contents.ts `cur`). Until they're loaded for the current file, default to splittable — the
  // render pass awaits the fetch before it reads this, so the meaningful call sites see real bytes.
  if (cur.path !== f.path) return true;
  const o = cur.oldContents,
    n = cur.newContents;
  return o !== "" && n !== "" && o !== n;
}
export function currentChanges(): ChangeState[] {
  return S.state.changes.filter((c) => c.path === currentFile().path);
}
// Whether the step on screen covers a change block of its file (steps.ts inStep): every block in
// the whole-file view, only the step's own in a part or Rest view, where the rest render as plain
// code. Readers of the rendered blocks (verdict bars, the block cursor, skims) filter through
// this; currentChanges stays every block, since the replay and sign-off need all of them.
export function inCurrentStep(c: ChangeState): boolean {
  return inStep(S.state.guide?.files ?? [], S.preview ? undefined : S.stepPart, c);
}
// The block of the file on screen whose raw lines on `side` include `line` (see replay.ts).
export function currentBlockAt(side: Side, line: number): ChangeState | undefined {
  return D.rawFileDiff ? blockAt(D.rawFileDiff, currentChanges(), side, line) : undefined;
}
export function currentComments(): ReviewComment[] {
  return S.state.comments.filter((c) => c.path === currentFile().path);
}

// ── File-level review state: pending / approved / changes-requested ──────────
export type FileReviewState = "pending" | "approved" | "changes-requested";

// A file has objections if the reviewer rejected a hunk in it OR left an open requested-change
// comment (open, by the user, not a question). Questions are answered live, so they don't count.
// Mirrors the server's computeApprovedFiles so the desk and the handoff agree.
export function fileObjections(path: string): boolean {
  const rejected = (S.state.decisions ?? []).some(
    (d) => d.path === path && d.status === "rejected",
  );
  const openChange = S.state.comments.some(
    (c) => c.path === path && c.status === "open" && c.role !== "agent" && c.intent !== "question",
  );
  return rejected || openChange;
}

// A file is "finished" only while its sign-off is current: it's in reviewedFiles and the content
// hash recorded at sign-off still matches the file (the agent hasn't rewritten it since).
export function fileFinished(path: string): boolean {
  if (!S.state.reviewedFiles?.includes(path)) return false;
  const h = S.state.reviewedFileHashes?.[path];
  const file = S.state.files.find((f) => f.path === path);
  return !!h && !!file && h === file.contentHash;
}

// The single source of truth for a changed file's badge/header/progress state.
export function fileReviewState(path: string): FileReviewState {
  if (!fileFinished(path)) return "pending";
  return fileObjections(path) ? "changes-requested" : "approved";
}

export function ensureChangesFromFileDiff(diff = D.fileDiff) {
  if (!diff) return;
  const path = currentFile().path;
  const previous = new Map(S.state.changes.filter((c) => c.path === path).map((c) => [c.id, c]));
  const derived = deriveChanges(diff, path, previous, S.state.decisions || []);
  S.state.changes = S.state.changes.filter((c) => c.path !== path).concat(derived);
  // Blocks a sign-off couldn't see (an untracked add signed off unopened) are accepted now.
  const file = S.state.files.find((f) => f.path === path);
  if (file && acceptSignedOffBlocks(S.state, file)) persist();
}

export function applyDecisionToDiff(
  diff: FileDiffMetadata,
  change: ChangeState,
  status: ChangeStatus,
): FileDiffMetadata {
  const pos = changePosition(diff, change);
  if (!pos) return diff;
  try {
    return D.diffAcceptRejectHunk(diff, pos.hunkIndex, {
      type: status === "accepted" ? "accept" : "reject",
      changeIndex: pos.changeIndex,
    });
  } catch {
    return diff;
  }
}

// Replay the view's resolutions onto the raw diff — every decided block, plus the pending blocks
// the step doesn't cover (replay.ts) — and rebuild the raw↔display line map the rest of the render
// (annotations, cursor, selections) converts through, from the same list.
export function replayDecisions(diff: FileDiffMetadata): FileDiffMetadata {
  const resolved = replayPositions(diff, currentChanges(), inCurrentStep);
  D.lineMap = resolved.length ? buildLineMap(diff, resolved) : null;
  for (const d of resolved) {
    try {
      diff = D.diffAcceptRejectHunk(diff, d.hunkIndex, {
        type: d.status === "accepted" ? "accept" : "reject",
        changeIndex: d.changeIndex,
      });
    } catch {
      // leave this block unresolved rather than aborting the replay
    }
  }
  return diff;
}

// Refresh pending changes' display anchors from the replayed diff: the annotation for a
// block must sit at the line number @pierre will actually render, not the raw file line. A
// pending block the replay resolved (another step's, in a part view) renders no change rows, so
// it keeps no anchor.
export function syncDisplayAnchors(resolved: FileDiffMetadata) {
  for (const c of currentChanges()) {
    if (c.status !== "pending" || c.changeIndex === undefined) continue;
    const part = resolved.hunks[c.hunkIndex]?.hunkContent?.[c.changeIndex];
    if (part?.type !== "change") {
      c.displayLineNumber = c.displayEndLine = undefined;
      continue;
    }
    const lineNumber =
      (c.side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1;
    c.displayLineNumber = lineNumber;
    c.displayEndLine =
      c.side === "additions"
        ? part.additionLineIndex + (part.additions || 1)
        : part.deletionLineIndex + (part.deletions || 1);
  }
}

// Raw ↔ display conversions for the current file (identity until decisions replay).
export function toDisplayLine(side: Side, line: number): number {
  return D.lineMap ? D.lineMap.toDisplay(side, line) : line;
}
export function fromDisplayLine(side: Side, line: number): number {
  return D.lineMap ? D.lineMap.fromDisplay(side, line) : line;
}
// What a selection on rendered rows anchors to — the side and raw line of the code the row shows
// (linemap.ts anchorAt): a row of a resolved block shows one version in both gutters. Every site
// turning a selection or the cursor into a comment anchor reads through these.
export function rowAnchor(side: Side, line: number): { side: Side; line: number } {
  return (D.lineMap ?? identityLineMap()).anchorAt(side, line);
}
export function selectionAnchor(side: Side, line: number, end?: number) {
  return anchorSelection(D.lineMap ?? identityLineMap(), side, line, end);
}
