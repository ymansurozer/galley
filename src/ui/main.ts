import Alpine from "alpinejs";
import persistPlugin from "@alpinejs/persist";
import { S, D, $, api, persist, toast } from "./store";
import { loadDiffLib } from "./difflib";
import { currentFile } from "./changes";
import { openCommentComposer, closeComposerIfEmpty } from "./selection";
import { stageFile, unstageFile } from "./decisions";
import { treeRows } from "./tree";
import { render } from "./render";
import { pollState } from "./poll";
import { defaultFileView, isMarkdownPath } from "./mdfile";
import type { ReviewState } from "./types";

// Close the composer when clicking outside it (unless it has unsaved text).
document.addEventListener("pointerdown", (e) => {
  if (!S.composerOpen) return;
  const target = e.target as Node;
  if ($("composer").contains(target) || $("actionPop").contains(target)) return;
  closeComposerIfEmpty();
}, true);

// Pane resizers (imperative — they tweak CSS vars directly)
document.querySelectorAll<HTMLElement>("[data-resize]").forEach((handle) => {
  handle.onpointerdown = (e: PointerEvent) => {
    e.preventDefault(); handle.classList.add("dragging");
    const side = handle.dataset.resize; const startX = e.clientX;
    const styles = getComputedStyle(document.documentElement);
    const startLeft = parseInt(styles.getPropertyValue("--left-width")) || 280;
    const startRight = parseInt(styles.getPropertyValue("--right-width")) || 320;
    handle.setPointerCapture(e.pointerId);
    handle.onpointermove = (move: PointerEvent) => {
      if (side === "left") document.documentElement.style.setProperty("--left-width", `${Math.max(180, Math.min(520, startLeft + move.clientX - startX))}px`);
      else document.documentElement.style.setProperty("--right-width", `${Math.max(220, Math.min(620, startRight - (move.clientX - startX)))}px`);
    };
    handle.onpointerup = () => { handle.classList.remove("dragging"); handle.onpointermove = null; handle.onpointerup = null; };
  };
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { S.composerOpen = false; S.popoverOpen = false; S.editingCommentId = null; return; }
  if (e.key === "c" && S.composerOpen) { e.preventDefault(); S.saveComment?.(); }
  if (e.key === "v") S.setStyle?.(S.diffStyle === "split" ? "unified" : "split");
});

// Store methods the reactive chrome calls ($store.g.*)
S.treeRows = treeRows;
S.selectFile = (i) => { S.fileIndex = i; S.fileView = defaultFileView(S.state.files[i]); D.fileDiff = null; render(); };
S.toggleDir = (full) => { S.expandedDirs.has(full) ? S.expandedDirs.delete(full) : S.expandedDirs.add(full); };
S.toggleTestDir = (key) => { S.expandedDirs.has(key) ? S.expandedDirs.delete(key) : S.expandedDirs.add(key); };
S.gitToggle = (path, action) => (action === "unstage" ? unstageFile(path) : stageFile(path));
S.rowClick = (r) => { if (r.kind === "dir") S.toggleDir?.(r.full); else if (r.fileIndex !== undefined) S.selectFile?.(r.fileIndex); };
S.openComposer = openCommentComposer;
S.setStyle = (style) => { S.diffStyle = style; localStorage.setItem("galley.diffStyle", style); render(); };
S.setFileView = (view) => { S.fileView = view; D.fileDiff = null; render(); };
S.isMarkdownFile = () => { const f = S.state && S.state.mode === "file" && S.state.files[S.fileIndex]; return !!f && isMarkdownPath(f.path); };
S.saveComment = () => {
  const body = (S.composerBody || "").trim();
  if (!body) return;
  if (S.editingCommentId) {
    const comment = S.state.comments.find((c) => c.id === S.editingCommentId);
    if (comment) { comment.body = body; comment.updatedAt = new Date().toISOString(); }
    S.editingCommentId = null;
    S.composerOpen = false; render(); persist(); toast("Comment updated");
    return;
  }
  const now = new Date().toISOString();
  S.state.comments.push({ id: crypto.randomUUID(), path: currentFile().path, side: S.selected.side, lineNumber: S.selected.lineNumber, endLine: S.selected.endLine, createdAt: now, updatedAt: now, status: "open", role: "user", body, intent: "action" });
  S.composerOpen = false; render(); persist(); toast("Comment saved");
};
S.reset = async () => { const r = await api<{ state?: ReviewState }>("/api/reset", { method: "POST" }); if (r.state) { S.state = r.state; D.fileDiff = null; render(); } toast("Reset review"); };
S.send = async () => { const r = await api<{ sent?: boolean }>("/api/send", { method: "POST", body: JSON.stringify(S.state) }); if (r && r.sent) { S.awaitingAgent = true; toast("Sent to agent"); } else toast("Could not send review"); };
S.cancelStage = () => { S.pendingStagePath = null; S.modalOpen = false; };
S.confirmStage = async () => { const path = S.pendingStagePath; S.pendingStagePath = null; S.modalOpen = false; if (path) await stageFile(path, true); };

// Alpine: register the reactive store + persist plugin, then start.
(window as any).Alpine = Alpine;
Alpine.plugin(persistPlugin);
Alpine.store("g", S);
Alpine.start();

// Init
await loadDiffLib();
S.state = await api<ReviewState>("/api/state");
S.projectFiles = (await api<{ files?: string[] }>("/api/tree")).files || [];
S.lastBaseDiffHash = S.state.baseDiffHash;
S.selected = { side: S.state.changes[0]?.side || "additions", lineNumber: S.state.changes[0]?.lineNumber || 1 };
if (S.state.files[S.fileIndex]) S.fileView = defaultFileView(S.state.files[S.fileIndex]);
render();
setInterval(pollState, 1500);
