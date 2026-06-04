import Alpine from "alpinejs";

// Single reactive source of truth: the imperative diff island mutates it directly,
// and the Alpine-driven chrome (tree, toolbar, composer, modals, toast) renders from it.
export const S: any = Alpine.reactive({
  state: null,
  projectFiles: [],
  expandedDirs: new Set<string>(),
  pendingStagePath: null,
  diffStyle: localStorage.getItem("galley.diffStyle") || "split",
  fileIndex: 0,
  awaitingAgent: false,
  lastBaseDiffHash: null,
  selected: { side: "additions", lineNumber: 1 },
});

// Imperative-island objects kept OUT of the reactive store: the @pierre/diffs
// classes/instance and parsed fileDiff do internal element/identity checks that
// an Alpine reactive Proxy breaks (e.g. ResizeManager ownership). Plain object.
export const D: any = {
  FileDiff: null,
  parseDiffFromFile: null,
  diffAcceptRejectHunk: null,
  instance: null,
  fileDiff: null,
};

export const $ = (id: string) => document.getElementById(id) as any;
export function show(e: any) { e.classList.add("show"); }
export function hide(e: any) { e.classList.remove("show"); }
export function toast(t: string) { $("toast").textContent = t; show($("toast")); setTimeout(() => hide($("toast")), 2800); }
export function esc(s: any) { return String(s ?? "").replace(/[&<>]/g, (c: string) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c])); }
export const api = (path: string, opts: any = {}) => fetch(path, { headers: { "content-type": "application/json" }, ...opts }).then((r) => r.json());
export const persist = () => api("/api/save", { method: "POST", body: JSON.stringify(S.state) }).catch(() => {});
