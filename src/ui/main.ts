import Alpine from "alpinejs";
import persistPlugin from "@alpinejs/persist";
import { S, D, $, api, persist, toast } from "./store";
import { loadDiffLib } from "./difflib";
import { currentFile, currentSplittable, fromDisplayLine } from "./changes";
import { openCommentComposer, closeComposerIfEmpty } from "./selection";
import { treeRows, allDirPaths, touchedDirPaths } from "./tree";
import { render, deferRender } from "./render";
import { pollState } from "./poll";
import { defaultFileView, isMarkdownPath } from "./mdfile";
import { applyAppearance, persistSettings } from "./settings";
import { setMarkdownTheme } from "./markdown";
import { ensureIcons } from "./icons";
import {
  hasGuide,
  firstGuideIndex,
  currentGuideEntry,
  currentFileName,
  showGuideBar,
  guideStale,
  nextFileIndex,
  prevFileIndex,
  guideProgress,
  categorySteps,
  firstFileOfCategory,
} from "./guide";
import { installKeys, helpGroups, confirmYes, confirmNo, askConfirm } from "./keys";
import { cursorReset, cursorOnScroll } from "./cursor";
import type { ReviewState, FileRow } from "./types";

// Close the composer when clicking outside it (unless it has unsaved text).
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!S.composerOpen) return;
    const target = e.target as Node;
    if ($("composer").contains(target) || $("actionPop").contains(target)) return;
    closeComposerIfEmpty();
  },
  true,
);

// Pane resizers (imperative — they tweak CSS vars directly)
document.querySelectorAll<HTMLElement>("[data-resize]").forEach((handle) => {
  handle.onpointerdown = (e: PointerEvent) => {
    e.preventDefault();
    handle.classList.add("dragging");
    const side = handle.dataset.resize;
    const startX = e.clientX;
    const styles = getComputedStyle(document.documentElement);
    const startLeft = parseInt(styles.getPropertyValue("--left-width")) || 280;
    const startRight = parseInt(styles.getPropertyValue("--right-width")) || 320;
    handle.setPointerCapture(e.pointerId);
    handle.onpointermove = (move: PointerEvent) => {
      if (side === "left")
        document.documentElement.style.setProperty(
          "--left-width",
          `${Math.max(180, Math.min(520, startLeft + move.clientX - startX))}px`,
        );
      else
        document.documentElement.style.setProperty(
          "--right-width",
          `${Math.max(220, Math.min(620, startRight - (move.clientX - startX)))}px`,
        );
    };
    handle.onpointerup = () => {
      handle.classList.remove("dragging");
      handle.onpointermove = null;
      handle.onpointerup = null;
    };
  };
});

// Keyboard shortcuts: a central scope-aware dispatcher (keys.ts) is the single source of truth.
installKeys();

// Store methods the reactive chrome calls ($store.g.*)
S.treeRows = treeRows;
// Update the lightweight state synchronously (so the tree active-row + guide bar repaint
// immediately — the click feels instant), then run the heavier diff render via deferRender,
// which shows the "Rendering…" indicator only for a cold open of a big file.
S.selectFile = (i) => {
  if (i < 0 || !S.state.files[i]) return; // ignore out-of-range selections
  S.overviewOpen = false;
  S.preview = null;
  S.fileIndex = i;
  S.fileView = defaultFileView(S.state.files[i]);
  D.fileDiff = null;
  cursorReset(); // re-init the line cursor to the new file's first change
  deferRender();
};
// Open any repo file (incl. unchanged ones) for read/comment: fetch its contents and show it
// as a plain view (old === new → no diff blocks). Comments anchor to it like any file.
S.previewFile = async (path) => {
  try {
    const r = await api<{ path: string; contents: string }>(
      `/api/file?path=${encodeURIComponent(path)}`,
    );
    if (typeof r.contents !== "string") {
      toast("Could not open file");
      return;
    }
    S.overviewOpen = false;
    // contentHash is unused for previews (they're never approved), so leave it empty.
    S.preview = {
      path,
      hunks: [],
      contentHash: "",
      oldFile: { name: path, contents: r.contents },
      newFile: { name: path, contents: r.contents },
    };
    D.fileDiff = null;
    cursorReset();
    render();
  } catch {
    toast("Could not open file");
  }
};
// Changed folders open by default → toggle via collapsedDirs; unchanged closed → expandedDirs.
S.toggleDir = (full, changed) => {
  const set = changed ? S.collapsedDirs : S.expandedDirs;
  if (set.has(full)) set.delete(full);
  else set.add(full);
};
// Collapse-all / expand-all from the FILES title. anyOpen drives the button's icon.
S.treeAnyOpen = () =>
  (S.treeRows?.() ?? []).some((r) => r.kind === "dir" && (r as { open?: boolean }).open);
S.toggleAllDirs = () => {
  // Collapse all → close every folder. Expand all → open only folders with a touched file
  // (changes/comments); purely-unchanged folders stay closed.
  if (S.treeAnyOpen?.()) {
    S.collapsedDirs = new Set(allDirPaths());
    S.expandedDirs = new Set();
  } else {
    S.collapsedDirs = new Set();
    S.expandedDirs = new Set(touchedDirPaths());
  }
};
S.toggleTestDir = (key) => {
  if (S.expandedDirs.has(key)) S.expandedDirs.delete(key);
  else S.expandedDirs.add(key);
};
S.rowClick = (r) => {
  if (r.kind === "dir") S.toggleDir?.(r.full, r.changed);
  else if (r.fileIndex !== undefined) S.selectFile?.(r.fileIndex);
  else S.previewFile?.(r.path);
};
S.openComposer = openCommentComposer;
S.setStyle = (style) => {
  S.diffStyle = style;
  localStorage.setItem("galley.diffStyle", style);
  render();
};
S.setFileView = (view) => {
  S.fileView = view;
  D.fileDiff = null;
  render();
};
// Apply + persist all settings: CSS vars (font/size), comment-code theme, and a re-render
// (the diff reads S.settings.* in render()). Bound to every control's @change.
S.applySettings = () => {
  persistSettings(S.settings);
  applyAppearance(S.settings);
  setMarkdownTheme(S.settings.theme);
  render();
};
S.openSettings = () => {
  S.settingsOpen = true;
};
S.closeSettings = () => {
  S.settingsOpen = false;
};
// Guided review: ⌂ returns to the Overview page; Start enters the per-file flow at the
// first file in the guide's order.
S.hasGuide = hasGuide;
S.openOverview = () => {
  S.overviewOpen = true;
  render();
};
S.startGuided = () => {
  S.overviewOpen = false;
  S.selectFile?.(firstGuideIndex());
};
// Top guide-bar getters (the bar is Alpine chrome, reactive on fileIndex/overviewOpen).
S.showGuideBar = showGuideBar;
S.guideStale = guideStale;
S.curGuide = currentGuideEntry;
S.curFileName = currentFileName;
// Guided navigation: the Overview is the position before the first file. From it, Next
// enters the first file and Prev is a no-op; within files, Prev off the first → Overview.
S.guideNext = () => {
  if (S.overviewOpen) {
    S.startGuided?.();
    return;
  }
  const n = nextFileIndex(S.fileIndex);
  if (n !== null) S.selectFile?.(n);
};
S.guidePrev = () => {
  if (S.overviewOpen) return;
  const p = prevFileIndex(S.fileIndex);
  if (p === null) S.openOverview?.();
  else S.selectFile?.(p);
};
S.guideAtStart = () => !!S.overviewOpen;
S.guideAtLast = () => !S.overviewOpen && nextFileIndex(S.fileIndex) === null;
// Review-order file stepping (⇧←/⇧→) — guide order when guided (or on the Overview), else sequential.
S.nextFile = () => {
  if (hasGuide() || S.overviewOpen) {
    S.guideNext?.();
    return;
  }
  const n = S.fileIndex + 1;
  if (n < S.state.files.length) S.selectFile?.(n);
};
S.prevFile = () => {
  if (hasGuide() || S.overviewOpen) {
    S.guidePrev?.();
    return;
  }
  const p = S.fileIndex - 1;
  if (p >= 0) S.selectFile?.(p);
};
// Tree-order file stepping (⇧↑/⇧↓) — walk the file rows as shown in the tree (skip folders),
// selecting the prev/next one (preview for unchanged files).
S.treeStep = (dir) => {
  const fileRows = (S.treeRows?.() ?? []).filter((r): r is FileRow => r.kind !== "dir");
  if (!fileRows.length) return;
  const cur = S.preview?.path ?? S.state.files[S.fileIndex]?.path;
  let i = fileRows.findIndex((r) => r.path === cur);
  if (i < 0) i = dir === 1 ? -1 : fileRows.length;
  const target = fileRows[i + dir];
  if (!target) return;
  if (target.fileIndex !== undefined) S.selectFile?.(target.fileIndex);
  else S.previewFile?.(target.path);
};
// Keyboard help overlay + destructive-action confirm dialog (keys.ts owns the dialog state).
S.helpGroups = helpGroups;
S.confirmYes = confirmYes;
S.confirmNo = confirmNo;
// Fired after the last file is approved — offer to send the finished review back to the agent.
S.promptFinish = () =>
  askConfirm("You've reviewed every file. Send the review back to the agent?", () => S.send?.());
S.guideProgress = guideProgress;
// Category stepper (count + fill): clicking a category jumps to its first unreviewed file.
S.categorySteps = categorySteps;
S.jumpToCategory = (cat) => {
  const i = firstFileOfCategory(cat);
  if (i !== null && i !== undefined) S.selectFile?.(i);
};
S.isMarkdownFile = () => {
  const f = S.state && S.state.mode === "file" && S.state.files[S.fileIndex];
  return !!f && isMarkdownPath(f.path);
};
S.splitApplies = currentSplittable;
// New comments carry an intent: "question" (Ask — pushed to the agent now via /api/ask,
// answered live) or "action" (Request change — goes back on Send). Editing just updates the
// body and keeps the existing intent.
const submitComment = (intent: "question" | "action") => {
  const body = (S.composerBody || "").trim();
  if (!body) return;
  if (S.editingCommentId) {
    const comment = S.state.comments.find((c) => c.id === S.editingCommentId);
    if (comment) {
      comment.body = body;
      comment.updatedAt = new Date().toISOString();
    }
    S.editingCommentId = null;
    S.composerOpen = false;
    render();
    persist();
    toast("Comment updated");
    return;
  }
  const now = new Date().toISOString();
  // S.selected carries rendered (display) gutter numbers; persist the raw file line so
  // the anchor stays valid as decisions replay and across rounds.
  const file = currentFile();
  const side = S.selected.side;
  const lineNumber = fromDisplayLine(side, S.selected.lineNumber);
  const contents = side === "deletions" ? file.oldFile?.contents : file.newFile?.contents;
  const c = {
    id: crypto.randomUUID(),
    path: file.path,
    side,
    lineNumber,
    endLine:
      S.selected.endLine === undefined ? undefined : fromDisplayLine(side, S.selected.endLine),
    // Snapshot the anchored line's text so a reload can re-anchor the thread after the
    // agent's edits shift it (reanchorComments).
    anchorText: contents?.split("\n")[lineNumber - 1],
    createdAt: now,
    updatedAt: now,
    status: "open" as const,
    role: "user" as const,
    body,
    intent,
  };
  S.state.comments.push(c);
  S.composerOpen = false;
  render();
  persist();
  if (intent === "question") {
    api("/api/ask", {
      method: "POST",
      body: JSON.stringify({ path: c.path, lineNumber: c.lineNumber, side: c.side, body }),
    });
    toast("Asked — waiting for answer");
  } else toast("Comment saved");
};
S.saveComment = () => submitComment("action"); // editing Save + the `c` shortcut default
S.ask = () => submitComment("question");
S.requestChange = () => submitComment("action");
S.reset = async () => {
  const r = await api<{ state?: ReviewState }>("/api/reset", { method: "POST" });
  if (r.state) {
    S.state = r.state;
    D.fileDiff = null;
    render();
  }
  toast("Reset review");
};
S.send = async () => {
  const r = await api<{ sent?: boolean }>("/api/send", {
    method: "POST",
    body: JSON.stringify(S.state),
  });
  if (r && r.sent) {
    S.awaitingAgent = true;
    toast("Sent to agent");
  } else toast("Could not send review");
};

// Alpine: register the reactive store + persist plugin, then start.
(window as any).Alpine = Alpine;
Alpine.plugin(persistPlugin);
Alpine.store("g", S);
Alpine.start();

// Init
ensureIcons(); // file-tree icon sprite (folder/file/badges/stage)
applyAppearance(S.settings); // persisted font + size before first paint
await loadDiffLib();
S.state = await api<ReviewState>("/api/state");
S.projectFiles = (await api<{ files?: string[] }>("/api/tree")).files || [];
S.lastBaseDiffHash = S.state.baseDiffHash;
S.selected = {
  side: S.state.changes[0]?.side || "additions",
  lineNumber: S.state.changes[0]?.lineNumber || 1,
};
if (S.state.files[S.fileIndex]) S.fileView = defaultFileView(S.state.files[S.fileIndex]);
// With a guide attached, land on the Overview page (the guided entry point).
if (hasGuide()) S.overviewOpen = true;
render();
// Keep the line-cursor highlight glued to its row while scrolling the diff (rAF-throttled).
let scrollRAF = 0;
$("diff").addEventListener(
  "scroll",
  () => {
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(() => {
      scrollRAF = 0;
      cursorOnScroll();
    });
  },
  { passive: true },
);
setInterval(pollState, 1500);
