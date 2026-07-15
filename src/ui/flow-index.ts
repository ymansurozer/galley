import { isFullySkimmed } from "./skim-derive";
import type { ChangeState, ReviewComment, ReviewState } from "./types";

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
  reviewState(path: string): "pending" | "approved" | "changes-requested";
};

type IndexedState = Pick<
  ReviewState,
  "files" | "changes" | "comments" | "decisions" | "reviewedFiles" | "reviewedFileHashes" | "guide"
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
    if (c.status === "open" && c.role !== "agent" && c.intent !== "question")
      openChangePaths.add(c.path);
  }
  // fileObjections' decision half: any rejected hunk on the path.
  const rejectedPaths = new Set<string>();
  for (const d of st.decisions ?? []) if (d.status === "rejected") rejectedPaths.add(d.path);
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
  const reviewState = (path: string): "pending" | "approved" | "changes-requested" => {
    if (!finished(path)) return "pending";
    return rejectedPaths.has(path) || openChangePaths.has(path) ? "changes-requested" : "approved";
  };
  return { changesByPath, commentsByPath, fullySkimmed, outOfFlow, finished, reviewState };
}
