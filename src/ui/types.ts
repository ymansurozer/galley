import type {
  ReviewState,
  ReviewComment,
  ChangeState,
  Decision,
  DeskStatus,
  FileContentsPayload,
  GuideFile,
  PollPayload,
  ReviewFile,
  ReviewerSave,
} from "../types";
import type { WalkRow } from "./walkthrough";

export type Side = "additions" | "deletions";
export type DiffStyle = "split" | "unified";

// User preferences (persisted to ~/.galley/settings.json via /api/settings), applied live.
// diffStyle stays separate (its own toolbar toggle); these are the rest of the settings panel.
export type Settings = {
  lineDiffType: "word-alt" | "word" | "char" | "none";
  diffIndicators: "bars" | "classic" | "none";
  hunkSeparators: "line-info" | "simple" | "metadata" | "line-info-basic";
  overflow: "scroll" | "wrap";
  // Row add/remove tint emphasis: full (default), subtle (faint row + stronger word
  // emphasis), off (no row tint — focus entirely on the word diff).
  lineHighlight: "full" | "subtle" | "off";
  theme: string; // Shiki bundled dark theme — applies to the diff AND comment code
  font: string; // key into the FONTS map — code font (diff + comment/markdown code)
  uiFont: string; // key into the SANS_FONTS map — UI chrome font (non-code)
  fontSize: number; // px — code font size (diff + comment code)
  showUnchanged: boolean;
  // Diff view: "collapse" (default) folds long unchanged runs into a "N unmodified lines"
  // separator; "expand" renders every line (mapped to @pierre's expandUnchanged flag).
  unchangedLines: "collapse" | "expand";
  // How guided-review progress is weighted: "lines" (changed lines per file — finishing a
  // bigger change advances more) or "files" (every file counts the same).
  progressBy: "lines" | "files";
  // Which sidebar pane a guided desk opens with; `w` toggles per-session from there.
  sidebarDefault: "tree" | "walkthrough";
  // Default view for a markdown file: "auto" (new/unchanged → rendered, changed → source so the
  // diff shows first), or force "rendered"/"source". The toolbar toggle still overrides per file.
  markdownView: "auto" | "rendered" | "source";
  stageOnAccept: boolean;
  // Command template for "Open in editor" ({repo}/{file}/{line} placeholders). A machine
  // preference like the rest — empty falls back to the OS opener (see src/editor.ts).
  editorCommand: string;
};

// A previewed file (opened from the project tree via /api/file to read/comment on an unchanged
// file) is a UI-only construct: it never rides the wire or persistence, so it carries its single
// contents inline (old === new, no diff) rather than through the on-demand /api/file-contents
// fetch that lean ReviewFiles use. contents.ts reads previewContents for it; everything else
// treats it as an ordinary (zero-hunk) ReviewFile.
export type PreviewFile = ReviewFile & { previewContents: string };

// The line/range the action popover + composer currently target. These are DISPLAY
// coordinates (the rendered diff's gutter numbers, which drift from real file lines once
// decisions are replayed) — convert via D.lineMap before persisting (see submitComment).
export type Selection = { side: Side; lineNumber: number; endLine?: number };

// ── File-tree rows (pure data the x-for template renders) ──────────────────
export type FileReviewState = "pending" | "approved" | "changes-requested";

export type DirRow = {
  kind: "dir";
  key: string;
  depth: number;
  name: string;
  cls: string;
  // Inline `--depth:N` custom property — .node derives padding + indent guides from it.
  style: string;
  full: string;
  dirCaret: string;
  open: boolean;
  changed: boolean;
};

export type FileRow = {
  kind: "file" | "test";
  key: string;
  depth: number;
  name: string;
  cls: string;
  style: string;
  path: string;
  fileIndex: number | undefined;
  testToggle: boolean;
  testKey: string;
  testCaret: string;
  changeType: "new" | "modified" | "deleted" | null;
  // Single review-state badge (null = unchanged file / showing the test caret instead).
  state: FileReviewState | null;
  // The guide marked this whole file skimmable — a muted indicator, not a state shout.
  skim: boolean;
  // Pure rename (issue 01): the old path, shown as a "← old" arrow in the Skimmed group.
  movedFrom?: string;
};

// The collapsed "Skimmed · N files" group header at the bottom of the tree (issue 07). Fully-
// skimmed files leave the main listing and gather under it; clicking toggles per-session expand,
// and its member FileRows follow only while `open`.
export type SkimGroupRow = {
  kind: "skimgrp";
  key: string;
  count: number;
  open: boolean;
  caret: string;
};

export type TreeRow = DirRow | FileRow | SkimGroupRow;

// Internal nodes used while building the tree (not rendered directly).
export type TreeFile = {
  name: string;
  index: number | undefined;
  changed: boolean;
  path: string;
  tests: TreeFile[];
  folded?: boolean;
};
export type TreeNode = {
  name: string;
  full: string;
  dirs: Map<string, TreeNode>;
  files: TreeFile[];
  changed: boolean;
};

// ── Diff annotations (our payload handed to @pierre/diffs' renderAnnotation) ─
export type ThreadMeta = {
  type: "thread";
  path: string;
  side: Side;
  lineNumber: number;
  status: "open" | "resolved";
  comments: ReviewComment[];
  changeId?: string;
};
export type ChangeMeta = {
  type: "change";
  id: string;
  side: Side;
  lineNumber: number;
  title: string;
  path: string;
};
// An inline composer slot injected on the fly for a new line comment (reply/edit render
// inside the thread, not as their own annotation). lineNumber is the display line the
// composer anchors under — it re-derives from S.selected on every render, so it tracks
// the selection across decision replays like any other annotation.
export type ComposerMeta = {
  type: "composer";
  side: Side;
  lineNumber: number;
  path: string;
};
// The collapse/expand strip standing in for a skimmed change block. Anchored at the block's
// last display line (like the change bar); when collapsed, skim.ts hides the block's rows so
// the strip is all that shows. `collapsed` flips the caret/label and whether rows are hidden.
export type SkimMeta = {
  type: "skim";
  id: string;
  side: Side;
  lineNumber: number;
  label: string;
  collapsed: boolean;
};
export type AnnotationMeta = ThreadMeta | ChangeMeta | ComposerMeta | SkimMeta;
export type AnnotationInput = { side: Side; lineNumber: number; metadata: AnnotationMeta };

// ── @pierre/diffs imperative island ────────────────────────────────────────
type Pierre = typeof import("@pierre/diffs");
// The diff lib's classes/instance/parsed-diff are kept OUT of the reactive store
// (an Alpine Proxy breaks the library's element-identity checks). Plain holder.
// The three refs are wired once at import (difflib.ts) and never read before that,
// so they're non-null; the parsed `fileDiff` and rendered `instance` come and go.
export type DiffHolder = {
  FileDiff: Pierre["FileDiff"];
  parseDiffFromFile: Pierre["parseDiffFromFile"];
  diffAcceptRejectHunk: Pierre["diffAcceptRejectHunk"];
  // FileDiff is generic over its annotation metadata — ours is AnnotationMeta.
  instance: import("@pierre/diffs").FileDiff<AnnotationMeta> | null;
  // LRU of rendered diffs keyed by file + view options (see diffKey). Each instance lives in
  // its own wrapper element; only the active wrapper is mounted in #diff, the rest stay
  // detached (held here) with their DOM + @pierre highlight cache intact — so re-opening a
  // visited file re-mounts instantly without re-tokenizing.
  diffCache: Map<
    string,
    { wrapper: HTMLElement; inst: import("@pierre/diffs").FileDiff<AnnotationMeta> }
  >;
  fileDiff: import("@pierre/diffs").FileDiffMetadata | null;
  // Raw ↔ display line mapping for the current file's rendered (replayed) diff.
  // Rebuilt by replayDecisions on every render; null = identity (no decisions / view-only).
  lineMap: import("./linemap").LineMap | null;
};

// ── The single reactive store ──────────────────────────────────────────────
// Data fields are the source of truth; the methods are attached in main.ts for
// the Alpine chrome to call as $store.g.* (hence optional on the data literal).
export interface Store {
  state: ReviewState;
  projectFiles: string[];
  expandedDirs: Set<string>;
  collapsedDirs: Set<string>;
  diffStyle: DiffStyle;
  fileIndex: number;
  // A non-review file (e.g. an unchanged file) the reviewer opened to read/comment on.
  // When set, it's the "current file" instead of state.files[fileIndex].
  preview: PreviewFile | null;
  // True while a (non-cached) diff render is in flight — drives the "Rendering…" indicator.
  rendering: boolean;
  awaitingAgent: boolean;
  // Transient desk-liveness from /api/state (DeskStatus fields). Held OUTSIDE
  // S.state so they never ride a /api/save round-trip into the persisted review.
  agentActivity: string | null;
  agentListening: boolean;
  queuedQuestions: number;
  queuedReviews: number;
  lastBaseDiffHash: string | null;
  selected: Selection;
  // An inline composer (new / reply / edit) is open. Exactly one at a time; the composer's
  // text lives in composerBody so it survives the diff DOM rebuild (see composer.ts).
  composerOpen: boolean;
  toastMsg: string;
  // Pending "go to line" digits typed in the diff ("" = inactive). Drives the goline pill;
  // ↵ / idle timeout commits the jump, Esc cancels (see cursor.ts goline section).
  golineBuffer: string;
  composerBody: string;
  editingCommentId: string | null;
  settings: Settings;
  settingsOpen: boolean;
  // Which tab the settings modal shows ("shortcuts" = the keyboard map). A small confirm dialog
  // backs the destructive shortcuts (⇧R / ⇧S); confirmMsg is the prompt text, "" when closed.
  settingsTab: "settings" | "shortcuts";
  confirmMsg: string;
  // The Send modal (⇧S / Send button): a receipt (sendMsg) plus an optional overall note the
  // reviewer types for the agent. sendOpen toggles it; sendNote is ephemeral (cleared each open,
  // never persisted). ⌘↵ sends, Enter is a newline, Esc cancels.
  sendOpen: boolean;
  sendMsg: string;
  sendNote: string;
  // Guided review: when true (and a guide is attached) the center shows the Overview page
  // instead of the diff. Selecting any file (tree or Start) drops back to the diff.
  overviewOpen: boolean;
  // Which sidebar pane is showing when a guide is attached (no guide → tabs hidden, tree
  // only). Per-session like overviewOpen; settings.sidebarDefault seeds it at init.
  sidebarTab: "tree" | "walkthrough";
  // Narrow widths (≤1100px): the file tree is an off-canvas left drawer, hidden by default so
  // the diff owns the screen. Toggled by the header hamburger / ⇧B; auto-closed on file select.
  // Inert on desktop — the drawer styles are media-gated, so the tree stays side-by-side there.
  treeDrawerOpen: boolean;
  // file mode: how a markdown file is shown — "rendered" (comark/markdown-it preview,
  // comment on blocks) or "source" (@pierre/diffs raw/diff).
  fileView: "rendered" | "source";
  // True once the diff pane is scrolled past its header — reveals the floating Approve button
  // so sign-off is reachable without scrolling back up to the header. Reset on every file switch.
  diffScrolled: boolean;
  // Per-session skim expand state: change ids (block-level) and `file:<path>` keys (file-level)
  // the reviewer expanded. Not persisted — collapse is display-only and resets each session.
  skimExpanded: Set<string>;

  treeRows?: () => TreeRow[];
  selectFile?: (i: number) => void;
  previewFile?: (path: string) => void;
  toggleDir?: (full: string, changed: boolean) => void;
  toggleAllDirs?: () => void;
  treeAnyOpen?: () => boolean;
  toggleTestDir?: (key: string) => void;
  toggleSkimGroup?: () => void;
  rowClick?: (r: TreeRow) => void;
  setStyle?: (style: DiffStyle) => void;
  setFileView?: (view: "rendered" | "source") => void;
  isMarkdownFile?: () => boolean;
  // Sign off on the current file from the floating button (same action as the header ⇧A).
  approveFile?: () => void;
  // Drives the floating Approve button: null hides it (overview, preview, or finished file),
  // else the pending file's sign-off flavor — "clean" (Approve) or "changes" (Mark Reviewed).
  fabState?: () => "clean" | "changes" | null;
  splitApplies?: () => boolean;
  applySettings?: () => void;
  openInEditor?: () => Promise<void>;
  openSettings?: () => void;
  closeSettings?: () => void;
  hasGuide?: () => boolean;
  guideStale?: () => boolean;
  openOverview?: () => void;
  startGuided?: () => void;
  showGuideBar?: () => boolean;
  curGuide?: () => GuideFile | null;
  curFileName?: () => string;
  guideNext?: () => void;
  guidePrev?: () => void;
  guideAtStart?: () => boolean;
  guideAtLast?: () => boolean;
  walkthroughRows?: () => WalkRow[];
  saveComment?: () => void;
  ask?: () => void;
  requestChange?: () => void;
  reset?: () => Promise<void>;
  send?: (overallNote?: string) => Promise<void>;
  // Keyboard navigation (keys.ts): file stepping in either mode, confirm-dialog answers, and the
  // grouped binding list the help overlay renders.
  nextFile?: () => void;
  prevFile?: () => void;
  treeStep?: (dir: 1 | -1) => void;
  confirmYes?: () => void;
  confirmNo?: () => void;
  promptFinish?: () => void;
  confirmSend?: () => void;
  sendConfirm?: () => void;
  sendCancel?: () => void;
  helpGroups?: () => { group: string; items: { combo: string; desc: string }[] }[];
}

export type {
  ReviewState,
  ReviewComment,
  ChangeState,
  Decision,
  DeskStatus,
  FileContentsPayload,
  GuideFile,
  PollPayload,
  ReviewerSave,
};
