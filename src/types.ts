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
  intent?: "note" | "action";
  // "user" comments are the reviewer's; "agent" comments are replies posted
  // back by the coding agent via `galley comment` between sessions.
  role?: "user" | "agent";
};

export type ChangeState = {
  id: string;
  path: string;
  hunkIndex: number;
  side: "additions" | "deletions";
  lineNumber: number;
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

export type ReviewFile = DiffFile & {
  path: string;
  oldFile: { name: string; contents: string };
  newFile: { name: string; contents: string };
};

export type ReviewMode = "repo" | "file" | "pr";

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
