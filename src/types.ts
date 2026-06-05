export type DiffLine = {
  kind: "context" | "add" | "delete";
  text: string;
  oldLine?: number;
  newLine?: number;
  diffPosition: number;
  hunkHeader: string;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
};

export type DiffFile = {
  oldPath?: string;
  newPath?: string;
  hunks: DiffHunk[];
};

export type ReviewComment = {
  id: string;
  path: string;
  side: "additions" | "deletions";
  lineNumber: number;
  endLine?: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  status: "open" | "resolved" | "stale";
  // "action" = a change request (goes back to the agent on Send); "question" = a
  // just-in-time question answered live via the await stream; "note" = plain note.
  intent?: "note" | "action" | "question";
  // "user" comments are the reviewer's; "agent" comments are replies posted
  // back by the coding agent via `galley comment` between sessions.
  role?: "user" | "agent";
};

export type ChangeState = {
  id: string;
  path: string;
  hunkIndex: number;
  // Index of this change block within its hunk's content segments.
  changeIndex?: number;
  side: "additions" | "deletions";
  lineNumber: number;
  // Last line of the change block (multi-line blocks); anchors the Undo/Keep annotation.
  endLine?: number;
  title: string;
  stableKey?: string;
  status: "pending" | "accepted" | "rejected";
  // Whether accepting this change stages it to the git index. True only for
  // uncommitted modifications of tracked files (repo mode; file mode when the
  // file is tracked + changed). PR mode and untracked files are verdict-only.
  stageable?: boolean;
  // Hash of the change block's content, computed when the diff is parsed.
  contentHash?: string;
  // contentHash captured at the moment a decision was made; lets a reload
  // detect that the underlying code changed and the prior decision is stale.
  reviewedHash?: string;
};

// An explicit, durable record of a user's accept/reject on a change block, keyed
// by stable identity (`path:stableKey`). This — not git staging — is the source
// of truth for decisions, so a decision survives a reload even when accepting it
// staged the hunk out of the working-tree diff (where it would otherwise vanish).
export type Decision = {
  key: string; // `${path}:${stableKey}`
  status: "accepted" | "rejected";
  // contentHash the decision was made against; lets reconciliation drop a decision
  // as stale if the agent rewrote that block since it was reviewed.
  reviewedHash?: string;
  path: string;
  lineNumber: number;
  side: "additions" | "deletions";
  title: string;
};

export type ReviewFile = DiffFile & {
  path: string;
  oldFile: { name: string; contents: string };
  newFile: { name: string; contents: string };
};

export type ReviewMode = "repo" | "file" | "pr";

// A per-file entry in an agent-generated guided review. `order` drives Next/Prev
// (general → specific); `category` is the stepper grouping (e.g. Config/Core/Wiring,
// semantic, distinct from the folder); `critical` + `why` drive the flag + "why flagged".
export type GuideFile = {
  path: string;
  order: number;
  category: string;
  summary: string;
  critical?: boolean;
  why?: string;
};

// The guided review the coding agent attaches (the desk renders it, runs no model).
// Absent on a ReviewState → no guide surfaces render and the desk works as today.
export type Guide = {
  overview: string;
  prDescription?: string;
  files: GuideFile[];
  // baseDiffHash the guide was generated against — set on attach; used (in a later
  // slice) to flag the guide as possibly stale once the diff advances past it.
  baseDiffHash?: string;
};

export type ReviewState = {
  id: string;
  // Stable identity of the review: repo + session (branch by default).
  session: string;
  root: string;
  repoHash: string;
  // How this review was built — drives staging semantics, result wording, and
  // how `reload` rebuilds the diff.
  mode: ReviewMode;
  // Rebuild params: file path (file mode) or branch/ref (pr mode), and the pr base.
  target?: string;
  base?: string;
  staged: boolean;
  head: string | null;
  // Hash of the raw diff this review was built against (staleness metadata).
  baseDiffHash: string;
  createdAt: string;
  updatedAt?: string;
  rawDiff: string;
  files: ReviewFile[];
  comments: ReviewComment[];
  changes: ChangeState[];
  reviewedFiles: string[];
  stagedFiles: string[];
  stagedChangeKeys?: string[];
  decisionFiles?: string[];
  // Explicit accept/reject records — the source of truth for decisions.
  decisions?: Decision[];
  // Agent-generated guided review (overview + per-file summaries/order/category).
  // Optional: absent → no guide surfaces render.
  guide?: Guide;
  persistFile?: string;
};

// The structured payload printed to stdout (and written to result.json) when
// the reviewer clicks "Send to agent". This is the handoff contract.
export type ReviewResult = {
  session: string;
  repoRoot: string;
  mode: ReviewMode;
  target?: string;
  base?: string;
  staged: boolean;
  head: string | null;
  baseDiffHash: string;
  summaryMarkdown: string;
  accepted: Array<{ path: string; lineNumber: number; side: string; title: string }>;
  rejected: Array<{ path: string; lineNumber: number; side: string; title: string }>;
  requestedChanges: Array<{ path: string; lineNumber: number; side: string; body: string }>;
  stagedFiles: string[];
  artifacts: { resultJson: string; summaryMd: string; sessionDir: string };
};

// A question the reviewer asked (intent "question") that the agent should answer now.
export type QuestionPayload = {
  path: string;
  lineNumber: number;
  side: "additions" | "deletions";
  body: string;
  mode: ReviewMode;
  session: string;
};

// What `galley await` yields — a tagged event stream. The agent loops and branches:
// "question" → answer it now with `galley comment`; "review" → act on the Send.
export type AwaitEvent =
  | { kind: "review"; result: ReviewResult }
  | { kind: "question"; question: QuestionPayload };
