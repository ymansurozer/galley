import type { DiffHunk } from "../types";
import { blockSignedOff } from "./decisions-derive";
import { isFullySkimmed } from "./skim-derive";
import type { StepSlot } from "./steps";
import { blockLineStat } from "./walkthrough";
import type { ChangeState, FileReviewState, ReviewComment, ReviewState, Side } from "./types";

// ── One-pass file index for bulk derivations ─────────────────────────────────
// The tree, walkthrough, progress bar, nav seeks, and the completion gate all classify EVERY
// file per evaluation — and the per-path predicates they leaned on (fileReviewState /
// fileFinished / fileFullySkimmed / fileOutOfFlow) each rescan the GLOBAL changes/comments/
// decisions/files arrays. At 1,275 files × 3,542 change blocks that is millions of reads per
// pass, every read through Alpine's dependency-tracking proxy: a single file switch froze the
// main thread for ~20s on a real monorepo desk. This module groups everything by path in ONE
// pass, so a bulk caller does O(files + changes + comments + decisions) work per evaluation.
//
// Reactivity is preserved by construction: the builder reads the same reactive properties the
// per-path predicates read (path/status/skim of every change, etc.), just once each — so an
// Alpine effect that builds the index tracks the same dependencies and re-runs on the same
// mutations. That is also why the index must be built PER EVALUATION and never cached across
// effects: a cache hit inside a different effect would register no dependencies at all.
//
// The lookups below MUST mirror the single-call predicates, which stay the source of truth for
// one-off call sites: fileFullySkimmed/fileOutOfFlow (skim.ts), fileFinished/fileObjections/
// fileReviewState (changes.ts). flow-index.test.ts pins the parity.

export type FlowIndex = {
  // s.changes / s.comments grouped by path (absent path → no entry; callers default to []).
  changesByPath: Map<string, ChangeState[]>;
  commentsByPath: Map<string, ReviewComment[]>;
  // Mirrors fileFullySkimmed / fileOutOfFlow over every path in s.files.
  fullySkimmed: Set<string>;
  outOfFlow: Set<string>;
  // Mirror fileFinished / fileReviewState.
  finished(path: string): boolean;
  reviewState(path: string): FileReviewState;
  // Per review step (steps.ts). A whole-file step is its file's: finished, objections and state
  // as above. A part or Rest step is finished once each of its blocks is signed off against its
  // current content (signedOffBlocks), or while its file's own sign-off is current: a whole-file
  // approval signs off every block, and a review saved before blocks were signed off carries only
  // that. Its objections are its own: a rejected block, or an open change request whose nearest
  // block is one of its blocks (attributeComment).
  stepFinished(slot: StepOf): boolean;
  stepObjections(slot: StepOf): boolean;
  stepState(slot: StepOf): FileReviewState;
};

type StepOf = Pick<StepSlot, "path" | "blocks">;

type IndexedState = Pick<
  ReviewState,
  | "files"
  | "changes"
  | "comments"
  | "decisions"
  | "reviewedFiles"
  | "reviewedFileHashes"
  | "signedOffBlocks"
  | "guide"
>;

const EMPTY: IndexedState = { files: [], changes: [], comments: [], reviewedFiles: [] };

export function deriveFlowIndex(s: IndexedState | null | undefined): FlowIndex {
  const st = s ?? EMPTY;
  const changesByPath = new Map<string, ChangeState[]>();
  for (const c of st.changes) {
    let list = changesByPath.get(c.path);
    if (!list) changesByPath.set(c.path, (list = []));
    list.push(c);
  }
  const commentsByPath = new Map<string, ReviewComment[]>();
  // Paths with an open requested-change comment (open, by the user, not a question) —
  // fileObjections' comment half.
  const openChangePaths = new Set<string>();
  for (const c of st.comments) {
    let list = commentsByPath.get(c.path);
    if (!list) commentsByPath.set(c.path, (list = []));
    list.push(c);
    if (asksChange(c)) openChangePaths.add(c.path);
  }
  // fileObjections' decision half: any rejected hunk on the path.
  const rejectedPaths = new Set<string>();
  const rejectedKeys = new Set<string>();
  for (const d of st.decisions ?? [])
    if (d.status === "rejected") {
      rejectedPaths.add(d.path);
      rejectedKeys.add(d.key);
    }
  const guideSkim = new Set<string>();
  for (const g of st.guide?.files ?? []) if (g.skim) guideSkim.add(g.path);
  const reviewed = new Set(st.reviewedFiles ?? []);
  const hashes = st.reviewedFileHashes ?? {};

  const contentHash = new Map<string, string>();
  const fullySkimmed = new Set<string>();
  const outOfFlow = new Set<string>();
  for (const f of st.files) {
    contentHash.set(f.path, f.contentHash);
    const blockSkims = (changesByPath.get(f.path) ?? []).map((c) => !!c.skim);
    if (isFullySkimmed(guideSkim.has(f.path), blockSkims)) fullySkimmed.add(f.path);
    if (fullySkimmed.has(f.path) || f.renamePure) outOfFlow.add(f.path);
  }

  // fileFinished: signed off AND the recorded hash still matches the file's current content
  // key. A path not in files has no contentHash entry, so the equality fails — same as the
  // original's `!!file` guard.
  const finished = (path: string) => {
    const h = hashes[path];
    return reviewed.has(path) && !!h && h === contentHash.get(path);
  };
  const objections = (path: string) => rejectedPaths.has(path) || openChangePaths.has(path);
  const reviewState = (path: string): FileReviewState => {
    if (!finished(path)) return "pending";
    return objections(path) ? "changes-requested" : "approved";
  };

  const signedOff = st.signedOffBlocks;
  const hunksByPath = new Map(st.files.map((f) => [f.path, f.hunks ?? []] as const));
  // The blocks an open change request is attributed to, per path: placed on first ask, since only
  // split files' steps need them.
  const askedBlocks = new Map<string, Set<string>>();
  const askedOf = (path: string) => {
    let ids = askedBlocks.get(path);
    if (ids) return ids;
    askedBlocks.set(path, (ids = new Set()));
    const asks = (commentsByPath.get(path) ?? []).filter(asksChange);
    if (!asks.length) return ids;
    const placed = placeBlocks(changesByPath.get(path) ?? [], hunksByPath.get(path) ?? []);
    for (const c of asks) {
      const block = attributeComment(c, placed);
      if (block) ids.add(block.id);
    }
    return ids;
  };
  const stepFinished = ({ path, blocks }: StepOf) =>
    finished(path) || (!!blocks?.length && blocks.every((c) => blockSignedOff(signedOff, c)));
  const stepObjections = ({ path, blocks }: StepOf) => {
    if (!blocks) return objections(path);
    const asked = askedOf(path);
    return blocks.some((c) => rejectedKeys.has(c.id) || asked.has(c.id));
  };
  const stepState = (slot: StepOf): FileReviewState => {
    if (!slot.blocks) return reviewState(slot.path);
    if (!stepFinished(slot)) return "pending";
    return stepObjections(slot) ? "changes-requested" : "approved";
  };
  return {
    changesByPath,
    commentsByPath,
    fullySkimmed,
    outOfFlow,
    finished,
    reviewState,
    stepFinished,
    stepObjections,
    stepState,
  };
}

// An open change request: open, by the reviewer, and not a question (fileObjections' rule).
const asksChange = (c: ReviewComment) =>
  c.status === "open" && c.role !== "agent" && c.intent !== "question";

// ── Comment attribution ──────────────────────────────────────────────────────
// Comments carry no step. A change request counts against the part (or Rest) whose block is
// nearest its line, on the comment's own side: the new file's lines for an `additions` comment,
// the old file's for a `deletions` one. A block's span on a side is its first..last line there;
// a side it has no lines on gives an empty span (last = first - 1) just past the line before it.
type Span = [number, number];
export type PlacedBlock = { block: ChangeState } & Partial<Record<Side, Span>>;

// The spans of every change block in a file's diff hunks, by the block's stableKey
// (`side:line:deletions:additions`, built as the server's changeStableKeyFromBlock builds it). The
// hunks give a mixed block's old-side lines, which its key doesn't carry.
function hunkSpans(hunks: DiffHunk[]): Map<string, Record<Side, Span>> {
  const spans = new Map<string, Record<Side, Span>>();
  for (const h of hunks) {
    // A header whose count is 0 names the line before the hunk.
    let oldLine = h.oldCount ? h.oldStart - 1 : h.oldStart;
    let newLine = h.newCount ? h.newStart - 1 : h.newStart;
    let open: { oldBefore: number; newBefore: number; dels: number; adds: number } | null = null;
    const close = () => {
      if (!open) return;
      const { oldBefore, newBefore, dels, adds } = open;
      const key = adds
        ? `additions:${newBefore + 1}:${dels}:${adds}`
        : `deletions:${oldBefore + 1}:${dels}:0`;
      spans.set(key, {
        deletions: [oldBefore + 1, oldBefore + dels],
        additions: [newBefore + 1, newBefore + adds],
      });
      open = null;
    };
    for (const l of h.lines) {
      if (l.kind === "context") close();
      else {
        open ??= { oldBefore: oldLine, newBefore: newLine, dels: 0, adds: 0 };
        if (l.kind === "delete") open.dels++;
        else open.adds++;
      }
      if (l.kind !== "add") oldLine++;
      if (l.kind !== "delete") newLine++;
    }
    close();
  }
  return spans;
}

// A file's blocks (in document order) with their spans: both sides from the file's hunks, else
// only the side the block's key names (a block the tab derived differently from git).
export function placeBlocks(blocks: ChangeState[], hunks: DiffHunk[]): PlacedBlock[] {
  const spans = hunkSpans(hunks);
  return blocks.map((block) => {
    const both = block.stableKey ? spans.get(block.stableKey) : undefined;
    if (both) return { block, ...both };
    const m = block.stableKey?.match(/^(?:additions|deletions):\d+:(\d+):(\d+)$/);
    const count = m ? Number(block.side === "additions" ? m[2] : m[1]) : 1;
    return { block, [block.side]: [block.lineNumber, block.lineNumber + count - 1] };
  });
}

// The block a comment is attributed to: the one nearest its line on its side, the earlier one on a
// tie. undefined when no block has a span on that side.
export function attributeComment(
  c: Pick<ReviewComment, "side" | "lineNumber">,
  placed: PlacedBlock[],
): ChangeState | undefined {
  let best: ChangeState | undefined;
  let bestDistance = Infinity;
  for (const p of placed) {
    const span = p[c.side];
    if (!span) continue;
    const [first, last] = span;
    const d = c.lineNumber < first ? first - c.lineNumber : Math.max(0, c.lineNumber - last);
    if (d < bestDistance) [best, bestDistance] = [p.block, d];
  }
  return best;
}

// A step's share of review progress: its own changed lines (a part's or Rest's blocks, a whole
// file's `fileLines`), at least 1 so every step counts, or 1 each when progress goes by files.
export function stepWeight(
  slot: Pick<StepSlot, "blocks">,
  fileLines: number,
  byFiles: boolean,
): number {
  if (byFiles) return 1;
  if (!slot.blocks) return Math.max(fileLines, 1);
  let lines = 0;
  for (const c of slot.blocks) {
    const s = blockLineStat(c);
    lines += s.added + s.removed;
  }
  return Math.max(lines, 1);
}
