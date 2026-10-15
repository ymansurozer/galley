import Alpine from "alpinejs";
import type { DiffHolder, SaveStamp, Store } from "./types";
import { loadSettings } from "./settings";
import { createSaver, reviewerSlice } from "./save";

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
  stepPart: undefined,
  preview: null,
  rendering: false,
  awaitingAgent: false,
  agentActivity: null,
  agentTrail: [],
  agentListening: false,
  queuedQuestions: 0,
  queuedReviews: 0,
  presence: { kind: "hidden", line: "" },
  reviewDone: false,
  requests: [],
  lastBaseDiffHash: null,
  selected: { side: "additions", lineNumber: 1 },
  // chrome UI flags (templates bind to these)
  composerOpen: false,
  toastMsg: "",
  toastAction: "",
  toastKeys: "",
  golineBuffer: "",
  composerBody: "",
  editingCommentId: null,
  settings: loadSettings(),
  settingsOpen: false,
  settingsTab: "settings",
  confirmMsg: "",
  sendOpen: false,
  sendMsg: "",
  sendNote: "",
  sendFinishing: false,
  overviewOpen: false,
  sidebarTab: "tree",
  requestsOpen: false,
  openThread: null,
  treeDrawerOpen: false,
  sidebarCollapsed: false,
  fileView: "rendered",
  skimExpanded: new Set<string>(),
  loadedOversized: new Set<string>(),
  view: "code",
  ready: false,
  uiProxy: null,
  reloadGeneration: 0,
  app: {
    loaded: false,
    route: "/",
    title: "",
    connected: false,
    canGoBack: null,
    canGoForward: null,
    stale: false,
  },
  viewport: "fit",
  frameLabel: "",
  appMode: "interact",
  pendingPicks: 0,
  selectedAnnotation: null,
  lookedFor: new Set<string>(),
  annotationDraft: null,
  composerAnnotation: null,
  sendLanes: null,
  shotView: null,
});

// Imperative-island objects kept OUT of the reactive store: the @pierre/diffs
// classes/instance and parsed fileDiff do internal element/identity checks that
// an Alpine reactive Proxy breaks (e.g. ResizeManager ownership). Plain object.
export const D: DiffHolder = {
  // null until difflib.ts wires them at import (before any render); cast so the
  // hot-path call sites don't each need a non-null assertion.
  FileDiff: null as unknown as DiffHolder["FileDiff"],
  parseDiffFromFile: null as unknown as DiffHolder["parseDiffFromFile"],
  processFile: null as unknown as DiffHolder["processFile"],
  diffAcceptRejectHunk: null as unknown as DiffHolder["diffAcceptRejectHunk"],
  instance: null,
  diffCache: new Map(),
  fileDiff: null,
  rawFileDiff: null,
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
let toastRun: (() => void) | null = null;
// An action toast ("Reset review · Undo") stays up long enough to reach its button. The next toast
// replaces it, action and all, so an action never outlives the moment it answers. A toast that
// names a shortcut passes it as keys, drawn as keycaps after the text.
export function toast(t: string, action?: { label: string; run: () => void }, keys = "") {
  S.toastMsg = t;
  S.toastKeys = keys;
  S.toastAction = action?.label ?? "";
  toastRun = action?.run ?? null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(clearToast, action ? 6000 : 2800);
}
function clearToast() {
  S.toastMsg = S.toastAction = S.toastKeys = "";
  toastRun = null;
}
export function runToastAction() {
  const run = toastRun;
  clearTimeout(toastTimer);
  clearToast();
  run?.();
}
export { esc } from "./html";
export const api = <T = unknown>(path: string, opts: RequestInit = {}): Promise<T> =>
  fetch(path, { headers: { "content-type": "application/json" }, ...opts }).then(
    (r) => r.json() as Promise<T>,
  );
// Open a repo-relative file at a line in the reviewer's editor (the command is a Settings
// preference). The code lane's open-in-editor and the UI lane's source links both come here.
export async function openEditorAt(path: string, lineNumber: number) {
  try {
    const res = await api<{ ok?: boolean; error?: string }>("/api/open-editor", {
      method: "POST",
      body: JSON.stringify({ path, lineNumber }),
    });
    if (!res.ok) toast(res.error || "Could not open editor");
  } catch {
    toast("Could not open editor");
  }
}
// What this tab has adopted of the desk, stamped on every save and Send (types.ts, SaveStamp).
export const saveStamp = (): SaveStamp => ({
  token: S.uiProxy?.token ?? null,
  reloadGeneration: S.reloadGeneration,
  baseDiffHash: S.state.baseDiffHash,
});
// Post only the reviewer-owned slice (see reviewerSlice in save.ts) — never the whole
// (multi-MB) ReviewState. Saves coalesce so rapid approvals don't saturate connections.
export const saver = createSaver(
  () => ({ ...reviewerSlice(S.state), seen: saveStamp() }),
  (payload) => api("/api/save", { method: "POST", body: JSON.stringify(payload) }),
);
// Instant auto-save: there is no manual Save button, so every state mutation
// (decision, comment, stage/unstage, approval) MUST call persist() to write the
// review to ~/.galley/<repoHash>/<session>/. Saves coalesce (see save.ts): at most one
// in flight, rapid triggers collapse into a single trailing save.
export const persist = () => saver.trigger();
// What the app page reports (where it found the annotations) saves at most once a second, or with
// the reviewer's next save if that comes first (save.ts, triggerSoon).
export const persistSoon = () => saver.triggerSoon();
// Display preferences (settings panel + the Split/Stacked toggle) save to the global
// ~/.galley/settings.json so they survive port/session changes. Last write wins.
export const persistPrefs = () =>
  api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ settings: S.settings, diffStyle: S.diffStyle }),
  }).catch(() => {});
