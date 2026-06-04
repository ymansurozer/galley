// Shared mutable client state + DOM helpers. A single mutable object keeps
// cross-module state simple (ESM live bindings can't be reassigned by importers).
export const S: any = {
  state: null,
  projectFiles: [],
  expandedDirs: new Set<string>(),
  pendingStagePath: null,
  FileDiff: null,
  parseDiffFromFile: null,
  diffAcceptRejectHunk: null,
  instance: null,
  fileDiff: null,
  diffStyle: localStorage.getItem("galley.diffStyle") || "split",
  fileIndex: 0,
  awaitingAgent: false,
  lastBaseDiffHash: null,
  selected: { side: "additions", lineNumber: 1 },
};

export const $ = (id: string) => document.getElementById(id) as any;
export function show(e: any) { e.classList.add("show"); }
export function hide(e: any) { e.classList.remove("show"); }
export function toast(t: string) { $("toast").textContent = t; show($("toast")); setTimeout(() => hide($("toast")), 2800); }
export function esc(s: any) { return String(s ?? "").replace(/[&<>]/g, (c: string) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c])); }
export const api = (path: string, opts: any = {}) => fetch(path, { headers: { "content-type": "application/json" }, ...opts }).then((r) => r.json());
export const persist = () => api("/api/save", { method: "POST", body: JSON.stringify(S.state) }).catch(() => {});
