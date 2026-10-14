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
  // Set when the reviewer turns a change request into a question: it counts as asked then, so an
  // agent reply from before (to the change request) doesn't answer it. Absent, it was asked at
  // createdAt. Every "answered" check reads `askedAt ?? createdAt`.
  askedAt?: string;
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

// One message in a review thread. A code comment is one, and so is each entry of a UI annotation's
// thread, so a single thread component renders both lanes.
export type ThreadMessage = Pick<
  ReviewComment,
  "id" | "body" | "createdAt" | "updatedAt" | "intent" | "askedAt" | "role"
>;

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
  // Server-stamped when a guide part (GuideFile.part) claims this block: the index of the owning
  // entry in the stored, order-sorted guide.files. Absent = no part claims it (the file's Rest
  // step). Resolved from the guide's spans on attach, then carried by content across every reload
  // or restart that keeps the guide (state.ts carryParts). Never rides /api/save.
  part?: number;
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
  // Git blob OID of the new-side contents — the file-level staleness key. Changes iff the
  // content changes, so a file's approval invalidates when its content changes between turns
  // (see reviewedFileHashes / mergeReviewState). Harvested from `git diff --raw` for a committed
  // new side; hashed locally (blobOid) for a working-tree side. NOT the block-level key:
  // ChangeState.contentHash stays a content-slice hash (a diff block is not a git object).
  contentHash: string;
  // Lean metadata stamped by the builder (issue 04) so file contents never ride the state — the
  // tab fetches them per file via GET /api/file-contents. Derived from the diff structure + the
  // bytes read to hash a working side; never require re-reading a committed blob.
  //
  // Change class, from the diff's paths (no contents): added (--- /dev/null), deleted (+++
  // /dev/null), renamed (distinct old/new paths), else modified.
  changeKind?: "added" | "modified" | "deleted" | "renamed";
  // +added / −removed line counts. From the parsed hunks; a hunk-less full-file add counts its
  // whole content as additions (matching what the UI used to derive from the embedded contents).
  added?: number;
  removed?: number;
  // A byte-identical move (distinct paths, unchanged content): git-native zero-hunk rename or a
  // plain-`mv` untracked pair. A guide-declared movedFrom merge is a rename-CHANGED file and is
  // NOT pure. Drives the UI's muted "renamed · no changes" row / skim-group fold without contents.
  renamePure?: boolean;
  // New-side byte size, stamped ONLY in working/file mode (free from the bytes read to hash the
  // working copy). OMITTED for committed new sides (pr/staged) — sizes aren't in `git diff --raw`
  // and a batched lookup wasn't worth a slice dominated by deletion. Issue 05's oversized-file
  // threshold falls back to diff-text length + changed-line counts where size is absent.
  size?: number;
  // Set (issue 05) when this file's diff is big enough to freeze the tab if rendered — the UI shows
  // a verdict-capable summary card instead of the diff (with a "Load diff anyway" escape hatch).
  // Stamped by the builder from the diff alone (text length + changed lines, plus `size` where it's
  // present); see isOversized in state.ts. Omitted (not `false`) on ordinary files, so the state
  // stays lean and the UI reads it as a plain truthiness check.
  oversized?: boolean;
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
  // Required (non-empty) unless `skim: true`: a whole-file skim leaves the review flow, so
  // its entry normally omits the lens and `skimReason` says why. Never present-but-blank.
  orientation?: string;
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
  // Splits a file's diff into review steps: the same path listed once per part, each entry with
  // its own category/orientation/flag. `lines` are new-file-side spans ([start, end] or a single
  // line), resolved like skimBlocks to the change blocks they touch when the guide is attached
  // (resolveParts stamps ChangeState.part); a reload that keeps the guide carries each block's
  // part by content instead. A split file is split all the way — every entry for the path carries a
  // part — and a part never combines with a whole-file `skim` or `movedFrom`. Blocks no part
  // claims form the file's "Rest" step.
  part?: { title: string; lines: Array<[number, number] | number> };
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
  // What the desk's header and tab title name. project is the MAIN worktree's folder, so a desk in
  // a linked worktree (whose root is the worktree folder) still names the real project; a file
  // outside any repo names its folder. branch is the checked-out branch, absent on a detached HEAD.
  // Recomputed on every build — a reload/restart takes the rebuild's, never a saved review's.
  // Optional because reviews saved by older versions lack both.
  project?: string;
  branch?: string;
  repoHash: string;
  // How this review was built — drives staging semantics, result wording, and
  // how `reload` rebuilds the diff.
  mode: ReviewMode;
  // Rebuild params: file path (file mode) or branch/ref (pr mode), and the pr base.
  target?: string;
  base?: string;
  staged: boolean;
  head: string | null;
  // Hash of the diff this review was built against: the raw diff plus every review file it doesn't
  // name, untracked ones included (baseDiffHashOf). Staleness metadata — the tab and guide compare it.
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
  // Change blocks the reviewer signed off, `path:stableKey` → the block's contentHash at sign-off:
  // a guide part (or Rest) is done while each of its blocks has a current entry. Once every block
  // of a file has one, the file's own sign-off above is written too, so approval and the agent's
  // ReviewResult stay file-level.
  signedOffBlocks?: Record<string, string>;
  stagedFiles: string[];
  stagedChangeKeys?: string[];
  decisionFiles?: string[];
  // Explicit accept/reject records — the source of truth for decisions.
  decisions?: Decision[];
  // Agent-generated guided review (overview + per-file orientation/order/category).
  // Optional: absent → no guide surfaces render.
  guide?: Guide;
  // The running app under review (`--ui <url>` / `galley ui <url>`): a loopback http:// URL the
  // desk reverse-proxies into its UI view. Agent-owned like `target` — set by the CLI, carried
  // across reload/restart by mergeReviewState, never posted back by the tab. Absent → no UI lane.
  ui?: { target: string };
  // The reviewer's annotations on the running app (the UI lane). A separate array from `comments`,
  // so the code-comment model (path/side/line, re-anchoring) never sees them. Absent on reviews
  // saved before the UI lane existed.
  annotations?: UiAnnotationRecord[];
  // The highest number ever given to an annotation, deleted ones included, so a number is never
  // reused: the agent never meets two different #3s. Only a review reset starts it over.
  lastAnnotationNumber?: number;
  persistFile?: string;
};

// The reviewer-owned slice the browser posts to /api/save. Only these fields are mutated
// from the tab; everything else on ReviewState (rawDiff, file contents, changes, guide,
// mode params, hashes) is server/agent-owned and stays authoritative on the server — so
// the save wire carries this slice instead of the whole (multi-MB) state. The server
// replaces exactly these fields (snapshot semantics, latest wins) and touches nothing else.
// decisionFiles rides along because it's reviewer-mutated and gates the per-file Reset
// button on reload; stagedFiles/stagedChangeKeys deliberately do NOT — they're maintained
// server-side by /api/stage, /api/unstage, /api/restage, and syncGitState.
export type ReviewerSave = Pick<
  ReviewState,
  | "decisions"
  | "comments"
  | "reviewedFiles"
  | "reviewedFileHashes"
  | "signedOffBlocks"
  | "decisionFiles"
  | "annotations"
  | "lastAnnotationNumber"
>;

// A path's index entry as /api/unstage found it (a file's Reset), handed back to /api/restage by
// the Reset's Undo so it puts back exactly what was staged. null: the index had no entry (a staged
// deletion). Absent from the unstage response: a conflicted path, which Undo can't restore.
export type IndexEntry = { mode: string; oid: string } | null;

// What the tab had adopted of the desk when it saved (DeskStatus): the desk process, by its UI
// token (null while no proxy runs), and that process's `galley reload` count. Rides every save and
// Send beside the slice. A save stamped with anything else was made before the latest reload or
// restart, which reset every annotation's placement, so the desk keeps its own placements.
// `baseDiffHash` is the diff the tab's state was built on, which its decisions are keyed to; the
// desk carries a save made on an older diff onto its own (mergeReviewerSave). The desk's own stamp
// leaves it out, as does a tab from before it existed.
export type SaveStamp = { token: string | null; reloadGeneration: number; baseDiffHash?: string };

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
  // The UI proxy serving `ui.target`, once one is running: its port (the tab builds the iframe URL
  // from its own hostname + this port) and the per-desk-process bridge token the tab and the
  // injected bridge exchange. Safe here: the desk API answers only its own origin.
  uiProxy: UiProxyInfo | null;
  // Bumped by every `galley reload` (POST /api/reload) in this desk process — the tab's signal that
  // the agent changed something, even when the diff didn't move (UI-only desks, server-only
  // edits). Process-local: a restarted desk starts again from 0 under a new uiProxy token.
  reloadGeneration: number;
};

export type UiProxyInfo = { port: number; token: string };

// postMessage traffic between the bridge (injected into every proxied HTML page) and the desk tab.
// Each side checks the other's origin and the token before acting (never "*"). The bridge only
// reports and obeys; the desk does all persistence. Page-sourced fields are re-validated and
// capped by the desk before use.
export type BridgeNav = {
  // path + query of the app page (the address-bar route).
  route: string;
  title: string;
  // Per-frame history state (Navigation API); null where the browser lacks it.
  canGoBack: boolean | null;
  canGoForward: boolean | null;
};
// A box in the app page's viewport, in CSS pixels (getBoundingClientRect's frame).
export type Rect = { x: number; y: number; width: number; height: number };
// The page as the reviewer sees it, re-rendered from the live DOM by the bridge: PNGs at the page's
// devicePixelRatio. `crop` frames the requested target plus context padding, and is null when no
// target was asked for or it lies off-screen. `ms` is the in-page cost of rendering and encoding.
export type BridgeShot = { viewport: Blob; crop: Blob | null; ms: number };
// A key the bridge passed up from the app page: ⌥A always, and ⌥P, Esc and ⇧ chords while
// annotating. The desk runs it through its own hotkey table, as if it had been pressed in the desk.
export type ForwardedKey = { key: string; code: string; shiftKey: boolean; altKey: boolean };
// Interact: the app gets every click and key. Annotate: the bridge takes the pointer, and a click
// picks the element under it, a drag a box or the text it runs over.
export type AppMode = "interact" | "annotate";
// A numbered pin the bridge draws on the current page, with its target's mark: amber for a change
// request, cyan for a question.
export type UiMark = {
  id: string;
  number: number;
  target: UiMarkTarget;
  resolved: boolean;
  question: boolean;
};
// An element as the bridge finds it again: where its source said it was rendered, the selector it
// was captured with, what it showed (tag, text, else accessible name, and its classes) to check a
// match against, and its box then. Taken from the annotation's UiElement.
export type UiMarkElement = {
  selector: string;
  tag: string;
  text?: string;
  name?: string;
  classes?: string[];
  source?: UiSource;
  rect: Rect;
};
// Where a mark goes on the page, found again from what the annotation recorded: on its elements
// (the pin on the first, all outlined while selected); a dashed box, kept where it sat relative to
// the first of its elements still on the page as that element moves (where it was drawn, without
// one); or `quote` highlighted inside its element. A page annotation has no mark on the page: the
// desk shows its pin in the address bar.
export type UiMarkTarget =
  | { kind: "element"; elements: UiMarkElement[] }
  | { kind: "region"; rect: Rect; elements: UiMarkElement[] }
  | { kind: "text"; quote: string; element: UiMarkElement };
// Whether an annotation's target was found on its page the last time that page loaded: `placed`
// (its mark is drawn there), `unplaced` (not found once the page settled, so no mark), or
// `unvisited` (its page hasn't loaded since the last `galley reload` or desk restart). An
// annotation is placed when it's made.
export type UiPlacement = "placed" | "unplaced" | "unvisited";
// What the bridge can pick on the page. A page target is the desk's own: it needs nothing from the
// page but its route.
export type PickedTarget = Exclude<UiTarget, { kind: "page" }>;
export type BridgeMessage =
  // `ready` on every page load (the handshake), `nav` on in-page route/title changes.
  | ({ type: "ready" | "nav"; token: string } & BridgeNav)
  // The page is unloading — until the next `ready`, no bridge is listening.
  | { type: "leave"; token: string }
  // The answer to the desk's `capture` with the same id.
  | ({ type: "captured"; token: string; id: number } & ({ shot: BridgeShot } | { error: string }))
  // The reviewer picked a target in Annotate mode: clicked an element (or released ⇧ after
  // ⇧-clicking several), dragged a box, or dragged over text. The desk adds the page's url.
  | { type: "picked"; token: string; page: Omit<UiPage, "url">; target: PickedTarget }
  // How many ⇧-clicked elements wait for ⇧'s release: 0 once they're picked or dropped.
  | { type: "pending"; token: string; count: number }
  // The picked target moved on screen (scroll, layout), so the composer follows it.
  | { type: "anchor"; token: string; rect: Rect }
  // The reviewer clicked an annotation's pin.
  | { type: "select"; token: string; id: string }
  // Where the page's marks were found once it settled after a load or route change, and later
  // whenever one is found or lost again: only the marks whose placement changed.
  | {
      type: "placements";
      token: string;
      placements: Array<{ id: string; placement: Exclude<UiPlacement, "unvisited"> }>;
    }
  | ({ type: "key"; token: string } & ForwardedKey);
export type DeskMessage =
  | { type: "navigate"; token: string; route: string }
  | { type: "back" | "forward" | "reload"; token: string }
  // Screenshot the page. The crop frames `target`, found as its mark would be. With `mark`, the
  // target's mark (outlines, the dashed box or the highlight) and the annotation's numbered pin are
  // drawn onto both images, in its kind's colour.
  | {
      type: "capture";
      token: string;
      id: number;
      target?: UiMarkTarget;
      mark?: { number: number; question: boolean };
    }
  | { type: "mode"; token: string; mode: AppMode }
  // Drop the ⇧-clicked elements waiting for ⇧'s release (the Esc cascade's level for them).
  | { type: "clearPicks"; token: string }
  // The desk marked every annotation unvisited: look for this page's marks again and report each
  // one's placement, changed or not.
  | { type: "relook"; token: string }
  // The pins for the current page, the selected annotation (outlined, scrolled into view once
  // found), and whether the composer is open on the last pick (its highlight stays until the
  // composer closes). The bridge looks for each new pin's target once the page settles, and reports
  // where it found them (`placements`).
  | { type: "marks"; token: string; marks: UiMark[]; selected: string | null; picking: boolean };

// ── UI annotations ──────────────────────────────────────────────────────────────────────────────
// An element the reviewer pointed at in the app, as the bridge captured it. Everything in it is
// page-sourced: the bridge caps it, and the tab and the server validate it again before storing it.
export type UiElement = {
  // Matched exactly this element when captured: #id, else identity attributes (data-testid,
  // aria-label, …), else word-like classes, else an nth-of-type path. Each rung is proven unique.
  selector: string;
  tag: string;
  // Visible text, whitespace collapsed.
  text?: string;
  // Explicit or implicit ARIA role, and the accessible name.
  role?: string;
  name?: string;
  // Allowlisted attributes (data-testid, href, type, …).
  attrs?: Record<string, string>;
  // The nearest landmark (e.g. `navigation "Main"`) and the nearest heading above the element.
  landmark?: string;
  heading?: string;
  // A short HTML outline of the element and its first children.
  outline?: string;
  // Its box in the page's viewport when captured.
  rect: Rect;
  // The source that rendered it, when a framework resolver could tell (Vue/Nuxt dev builds only).
  source?: UiSource;
};
// Where an element came from. `vue-tracer`: the exact template position (line and 1-based column,
// from vite-plugin-vue-tracer, which Nuxt DevTools installs). `vue-file`: the owning component's
// file and name only. `vendor`: the element was rendered inside a library component (under
// node_modules), and the position is the nearest app-owned one — where the library component is
// used. The bridge sends the path it was given (often absolute); the Send makes it repo-relative
// when it lies inside the repo, and leaves it out otherwise (UiSentElement).
export type UiSource = {
  file: string;
  line?: number;
  column?: number;
  component?: string;
  vendor?: boolean;
  via: "vue-tracer" | "vue-file";
};
export type UiPage = {
  // The page on the dev server (the UI target's origin + route), not on the proxy.
  url: string;
  // Path + query, as in the address bar. The sidebar groups annotations by it.
  route: string;
  title?: string;
  viewport: { width: number; height: number; dpr: number };
};
// What an annotation points at. The agent receives its elements as UiSentElement.
export type UiTarget<E = UiElement> =
  // 1–16 elements: a click, or ⇧-clicks gathered until ⇧ is released.
  | { kind: "element"; elements: E[] }
  // A dragged box (in the viewport, like an element's rect) over anything, canvas or empty space
  // included, and the meaningful elements wholly inside it: controls, landmarks, headings, media
  // and elements with text of their own, outermost first, 0–16. Best effort.
  | { kind: "region"; rect: Rect; elements: E[] }
  // Text dragged over: the quote, whitespace collapsed, and the element holding all of it, as a
  // click on it would pick it.
  | { kind: "text"; quote: string; element: E }
  // The page itself (its route), with nothing on it singled out.
  | { kind: "page" };
// An element as the agent receives it: its source's file repo-relative, and no file, line or
// column when the file the page named lies outside the repo. The path is page-sourced, and the
// agent opens what it's handed.
export type UiSentElement = Omit<UiElement, "source"> & {
  source?: Omit<UiSource, "file" | "line" | "column"> &
    Partial<Pick<UiSource, "file" | "line" | "column">>;
};
// Caps on page-sourced data: string lengths, and the attrs and elements counts. The bridge, the tab
// and the server each keep a runtime copy typed as UiCaps (the worlds share no runtime code), so a
// copy that drifts fails the typecheck. `name` also caps role, landmark, heading and a source's
// component, and `elements` a target's elements. A selector or a source file over its cap is
// refused rather than cut: cut short, it points at something else. `shot` caps each screenshot
// PNG's bytes, wherever it's rendered, carried or stored: 32 MiB, enough for a 3840 × 2160
// device-pixel viewport even as raw RGBA (31.6 MiB).
export type UiCaps = {
  selector: 512;
  file: 1024;
  text: 300;
  name: 200;
  outline: 2048;
  attrs: 12;
  attr: 200;
  url: 2048;
  route: 2048;
  title: 300;
  quote: 500;
  elements: 16;
  shot: 33_554_432;
};
// An annotation as the desk keeps it. Its body is the opening message of `comments`, which the
// code lane's thread component renders; later messages are replies.
export type UiAnnotationRecord = {
  id: string;
  // Global and never reused; the number on its pin.
  number: number;
  // What the opening message asked for, and so what the annotation is: a change request (sent in
  // uiAnnotations) or a question (asked live; in openQuestions while unanswered). Replies never
  // change it, but a question whose thread has a Request change reply is sent in uiAnnotations too.
  // Turning the opening message into the other kind turns this with it, so the two always agree.
  intent: "change" | "question";
  status: "open" | "resolved";
  // Whether its target was found on its page the last time that page loaded, as the bridge reported.
  placement: UiPlacement;
  page: UiPage;
  target: UiTarget;
  comments: ThreadMessage[];
  // Both screenshots (crop and viewport) are stored, as PNGs in the session directory's ui-shots/
  // (uishots.ts), never in the state. Server-owned: set by the upload that completes the pair,
  // carried by id through every reviewer save, and never taken from the tab.
  screenshots?: true;
};
// An annotation as the agent receives it in ReviewResult.uiAnnotations.
export type UiAnnotation = {
  id: string;
  number: number;
  body: string;
  status: UiAnnotationRecord["status"];
  placement: UiAnnotationRecord["placement"];
  page: UiPage;
  target: UiTarget<UiSentElement>;
  // Absolute paths to the PNGs, with the annotation's mark drawn on. `exact` is false: the bridge
  // re-renders the DOM rather than reading the screen's pixels. Absent when capture failed, or when
  // either file is no longer on disk at Send.
  screenshots?: { crop: string; viewport: string; exact: boolean };
  thread: Array<{ role: "user" | "agent"; body: string; at: string }>;
};

// One file's old/new contents, fetched on demand by the tab (GET /api/file-contents) so the full
// contents never ride /api/state — the state itself is lean (issue 04 removed the embedded copies).
// The server resolves these from git/the working tree. The tab caches the payload keyed by path +
// the file's contentHash (which changes on reload, invalidating naturally). oldOid/newOid are the
// blob OIDs of each side (newOid === the file's contentHash); carried for a future client-side
// content cache, unused by the tab today.
export type FileContentsPayload = {
  path: string;
  oldContents: string;
  newContents: string;
  oldOid: string;
  newOid: string;
};

// The tab's 1.5s heartbeat (GET /api/poll): just enough to detect change. Even lean, the full
// ReviewState (hunks + rawDiff for every file) is far heavier than a heartbeat needs, so it must
// never ride the poll; the tab fetches /api/state exactly once per baseDiffHash change and diffs
// guide/comments off this slice in between. DeskStatus is merged into the response alongside these.
// `ui` rides along so `galley ui` on a live desk reaches the open tab without a diff change.
export type PollPayload = Pick<
  ReviewState,
  "baseDiffHash" | "guide" | "comments" | "ui" | "annotations" | "project" | "branch"
>;

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
  codeChangeRequests: Array<{ path: string; lineNumber: number; side: string; body: string }>;
  // The open change requests on the running app (resolved ones are not sent), and the app URL the
  // desk serves (each annotation records its own page.url). Without a UI target: empty, no uiTarget.
  uiAnnotations: UiAnnotation[];
  uiTarget?: string;
  // An optional note the reviewer attached at Send time about the whole review — an overall
  // remark, or an afterthought instruction for what to do after applying it. Ephemeral: captured
  // per Send, never persisted into ReviewState, so a one-off instruction can't silently re-send.
  overallNote?: string;
  stagedFiles: string[];
  // Files the reviewer signed off as-is (no rejected hunks, no open requested-change
  // comments, approval still current): the agent should leave these unchanged.
  approvedFiles: string[];
  // Questions still unanswered when the reviewer hit Send — folded into the round so an
  // agent that missed the live await still owes an answer. Every open question message
  // (intent "question", no later agent reply in its thread), code comments and UI annotation
  // threads alike, same shape as an await question. Answer each via `galley comment`;
  // answering stays read-only — edits come only from the round's requested changes.
  openQuestions: QuestionPayload[];
  artifacts: { resultJson: string; sessionDir: string };
};

// A question the reviewer asked (intent "question") that the agent should answer now: on a line
// of the diff (lane "code"), or in a UI annotation's thread (lane "ui").
export type QuestionPayload = CodeQuestion | UiQuestion;
export type CodeQuestion = {
  lane: "code";
  path: string;
  lineNumber: number;
  side: "additions" | "deletions";
  body: string;
  mode: ReviewMode;
  session: string;
};
// Answered with `galley comment --ui <annotationId>`. `number` is the annotation's pin, `route` its
// page, and `target` a one-line summary of what it points at (a region's size, a quote, or the
// whole page; role and name, how many more elements, the source's file:line), built from
// page-sourced data.
export type UiQuestion = {
  lane: "ui";
  annotationId: string;
  number: number;
  route: string;
  body: string;
  target: string;
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
