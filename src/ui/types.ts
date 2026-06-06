import type { ReviewState, ReviewComment, ChangeState, Decision, GuideFile, ReviewFile } from "../types";
import type { CategoryStep } from "./guide";

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
  // Diff view: "collapse" (default) folds long unchanged runs into a "N unmodified lines"
  // separator; "expand" renders every line (mapped to @pierre's expandUnchanged flag).
  unchangedLines: "collapse" | "expand";
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
  open: boolean;
  changed: boolean;
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
  changeType: "new" | "modified" | "deleted" | null;
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
  collapsedDirs: Set<string>;
  pendingStagePath: string | null;
  diffStyle: DiffStyle;
  fileIndex: number;
  // A non-review file (e.g. an unchanged file) the reviewer opened to read/comment on.
  // When set, it's the "current file" instead of state.files[fileIndex].
  preview: ReviewFile | null;
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
  // Guided review: when true (and a guide is attached) the center shows the Overview page
  // instead of the diff. Selecting any file (tree or Start) drops back to the diff.
  overviewOpen: boolean;
  // file mode: how a markdown file is shown — "rendered" (comark/markdown-it preview,
  // comment on blocks) or "source" (@pierre/diffs raw/diff).
  fileView: "rendered" | "source";

  treeRows?: () => TreeRow[];
  selectFile?: (i: number) => void;
  previewFile?: (path: string) => void;
  toggleDir?: (full: string, changed: boolean) => void;
  toggleAllDirs?: () => void;
  treeAnyOpen?: () => boolean;
  toggleTestDir?: (key: string) => void;
  gitToggle?: (path: string, action: string) => void;
  rowClick?: (r: TreeRow) => void;
  openComposer?: () => void;
  setStyle?: (style: DiffStyle) => void;
  setFileView?: (view: "rendered" | "source") => void;
  isMarkdownFile?: () => boolean;
  splitApplies?: () => boolean;
  applySettings?: () => void;
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
  guideProgress?: () => { done: number; total: number; pct: number };
  categorySteps?: () => CategoryStep[];
  jumpToCategory?: (category: string) => void;
  saveComment?: () => void;
  ask?: () => void;
  requestChange?: () => void;
  reset?: () => Promise<void>;
  send?: () => Promise<void>;
  cancelStage?: () => void;
  confirmStage?: () => Promise<void>;
}

export type { ReviewState, ReviewComment, ChangeState, Decision };
