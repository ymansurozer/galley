import Alpine from "alpinejs";
import {
  S,
  D,
  $,
  api,
  openEditorAt,
  persist,
  persistPrefs,
  runToastAction,
  saveStamp,
  toast,
} from "./store";
import { loadDiffLib } from "./difflib";
import {
  currentFile,
  currentSplittable,
  fromDisplayLine,
  fileFinished,
  fileObjections,
} from "./changes";
import { approveCurrentFile, toggleSignOff } from "./decisions";
import { closeComposerIfEmpty } from "./selection";
import { applyActiveRow, showActiveRow, treeRows, allDirPaths, touchedDirPaths } from "./tree";
import { toggleSkimGroup } from "./skim";
import { render, deferRender } from "./render";
import { cur, prefetchContents } from "./contents";
import { adoptDeskStatus, pollState } from "./poll";
import { reviewerSlice } from "./save";
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
  nextWrapIndex,
  prevWrapIndex,
  anyUnreviewed,
  navOrder,
  walkthroughRows,
} from "./guide";
import { refreshBaseTitle, reviewStats } from "./progress";
import { installKeys, helpGroups, confirmYes, confirmNo } from "./keys";
import {
  appBack,
  appForward,
  appGo,
  appHost,
  appRefresh,
  firstRenderDone,
  hasUi,
  installAppView,
  setView,
  setViewport,
  syncView,
  uiOnly,
} from "./appview";
import { installCaptureDebug } from "./capturedebug";
import { askComment } from "./comments";
import { composerInUi } from "./composer";
import {
  annotatePage,
  closeShot,
  installUiLane,
  openChanges,
  pagePins,
  screenshotsInFlight,
  screenshotsSettled,
  selectAnnotation,
  setAppMode,
  shotSrc,
  shotTitle,
  submitUiComposer,
  toggleAnnotations,
  uiSendSummary,
  waitingQuestions,
} from "./uilane";
import { cursorReset, cursorSelection, invalidateCursorRows } from "./cursor";
import { openRequests, stepOpenRequest } from "./requests";
import { uuid } from "./uuid";
import type { ReviewState, FileRow, Settings, DiffStyle, Store } from "./types";

// Close the inline composer when clicking outside it (unless it has unsaved text). The
// composer/editor live inside the diff DOM now, so match their containers directly.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!S.composerOpen) return;
    const target = e.target as HTMLElement;
    if (target.closest?.(".composer-card, .msg-edit")) return;
    // Defer the closing render: this fires on pointerdown, before the click reaches a diff
    // control (Keep/Undo/Reply). Rendering now rebuilds the diff and destroys that control,
    // so the browser drops the pending click and the user's press is swallowed.
    closeComposerIfEmpty(true);
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
S.selectFile = async (i) => {
  if (i < 0 || !S.state.files[i]) return; // ignore out-of-range selections
  // Narrow-width drawer: opening a file is the drawer's whole purpose, so get it out of the
  // way. The single funnel for tree/walkthrough clicks + next/prev + guide nav; no-op when shut.
  S.treeDrawerOpen = false;
  S.overviewOpen = false;
  S.view = "code"; // like the Overview, the UI view is an alternate centre a file selection leaves
  S.preview = null;
  S.diffScrolled = false; // the new file renders at the top (see render.ts) — hide the floating action
  S.fileIndex = i;
  S.fileView = defaultFileView(S.state.files[i]);
  D.fileDiff = null;
  cursorReset(); // re-init the line cursor to the new file's first change
  // Move the sidebar highlight in place — switching files no longer rebuilds the row lists
  // (the "active" class left the row models; see applyActiveRow in tree.ts).
  applyActiveRow();
  const rendered = deferRender();
  // Quietly warm the next file in review order (guide order when guided, else tree order — the
  // exact resolution keyboard nav uses) so the common next-file step never waits on the wire.
  const n = nextFileIndex(i);
  if (n !== null) prefetchContents(S.state.files[n]);
  await rendered;
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
    // A preview is UI-only (never persisted/wired), so it carries its single contents inline via
    // previewContents (old === new → no diff). contentHash is unused (previews are never approved).
    S.preview = {
      path,
      hunks: [],
      contentHash: "",
      changeKind: "modified",
      added: 0,
      removed: 0,
      previewContents: r.contents,
    };
    D.fileDiff = null;
    cursorReset();
    await render();
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
S.toggleSkimGroup = toggleSkimGroup;
// Tree / Walkthrough tab (the tab buttons and `w`): the list it shows may not have been visible
// when the active file last changed, so scroll it to the active row. A frame late: x-show reveals
// on a timer queued in Alpine's flush, which the next frame can beat — the list must be laid out
// before showActiveRow measures it.
S.setSidebarTab = (tab) => {
  S.sidebarTab = tab;
  requestAnimationFrame(showActiveRow);
};
S.rowClick = (r) => {
  if (r.kind === "skimgrp") S.toggleSkimGroup?.();
  else if (r.kind === "dir") S.toggleDir?.(r.full, r.changed);
  else if (r.fileIndex !== undefined) S.selectFile?.(r.fileIndex);
  else S.previewFile?.(r.path);
};
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
// A double-click's second click would undo the sign-off its first one made. The hint re-reads at
// once: the pointer is still on the icon, which now does the opposite.
S.statusClick = (path, e) => {
  if (e.detail < 2) toggleSignOff(path);
  if (e.currentTarget instanceof HTMLElement) S.statusHint?.(e.currentTarget, path);
};
// The label is read when the icon is hovered or focused: binding it per row would rescan every
// decision and comment for every row (see flow-index.ts). data-act tints the icon on hover with the
// state a click leads to.
S.statusHint = (el, path) => {
  const act = fileFinished(path) ? "reset" : fileObjections(path) ? "mark" : "approve";
  el.dataset.act = act;
  el.title = { approve: "Approve", mark: "Mark reviewed", reset: "Reset review" }[act];
  el.setAttribute("aria-label", el.title);
};
S.runToastAction = runToastAction;
// Apply + persist all settings: CSS vars (font/size), comment-code theme, and a re-render
// (the diff reads S.settings.* in render()). Bound to every control's @change.
S.applySettings = () => {
  persistPrefs();
  applyAppearance(S.settings);
  // applyAppearance first: setMarkdownTheme's diff-only fallback reads <html data-theme>.
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
  // Off the last file, wrap to the first unreviewed file (else cycle to the first) instead
  // of dead-ending, so skipped files are surfaced.
  const n = nextFileIndex(S.fileIndex);
  const target = n !== null ? n : nextWrapIndex();
  if (target !== null) S.selectFile?.(target);
};
S.guidePrev = () => {
  // Stepping back from the Overview (the position before the first file) wraps to the end —
  // the last unreviewed file, else the last file.
  if (S.overviewOpen) {
    const w = prevWrapIndex();
    if (w !== null) S.selectFile?.(w);
    return;
  }
  // Off the first file, drop to the Overview (unchanged); the wrap happens from there.
  const p = prevFileIndex(S.fileIndex);
  if (p === null) S.openOverview?.();
  else S.selectFile?.(p);
};
// The nav buttons dim only when the review is fully signed off (nothing left to wrap to) —
// while unreviewed work remains, next/prev stay live because they now seek it.
S.guideAtStart = () => !!S.overviewOpen && !anyUnreviewed();
S.guideAtLast = () => !S.overviewOpen && nextFileIndex(S.fileIndex) === null && !anyUnreviewed();
// Review-order file stepping (⇧←/⇧→) — guide order when guided (or on the Overview), else the
// Files tree's top-to-bottom order (see nextFileIndex).
S.nextFile = () => {
  if (hasGuide() || S.overviewOpen) {
    S.guideNext?.();
    return;
  }
  // Off the last file, wrap to the first unreviewed file (else the first file).
  const target = nextFileIndex(S.fileIndex) ?? nextWrapIndex();
  if (target !== null) S.selectFile?.(target);
};
S.prevFile = () => {
  if (hasGuide() || S.overviewOpen) {
    S.guidePrev?.();
    return;
  }
  // Off the first file, wrap to the last unreviewed file (else the last file). Without a guide
  // there's no Overview to step back into, so the wrap applies straight from the first file.
  const target = prevFileIndex(S.fileIndex) ?? prevWrapIndex();
  if (target !== null) S.selectFile?.(target);
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
// The top bar's count of open change requests; a click steps to the next, as `]` does.
S.openRequests = openRequests;
S.nextRequest = () => stepOpenRequest(1);
// Keyboard help overlay + destructive-action confirm dialog (keys.ts owns the dialog state).
S.helpGroups = helpGroups;
S.confirmYes = confirmYes;
S.confirmNo = confirmNo;
// Pluralize a count with its noun: plural(1, "file") → "1 file", plural(3, "file") → "3 files".
const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
// Open the Send modal: a receipt of what's about to go, plus an empty (always fresh) note box.
// An attached agent picks the review up the instant it's sent, so there's no taking it back —
// this is the moment to look, and to leave an overall instruction for the whole review.
const openSendModal = (msg: string, lanes: Store["sendLanes"] = null) => {
  S.sendMsg = msg;
  S.sendLanes = lanes;
  S.sendNote = "";
  S.sendOpen = true;
  setTimeout(() => $("sendNote")?.focus(), 0); // after Alpine shows it (mirrors the composer)
};
// With a UI lane the receipt splits by lane: the code line (none on a UI-only desk) and the UI one.
const codeReceipt = () => {
  const { files, lines, comments, rejections } = reviewStats();
  return [
    plural(files, "file"),
    plural(lines, "changed line"),
    comments ? plural(comments, "comment") : "",
    rejections ? plural(rejections, "rejected hunk") : "",
  ]
    .filter(Boolean)
    .join(", ");
};
const sendLanes = (): Store["sendLanes"] =>
  hasUi() ? { code: uiOnly() ? null : codeReceipt(), ...uiSendSummary() } : null;
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
    sendLanes(),
  );
};
// Every manual send — the Send button and ⇧S — routes through this receipt-style modal: a
// glance at what's about to go (files, lines, comments, rejections) before the one-way handoff.
// (The button used to call send() directly with no confirm at all, which made accidental sends
// too easy.)
S.confirmSend = () => {
  if (hasUi()) {
    openSendModal("You're about to send your review. Send to the agent?", sendLanes());
    return;
  }
  openSendModal(`You're about to send your review: ${codeReceipt()}. Send to the agent?`);
};
// Confirm the Send modal: the typed note (trimmed; empty → omitted) rides along as the one-time
// overall instruction. Cancel leaves the review untouched. New annotations' screenshots still being
// captured or uploaded go too if they land within SHOTS_WAIT_MS, while the dialog says so; past
// it, those annotations go without them, as when a capture fails.
const SHOTS_WAIT_MS = 15_000;
let sendWait = 0;
S.sendConfirm = async () => {
  if (S.sendFinishing) return;
  const note = S.sendNote.trim();
  if (screenshotsInFlight()) {
    const wait = ++sendWait;
    S.sendFinishing = true;
    await screenshotsSettled(SHOTS_WAIT_MS);
    // Cancelled while it waited, and maybe confirmed again since.
    if (wait !== sendWait || !S.sendFinishing) return;
    S.sendFinishing = false;
  }
  S.sendOpen = false;
  S.send?.(note);
};
S.sendCancel = () => {
  S.sendOpen = false;
  S.sendNote = "";
  S.sendFinishing = false;
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
  await openEditorAt(file.path, sel ? fromDisplayLine(sel.side, sel.lineNumber) : 1);
};
// New comments carry an intent: "question" (Ask — pushed to the agent now via /api/ask,
// answered live) or "action" (Request change — goes back on Send). Editing just updates the
// body and keeps the existing intent; turning the thread's opening comment changes it (turnComment).
const submitComment = (intent: "question" | "action") => {
  // The UI lane's composers (a new annotation, a reply or edit in its thread) submit there.
  if (composerInUi()) {
    submitUiComposer(intent);
    return;
  }
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
  // Anchor text comes from the current file's fetched contents (contents.ts `cur`, loaded by the
  // render of this file). It's best-effort — the server re-derives its own anchorText on reload —
  // so if cur isn't this file yet, leave it undefined rather than snapshot the wrong file's line.
  const contents =
    cur.path === file.path ? (side === "deletions" ? cur.oldContents : cur.newContents) : undefined;
  const c = {
    id: uuid(),
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
    void askComment(c.id);
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
  // Post only the reviewer-owned slice — never the whole (multi-MB) ReviewState. Big desks
  // used to cross the server's body cap on Send and 500 ("Could not send review") while the
  // slice-only auto-saves kept succeeding; the server merges this slice and builds the
  // result from its own authoritative state. overallNote is a one-time instruction for the
  // whole review; the server reads it off the body and never persists it (see /api/send).
  const r = await api<{ sent?: boolean }>("/api/send", {
    method: "POST",
    body: JSON.stringify({ ...reviewerSlice(S.state), seen: saveStamp(), overallNote }),
  });
  if (r && r.sent) {
    S.awaitingAgent = true;
    toast("Sent to agent");
  } else toast("Could not send review");
};

// The UI lane: the Code / UI switch and the chrome bar over the proxied app (appview.ts).
S.hasUi = hasUi;
S.uiOnly = uiOnly;
S.setView = setView;
S.appHost = appHost;
S.appBack = appBack;
S.appForward = appForward;
S.appRefresh = appRefresh;
S.appGo = appGo;
S.setViewport = setViewport;
// Its annotations (uilane.ts): the mode toggle, the page annotation button and the address bar's
// page pins, the sidebar, the header's open and waiting counts, and the enlarged screenshot.
S.setAppMode = setAppMode;
S.annotatePage = annotatePage;
S.pagePins = pagePins;
S.selectAnnotation = selectAnnotation;
S.toggleAnnotations = toggleAnnotations;
S.openChanges = openChanges;
S.waitingQuestions = waitingQuestions;
S.closeShot = closeShot;
S.shotSrc = shotSrc;
S.shotTitle = shotTitle;

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
refreshBaseTitle();
S.selected = {
  side: S.state.changes[0]?.side || "additions",
  lineNumber: S.state.changes[0]?.lineNumber || 1,
};
// Without a guide, open on the first file in review order — the Files tree's top row — not the
// first in the diff's own order, which can sit near the tree's bottom and make the first approve
// wrap to the top. (A guided desk opens on the Overview; a reload keeps the reviewer's file.)
if (!hasGuide()) S.fileIndex = navOrder()[0] ?? 0;
if (S.state.files[S.fileIndex]) S.fileView = defaultFileView(S.state.files[S.fileIndex]);
// With a guide attached, land on the Overview page (the guided entry point) and open the
// sidebar on the user's preferred pane (`w` toggles it per-session from there).
if (hasGuide()) {
  S.overviewOpen = true;
  S.sidebarTab = S.settings.sidebarDefault === "walkthrough" ? "walkthrough" : "tree";
}
installAppView();
installUiLane();
installCaptureDebug();
syncView(); // a UI-only desk opens straight on the app
void render().finally(firstRenderDone);
// Alpine reveals an x-show element on the next animation frame; lift the gate in that frame too,
// so the lane chrome appears at once.
requestAnimationFrame(() => (S.ready = true));
// Reveal the floating Approve button once the diff scrolls past its (non-sticky) header. #diff
// is the persistent scroll container (x-ignore), so this listener is attached once and survives
// every re-render/file switch.
$("diff").addEventListener("scroll", () => {
  S.diffScrolled = $("diff").scrollTop > 140;
});
// A resize reflows line heights (and wrap), so the cursor's cached row measurements no longer
// hold — drop the cache so the next navigation re-measures. (Scroll doesn't: the cached tops are
// content-relative, so scrolling leaves the row list unchanged — see cursor.ts.)
window.addEventListener("resize", invalidateCursorRows);
setInterval(pollState, 1500);
