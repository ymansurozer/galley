import Alpine from "alpinejs";
import { S, D, $, api, persist, persistPrefs, toast } from "./store";
import { loadDiffLib } from "./difflib";
import {
  currentFile,
  currentSplittable,
  fromDisplayLine,
  fileFinished,
  fileObjections,
} from "./changes";
import { approveCurrentFile } from "./decisions";
import { openCommentComposer, closeComposerIfEmpty } from "./selection";
import { treeRows, allDirPaths, touchedDirPaths } from "./tree";
import { render, deferRender } from "./render";
import { adoptDeskStatus, pollState } from "./poll";
import { defaultFileView, isMarkdownPath } from "./mdfile";
import { applyAppearance, DEFAULT_SETTINGS } from "./settings";
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
  walkthroughRows,
} from "./guide";
import { setBaseTitle, reviewStats } from "./progress";
import { installKeys, helpGroups, confirmYes, confirmNo } from "./keys";
import { cursorReset, cursorSelection } from "./cursor";
import type { ReviewState, FileRow, Settings, DiffStyle } from "./types";

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
  // Narrow-width drawer: opening a file is the drawer's whole purpose, so get it out of the
  // way. The single funnel for tree/walkthrough clicks + next/prev + guide nav; no-op when shut.
  S.treeDrawerOpen = false;
  S.overviewOpen = false;
  S.preview = null;
  S.diffScrolled = false; // the new file renders at the top (see render.ts) — hide the floating action
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
  persistPrefs();
  render();
};
S.setFileView = (view) => {
  S.fileView = view;
  D.fileDiff = null;
  render();
};
// Floating sign-off button (mirrors the header's ⇧A action): shown only once the diff is
// scrolled past its header, and only for a pending changed file — not the Overview, a preview
// (unchanged, not approvable), or an already-finished file (which offers Reset, not Approve).
S.approveFile = () => approveCurrentFile();
S.fabState = () => {
  if (S.overviewOpen || S.preview) return null;
  const path = S.state?.files?.[S.fileIndex]?.path;
  if (!path || fileFinished(path)) return null;
  return fileObjections(path) ? "changes" : "clean";
};
// Apply + persist all settings: CSS vars (font/size), comment-code theme, and a re-render
// (the diff reads S.settings.* in render()). Bound to every control's @change.
S.applySettings = () => {
  persistPrefs();
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
// Pluralize a count with its noun: plural(1, "file") → "1 file", plural(3, "file") → "3 files".
const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
// Open the Send modal: a receipt of what's about to go, plus an empty (always fresh) note box.
// An attached agent picks the review up the instant it's sent, so there's no taking it back —
// this is the moment to look, and to leave an overall instruction for the whole review.
const openSendModal = (msg: string) => {
  S.sendMsg = msg;
  S.sendNote = "";
  S.sendOpen = true;
  setTimeout(() => $("sendNote")?.focus(), 0); // after Alpine shows it (mirrors the composer)
};
// Fired after the last file is approved — a small receipt of the work done (files, lines,
// comments, rejections) plus the offer to send the finished review back to the agent.
S.promptFinish = () => {
  const { files, lines, comments, rejections } = reviewStats();
  const extras = [
    comments ? plural(comments, "comment") : "",
    rejections ? plural(rejections, "rejected hunk") : "",
  ].filter(Boolean);
  const what = files === 1 ? "the file" : `all ${files} files`;
  const tail = extras.length ? extras.join(", ") : "all clean";
  openSendModal(
    `You've reviewed ${what} — ${plural(lines, "changed line")}, ${tail}. Send the review back to the agent?`,
  );
};
// Every manual send — the Send button and ⇧S — routes through this receipt-style modal: a
// glance at what's about to go (files, lines, comments, rejections) before the one-way handoff.
// (The button used to call send() directly with no confirm at all, which made accidental sends
// too easy.)
S.confirmSend = () => {
  const { files, lines, comments, rejections } = reviewStats();
  const parts = [
    plural(files, "file"),
    plural(lines, "changed line"),
    comments ? plural(comments, "comment") : "",
    rejections ? plural(rejections, "rejected hunk") : "",
  ].filter(Boolean);
  openSendModal(`You're about to send your review: ${parts.join(", ")}. Send to the agent?`);
};
// Confirm the Send modal: the typed note (trimmed; empty → omitted) rides along as the one-time
// overall instruction. Cancel leaves the review untouched.
S.sendConfirm = () => {
  const note = S.sendNote.trim();
  S.sendOpen = false;
  S.send?.(note);
};
S.sendCancel = () => {
  S.sendOpen = false;
  S.sendNote = "";
};
// Walkthrough sidebar tab: categories + files in guide order (plus the "Other" trailer).
S.walkthroughRows = walkthroughRows;
S.isMarkdownFile = () => {
  const f = S.state && S.state.mode === "file" && S.state.files[S.fileIndex];
  return !!f && isMarkdownPath(f.path);
};
S.splitApplies = currentSplittable;
// Jump from the desk into the local editor at the cursor's line. The cursor (and
// S.selected) hold DISPLAY coordinates — replayed decisions renumber the rendered diff —
// so convert to the real file line before handing it to an external process.
S.openInEditor = async () => {
  const file = currentFile();
  if (!file?.path) {
    toast("No file selected");
    return;
  }
  const sel = cursorSelection() ?? S.selected;
  const lineNumber = sel ? fromDisplayLine(sel.side, sel.lineNumber) : 1;
  try {
    const res = await api<{ ok?: boolean; error?: string }>("/api/open-editor", {
      method: "POST",
      body: JSON.stringify({ path: file.path, lineNumber }),
    });
    toast(res.ok ? "Opened in editor" : res.error || "Could not open editor");
  } catch {
    toast("Could not open editor");
  }
};
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
S.send = async (overallNote = "") => {
  const r = await api<{ sent?: boolean }>("/api/send", {
    method: "POST",
    // overallNote is a one-time instruction for the whole review; the server reads it off the
    // body and never persists it onto the saved state (see /api/send + stripDeskStatus).
    body: JSON.stringify({ ...S.state, overallNote }),
  });
  if (r && r.sent) {
    S.awaitingAgent = true;
    toast("Sent to agent");
  } else toast("Could not send review");
};

// Alpine: register the reactive store, then start.
(window as any).Alpine = Alpine;
Alpine.store("g", S);
Alpine.start();

// Init
ensureIcons(); // file-tree icon sprite (folder/file/badges/stage)
// Display preferences live in ~/.galley/settings.json (localStorage is per-origin and the
// port is random, so it can't hold them). Fold the file over the defaults before first paint.
type Prefs = { settings?: Partial<Settings>; diffStyle?: DiffStyle };
const [prefs, state, tree] = await Promise.all([
  api<Prefs>("/api/settings").catch(() => ({}) as Prefs),
  api<ReviewState>("/api/state"),
  api<{ files?: string[] }>("/api/tree"),
  loadDiffLib(),
]);
S.settings = { ...DEFAULT_SETTINGS, ...prefs?.settings };
if (prefs?.diffStyle === "split" || prefs?.diffStyle === "unified") S.diffStyle = prefs.diffStyle;
applyAppearance(S.settings); // font + size before first paint
setMarkdownTheme(S.settings.theme);
S.state = adoptDeskStatus(state);
S.projectFiles = tree.files || [];
S.lastBaseDiffHash = S.state.baseDiffHash;
// Tab title: name the session so multiple desks are distinguishable in the browser.
// Repo mode → repo folder; file mode → file name; pr mode → the (truncated) ref.
{
  const base = (p?: string) => p?.replace(/\/+$/, "").split("/").pop() || "";
  const ref = S.state.target ?? S.state.session ?? "";
  const name =
    S.state.mode === "file"
      ? base(S.state.target)
      : S.state.mode === "pr"
        ? ref.slice(0, 32) + (ref.length > 32 ? "…" : "")
        : base(S.state.root);
  if (name) document.title = `Galley — ${name}`;
  // progress.ts prefixes the title with the review % — hand it the base to prefix.
  setBaseTitle(document.title);
}
S.selected = {
  side: S.state.changes[0]?.side || "additions",
  lineNumber: S.state.changes[0]?.lineNumber || 1,
};
if (S.state.files[S.fileIndex]) S.fileView = defaultFileView(S.state.files[S.fileIndex]);
// With a guide attached, land on the Overview page (the guided entry point) and open the
// sidebar on the user's preferred pane (`w` toggles it per-session from there).
if (hasGuide()) {
  S.overviewOpen = true;
  S.sidebarTab = S.settings.sidebarDefault === "walkthrough" ? "walkthrough" : "tree";
}
render();
// Reveal the floating Approve button once the diff scrolls past its (non-sticky) header. #diff
// is the persistent scroll container (x-ignore), so this listener is attached once and survives
// every re-render/file switch.
$("diff").addEventListener("scroll", () => {
  S.diffScrolled = $("diff").scrollTop > 140;
});
setInterval(pollState, 1500);
