import type { ReviewState, ReviewComment, ChangeState, Decision } from "../types";

export type Side = "additions" | "deletions";
export type DiffStyle = "split" | "unified";

// User preferences (persisted to localStorage), applied live. diffStyle stays separate
// (its own toolbar toggle); these are the rest of the settings panel.
export type Settings = {
  lineDiffType: "word-alt" | "word" | "char" | "none";
  diffIndicators: "bars" | "classic" | "none";
  hunkSeparators: "line-info" | "simple" | "metadata" | "line-info-basic";
  overflow: "scroll" | "wrap";
  // Row add/remove tint emphasis: full (default), subtle (faint row + stronger word
  // emphasis), off (no row tint — focus entirely on the word diff).
  lineHighlight: "full" | "subtle" | "off";
  theme: string;      // Shiki bundled dark theme — applies to the diff AND comment code
  font: string;       // key into the FONTS map
  fontSize: number;   // px
  showUnchanged: boolean;
  stageOnAccept: boolean;
};

// The line/range the action popover + composer currently target.
export type Selection = { side: Side; lineNumber: number; endLine?: number };

// ── File-tree rows (pure data the x-for template renders) ──────────────────
export type TreeBadges = { pending: boolean; comments: boolean; viewed: boolean };

export type DirRow = {
  kind: "dir";
  key: string;
  depth: number;
  name: string;
  cls: string;
  full: string;
  dirCaret: string;
  count: number;
};

export type FileRow = {
  kind: "file" | "test";
  key: string;
  depth: number;
  name: string;
  cls: string;
  path: string;
  fileIndex: number | undefined;
  testToggle: boolean;
  testKey: string;
  testCaret: string;
  badges: TreeBadges | null;
  git: "stage" | "unstage" | null;
  gitSymbol: string;
};

export type TreeRow = DirRow | FileRow;

// Internal nodes used while building the tree (not rendered directly).
export type TreeFile = { name: string; index: number | undefined; changed: boolean; path: string; tests: TreeFile[]; folded?: boolean };
export type TreeNode = { name: string; full: string; dirs: Map<string, TreeNode>; files: TreeFile[]; changed: boolean };

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
export type ChangeMeta = { type: "change"; id: string; side: Side; lineNumber: number; title: string; path: string };
export type AnnotationMeta = ThreadMeta | ChangeMeta;
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
  fileDiff: import("@pierre/diffs").FileDiffMetadata | null;
};

// ── The single reactive store ──────────────────────────────────────────────
// Data fields are the source of truth; the methods are attached in main.ts for
// the Alpine chrome to call as $store.g.* (hence optional on the data literal).
export interface Store {
  state: ReviewState;
  projectFiles: string[];
  expandedDirs: Set<string>;
  pendingStagePath: string | null;
  diffStyle: DiffStyle;
  fileIndex: number;
  awaitingAgent: boolean;
  lastBaseDiffHash: string | null;
  selected: Selection;
  composerOpen: boolean;
  popoverOpen: boolean;
  modalOpen: boolean;
  toastMsg: string;
  composerTitle: string;
  composerBody: string;
  editingCommentId: string | null;
  settings: Settings;
  settingsOpen: boolean;
  // file mode: how a markdown file is shown — "rendered" (comark/markdown-it preview,
  // comment on blocks) or "source" (@pierre/diffs raw/diff).
  fileView: "rendered" | "source";

  treeRows?: () => TreeRow[];
  selectFile?: (i: number) => void;
  toggleDir?: (full: string) => void;
  toggleTestDir?: (key: string) => void;
  gitToggle?: (path: string, action: string) => void;
  rowClick?: (r: TreeRow) => void;
  openComposer?: () => void;
  setStyle?: (style: DiffStyle) => void;
  setFileView?: (view: "rendered" | "source") => void;
  isMarkdownFile?: () => boolean;
  applySettings?: () => void;
  openSettings?: () => void;
  closeSettings?: () => void;
  saveComment?: () => void;
  ask?: () => void;
  requestChange?: () => void;
  reset?: () => Promise<void>;
  send?: () => Promise<void>;
  cancelStage?: () => void;
  confirmStage?: () => Promise<void>;
}

export type { ReviewState, ReviewComment, ChangeState, Decision };
