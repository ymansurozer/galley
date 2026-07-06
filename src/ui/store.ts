import Alpine from "alpinejs";
import type { Store, DiffHolder } from "./types";
import { loadSettings } from "./settings";

// Single reactive source of truth: the imperative diff island mutates it directly,
// and the Alpine-driven chrome (tree, toolbar, composer, modals, toast) renders from it.
// `state` is null until the initial fetch in main.ts; everything that reads it runs
// post-init (treeRows guards for the brief pre-init window the template may render in).
export const S: Store = Alpine.reactive<Store>({
  state: null as unknown as Store["state"],
  projectFiles: [],
  expandedDirs: new Set<string>(),
  collapsedDirs: new Set<string>(),
  // Display preferences come from ~/.galley/settings.json (fetched in main.ts init),
  // not localStorage — origins change with the random port, files don't.
  diffStyle: "split",
  fileIndex: 0,
  preview: null,
  rendering: false,
  awaitingAgent: false,
  agentActivity: null,
  agentListening: false,
  queuedQuestions: 0,
  queuedReviews: 0,
  lastBaseDiffHash: null,
  selected: { side: "additions", lineNumber: 1 },
  // chrome UI flags (templates bind to these)
  composerOpen: false,
  popoverOpen: false,
  toastMsg: "",
  golineBuffer: "",
  composerTitle: "New line",
  composerBody: "",
  editingCommentId: null,
  settings: loadSettings(),
  settingsOpen: false,
  settingsTab: "settings",
  confirmMsg: "",
  sendOpen: false,
  sendMsg: "",
  sendNote: "",
  overviewOpen: false,
  sidebarTab: "tree",
  treeDrawerOpen: false,
  fileView: "rendered",
  diffScrolled: false,
});

// Imperative-island objects kept OUT of the reactive store: the @pierre/diffs
// classes/instance and parsed fileDiff do internal element/identity checks that
// an Alpine reactive Proxy breaks (e.g. ResizeManager ownership). Plain object.
export const D: DiffHolder = {
  // null until difflib.ts wires them at import (before any render); cast so the
  // hot-path call sites don't each need a non-null assertion.
  FileDiff: null as unknown as DiffHolder["FileDiff"],
  parseDiffFromFile: null as unknown as DiffHolder["parseDiffFromFile"],
  diffAcceptRejectHunk: null as unknown as DiffHolder["diffAcceptRejectHunk"],
  instance: null,
  diffCache: new Map(),
  fileDiff: null,
  lineMap: null,
};

export const $ = (id: string) => document.getElementById(id) as HTMLElement;
export function show(e: Element) {
  e.classList.add("show");
}
export function hide(e: Element) {
  e.classList.remove("show");
}
let toastTimer: ReturnType<typeof setTimeout>;
export function toast(t: string) {
  S.toastMsg = t;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (S.toastMsg = ""), 2800);
}
export function esc(s: unknown) {
  return String(s ?? "").replace(
    /[&<>]/g,
    (c: string) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }) as Record<string, string>)[c] ?? c,
  );
}
export const api = <T = unknown>(path: string, opts: RequestInit = {}): Promise<T> =>
  fetch(path, { headers: { "content-type": "application/json" }, ...opts }).then(
    (r) => r.json() as Promise<T>,
  );
// Instant auto-save: there is no manual Save button, so every state mutation
// (decision, comment, stage/unstage, approval) MUST call persist() to write the
// review to ~/.galley/<repoHash>/<session>/.
export const persist = () =>
  api("/api/save", { method: "POST", body: JSON.stringify(S.state) }).catch(() => {});
// Display preferences (settings panel + the Split/Stacked toggle) save to the global
// ~/.galley/settings.json so they survive port/session changes. Last write wins.
export const persistPrefs = () =>
  api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ settings: S.settings, diffStyle: S.diffStyle }),
  }).catch(() => {});
