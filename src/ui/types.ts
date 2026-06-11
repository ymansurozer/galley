import type {
  ReviewState,
  ReviewComment,
  ChangeState,
  Decision,
  GuideFile,
  ReviewFile,
} from "../types";
import type { CategoryStep } from "./guide";

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
  stageOnAccept: boolean;
};

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
};

export type TreeRow = DirRow | FileRow;

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
  preview: ReviewFile | null;
  // True while a (non-cached) diff render is in flight — drives the "Rendering…" indicator.
  rendering: boolean;
  awaitingAgent: boolean;
  lastBaseDiffHash: string | null;
  selected: Selection;
  composerOpen: boolean;
  popoverOpen: boolean;
  toastMsg: string;
  composerTitle: string;
  composerBody: string;
  editingCommentId: string | null;
  settings: Settings;
  settingsOpen: boolean;
  // Which tab the settings modal shows ("shortcuts" = the keyboard map). A small confirm dialog
  // backs the destructive shortcuts (⇧R / ⇧S); confirmMsg is the prompt text, "" when closed.
  settingsTab: "settings" | "shortcuts";
  confirmMsg: string;
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
  guideProgress?: () => { done: number; approved: number; total: number; pct: number };
  categorySteps?: () => CategoryStep[];
  jumpToCategory?: (category: string) => void;
  saveComment?: () => void;
  ask?: () => void;
  requestChange?: () => void;
  reset?: () => Promise<void>;
  send?: () => Promise<void>;
  // Keyboard navigation (keys.ts): file stepping in either mode, confirm-dialog answers, and the
  // grouped binding list the help overlay renders.
  nextFile?: () => void;
  prevFile?: () => void;
  treeStep?: (dir: 1 | -1) => void;
  confirmYes?: () => void;
  confirmNo?: () => void;
  promptFinish?: () => void;
  helpGroups?: () => { group: string; items: { combo: string; desc: string }[] }[];
}

export type { ReviewState, ReviewComment, ChangeState, Decision };
