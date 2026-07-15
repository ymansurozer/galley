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
  // Exact text of the anchored line at creation time. Lets reload re-anchor the thread
  // when the agent's edits shift the line (see reanchorComments).
  anchorText?: string;
  // Set by re-anchoring when the anchor can't be recovered (line gone or ambiguous);
  // the desk shows these threads in a file-level strip instead of on a diff row.
  unanchored?: boolean;
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
  // Where this block sits in the RENDERED (decision-replayed) diff — @pierre renumbers
  // lines on every resolution, so these drift from lineNumber/endLine (the raw file
  // lines, which stay canonical). Derived per render (syncDisplayAnchors), never trusted
  // from persisted state.
  displayLineNumber?: number;
  displayEndLine?: number;
  // Server-stamped when a guide's skimBlocks span resolves to this block: the desk
  // collapses it by default (display-only — decisions/approval are untouched). Re-derived
  // on every attach/reload from the guide (like stageable/contentHash), so it is NOT
  // reviewer-owned and never rides /api/save; a rewritten block loses the id it was
  // stamped under and the skim drops. `reason` is the agent's short note ("import-only").
  skim?: { reason?: string };
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
  // Hash of the new-side contents — used to invalidate a file's approval when its
  // content changes between turns (see reviewedFileHashes / mergeReviewState).
  contentHash: string;
};

export type ReviewMode = "repo" | "file" | "pr";

// A per-file entry in an agent-generated guided review. `order` drives Next/Prev
// (general → specific); `category` is the stepper grouping (e.g. Config/Core/Wiring,
// semantic, distinct from the folder); `orientation` is the lens to read the file with
// (role, problem, what to expect — not a changelog); `flag`, when present, raises the
// flag for closer scrutiny and is its note. (Its presence is the flag — no separate bool.)
export type GuideFile = {
  path: string;
  order: number;
  category: string;
  orientation: string;
  flag?: string;
  // Focused-review skimming (agent-supplied, for "show me only the major changes"). The
  // desk collapses skimmed parts by default but never removes them — the reviewer can
  // always expand. Display-only: decisions, approval, and blockers are untouched. `skim`
  // (with an optional `skimReason` like "generated"/"lockfile churn") collapses the WHOLE
  // file; `skimBlocks` addresses new-file-side line spans the agent read, each resolved by
  // the server to the enclosing change block(s). skim LOWERS attention — the opposite of
  // `flag`, which raises it.
  skim?: boolean;
  skimReason?: string;
  skimBlocks?: Array<{ lines: [number, number]; reason?: string }>;
  // Guide-declared move (issue 03): the OLD path a moved-and-edited file came from — the plain-`mv`
  // case content-hash pairing (issue 02) can't catch, so the agent that made the move declares it.
  // `path` is the NEW path (as every guide field is). The desk merges the declared deletion+untracked
  // pair into one rename-changed entry (resolveMovedFrom), showing only the real edits with issue
  // 01's moved badge. Working repo mode only; mutually exclusive with skimBlocks (both resolve
  // against the diff, and a merged entry has no rawDiff section).
  movedFrom?: string;
};

// The guided review the coding agent attaches (the desk renders it, runs no model).
// Absent on a ReviewState → no guide surfaces render and the desk works as today.
export type Guide = {
  // A short agent-written title for the changeset (e.g. the PR name, or a one-line summary
  // in repo mode). Shown as the Overview heading; falls back to the target/"Review" if absent.
  title?: string;
  overview: string;
  prDescription?: string;
  files: GuideFile[];
  // A focused review (issue 04): the reviewer asked for churn to be de-emphasized, so the agent
  // shaped attention (whole-file/block skims, movedFrom merges). Display-only — the overview page
  // badges the review so the human knows churn was deliberately skimmed. A plain guide omits it.
  focused?: boolean;
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
  // Files the reviewer has finished/signed off (set by the Approve / Mark reviewed button).
  // The displayed status (approved vs changes-requested) is *derived* from objections, not
  // stored here. reviewedFileHashes records the file's contentHash at sign-off so approval
  // goes stale when the file's content changes.
  reviewedFiles: string[];
  reviewedFileHashes?: Record<string, string>;
  stagedFiles: string[];
  stagedChangeKeys?: string[];
  decisionFiles?: string[];
  // Explicit accept/reject records — the source of truth for decisions.
  decisions?: Decision[];
  // Agent-generated guided review (overview + per-file orientation/order/category).
  // Optional: absent → no guide surfaces render.
  guide?: Guide;
  persistFile?: string;
};

// The reviewer-owned slice the browser posts to /api/save. Only these fields are mutated
// from the tab; everything else on ReviewState (rawDiff, file contents, changes, guide,
// mode params, hashes) is server/agent-owned and stays authoritative on the server — so
// the save wire carries this slice instead of the whole (multi-MB) state. The server
// replaces exactly these fields (snapshot semantics, latest wins) and touches nothing else.
// decisionFiles rides along because it's reviewer-mutated and gates the per-file Reset
// button on reload; stagedFiles/stagedChangeKeys deliberately do NOT — they're maintained
// server-side by /api/stage, /api/unstage, and syncGitState.
export type ReviewerSave = Pick<
  ReviewState,
  "decisions" | "comments" | "reviewedFiles" | "reviewedFileHashes" | "decisionFiles"
>;

// Transient desk-liveness fields injected into the /api/state response alongside
// ReviewState. Deliberately NOT on ReviewState: anything on state is persisted by
// persistReview and echoed back by the UI via /api/save, while these only describe
// the live desk process.
export type AgentActivity = { body: string; at: string };
export type DeskStatus = {
  // Latest `galley status` line, or null when none posted or stale (past the TTL).
  agentActivity: AgentActivity | null;
  // An await long-poll is parked right now — something is listening for events.
  agentListening: boolean;
  // Events emitted with no waiter parked sit in the queue undelivered; a non-zero
  // count means "asked/sent, but nothing picked it up yet".
  queuedQuestions: number;
  queuedReviews: number;
};

// One file's old/new contents, fetched on demand by the tab (GET /api/file-contents) so the
// full contents never have to ride /api/state (they still do for compatibility until issue 04
// strips them). The server resolves these from git/the working tree — never from the embedded
// copies — so the equivalence is testable before those copies are removed. The tab caches the
// payload keyed by path + the file's contentHash (which changes on reload, invalidating naturally).
export type FileContentsPayload = {
  path: string;
  oldContents: string;
  newContents: string;
};

// The tab's 1.5s heartbeat (GET /api/poll): just enough to detect change. The full
// ReviewState carries the contents of every file in the diff — tens to hundreds of MB
// on a big desk — so it must never ride the poll; the tab fetches /api/state exactly
// once per baseDiffHash change and diffs guide/comments off this slice in between.
// DeskStatus is merged into the response alongside these fields.
export type PollPayload = Pick<ReviewState, "baseDiffHash" | "guide" | "comments">;

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
  accepted: Array<{ path: string; lineNumber: number; side: string; title: string }>;
  rejected: Array<{ path: string; lineNumber: number; side: string; title: string }>;
  requestedChanges: Array<{ path: string; lineNumber: number; side: string; body: string }>;
  // An optional note the reviewer attached at Send time about the whole review — an overall
  // remark, or an afterthought instruction for what to do after applying it. Ephemeral: captured
  // per Send, never persisted into ReviewState, so a one-off instruction can't silently re-send.
  overallNote?: string;
  stagedFiles: string[];
  // Files the reviewer signed off as-is (no rejected hunks, no open requested-change
  // comments, approval still current): the agent should leave these unchanged.
  approvedFiles: string[];
  // Questions still unanswered when the reviewer hit Send — folded into the round so an
  // agent that missed the live await still owes an answer. Every open question comment
  // (intent "question", no later agent reply in its thread), same shape as an await
  // question. Answer each via `galley comment`; answering stays read-only — edits come
  // only from the round's requested changes.
  openQuestions: QuestionPayload[];
  artifacts: { resultJson: string; sessionDir: string };
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
  // `question` is the oldest of the batch (kept for compatibility); `questions` carries every
  // question delivered together, arrival order — a reviewer can fire several before the agent
  // comes back, so one await hands them all over. Answer each. A lone question arrives as a
  // one-element `questions`, so consumers can always read the array uniformly.
  | { kind: "question"; question: QuestionPayload; questions: QuestionPayload[] };
