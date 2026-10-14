import "./styles/index.css";
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
  rowAnchor,
  selectionAnchor,
  fileFinished,
  fileObjections,
  flowIndex,
} from "./changes";
import { agentPresence, deskSubtitle, deskTitle, unansweredAsks } from "./topbar-derive";
import { toggleSignOff } from "./decisions";
import { installBlockers } from "./blockers";
import { closeComposerIfEmpty } from "./selection";
import { applyActiveRow, showActiveRow, treeRows, allDirPaths, touchedDirPaths } from "./tree";
import { toggleSkimGroup } from "./skim";
import { resetFolds } from "./fold";
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
  firstGuideStep,
  navSteps,
  currentStep,
  nextStep,
  prevStep,
  nextWrapStep,
  prevWrapStep,
  reviewTally,
  stepSlot,
  walkthroughRows,
} from "./guide";
import { installProgress, refreshBaseTitle, reviewStats } from "./progress";
import { installKeys, helpGroups, confirmYes, confirmNo } from "./keys";
import { renderKeycaps } from "./keycaps";
import { installTooltips } from "./tooltip";
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
  pagePins,
  screenshotsInFlight,
  screenshotsSettled,
  selectAnnotation,
  setAppMode,
  shotSrc,
  shotTitle,
  submitUiComposer,
  uiSendSummary,
  unplacedPins,
} from "./uilane";
import { cursorReset, cursorSelection, invalidateCursorRows } from "./cursor";
import { updateAwaitingDom } from "./annotations";
import { threadKey } from "./rests";
import { openRequest, requestRows } from "./requests";
import { uuid } from "./uuid";
import type { Step } from "./steps";
import type { ChangeState, ReviewState, FileRow, Settings, DiffStyle, Store } from "./types";

// Close the inline composer when clicking outside it (unless it has unsaved text). The
// composer/editor live inside the diff DOM now, so match their containers directly.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!S.composerOpen) return;
    const target = e.target as HTMLElement;
    if (target.closest?.(".composer-card, .msg-edit, .thread-card.k-new")) return;
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

// Crossing the drawer breakpoint moves the tree between its docked column and the off-canvas
// drawer (styles/responsive.css). That isn't the drawer opening or closing, so it mustn't play the
// drawer's slide: the docked tree would sweep out across the canvas for a beat.
matchMedia("(max-width: 1100px)").addEventListener("change", () => {
  const tree = document.querySelector<HTMLElement>(".tree");
  if (!tree) return;
  tree.classList.add("no-slide");
  void tree.offsetWidth; // commit the move with transitions off
  tree.classList.remove("no-slide");
});

// Keyboard shortcuts: a central scope-aware dispatcher (keys.ts) is the single source of truth.
installKeys();
installTooltips();
installBlockers();
installProgress();

// Store methods the reactive chrome calls ($store.g.*)
S.treeRows = treeRows;
// Update the lightweight state synchronously (so the tree's active row repaints
// immediately — the click feels instant), then run the heavier diff render via deferRender,
// which shows the "Rendering…" indicator only for a cold open of a big file. A step is a file, or
// one part of a file the guide splits (steps.ts); the Files tree opens files whole (selectFile).
const selectStep = async ({ fileIndex: i, part }: Step) => {
  if (i < 0 || !S.state.files[i]) return; // ignore out-of-range selections
  // Narrow-width drawer: opening a file is the drawer's whole purpose, so get it out of the
  // way. The single funnel for tree/walkthrough clicks + next/prev + guide nav; no-op when shut.
  S.treeDrawerOpen = false;
  S.overviewOpen = false;
  S.view = "code"; // like the Overview, the UI view is an alternate centre a file selection leaves
  S.preview = null;
  S.fileIndex = i;
  S.stepPart = part;
  S.fileView = defaultFileView(S.state.files[i]);
  D.fileDiff = D.rawFileDiff = null;
  resetFolds(); // re-opening a part starts with other parts' hunks folded
  cursorReset(); // re-init the line cursor to the new file's first change
  // Move the sidebar highlight in place — switching files no longer rebuilds the row lists
  // (the "active" class left the row models; see applyActiveRow in tree.ts).
  applyActiveRow();
  const rendered = deferRender();
  // Quietly warm the next step's file in review order (guide order when guided, else tree order —
  // the exact resolution keyboard nav uses) so the common next step never waits on the wire.
  const n = nextStep(currentStep());
  if (n !== null) prefetchContents(S.state.files[n.fileIndex]);
  await rendered;
};
S.selectStep = selectStep;
S.selectFile = (i) => selectStep({ fileIndex: i });
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
    D.fileDiff = D.rawFileDiff = null;
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
// Review / Files tab (the tab buttons and `w`): the list it shows may not have been visible
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
  D.fileDiff = D.rawFileDiff = null;
  return render();
};
// Where a step's sign-off stands, for the status icons: finished, else with objections
// ("changes") or without ("clean"). A whole file (`blocks` null) reads the one-file predicates; a
// part or Rest step its own blocks (flow-index stepFinished/stepObjections).
function signOffStand(path: string, blocks: ChangeState[] | null) {
  if (!blocks) return fileFinished(path) ? "finished" : fileObjections(path) ? "changes" : "clean";
  const ix = flowIndex();
  if (ix.stepFinished({ path, blocks })) return "finished";
  return ix.stepObjections({ path, blocks }) ? "changes" : "clean";
}
// A double-click's second click would undo the sign-off its first one made. The hint re-reads at
// once: the pointer is still on the icon, which now does the opposite. A Walkthrough row passes
// its step's part, so a part's icon signs off (or resets) that part alone.
S.statusClick = (path, e, part) => {
  if (e.detail < 2) toggleSignOff(path, part);
  if (e.currentTarget instanceof HTMLElement) S.statusHint?.(e.currentTarget, path, part);
};
// The label is read when the icon is hovered or focused: binding it per row would rescan every
// decision and comment for every row (see flow-index.ts). data-act tints the icon on hover with the
// state a click leads to.
S.statusHint = (el, path, part) => {
  const fileIndex = S.state.files.findIndex((f) => f.path === path);
  const blocks = part === undefined ? null : (stepSlot({ fileIndex, part })?.blocks ?? null);
  const stand = signOffStand(path, blocks);
  const act = stand === "finished" ? "reset" : stand === "changes" ? "mark" : "approve";
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
// Guided review: ⌂ returns to the Overview page; Start enters the step-by-step flow at the
// first step in the guide's order.
S.hasGuide = hasGuide;
S.openOverview = () => {
  S.overviewOpen = true;
  render();
};
S.startGuided = () => {
  S.overviewOpen = false;
  S.selectStep?.(firstGuideStep());
};
// Guided navigation: the Overview is the position before the first step. From it, Next
// enters the first step and Prev is a no-op; within steps, Prev off the first → Overview.
S.guideNext = () => {
  if (S.overviewOpen) {
    S.startGuided?.();
    return;
  }
  // Off the last step, wrap to the first unreviewed step (else cycle to the first) instead
  // of dead-ending, so skipped steps are surfaced.
  const target = nextStep(currentStep()) ?? nextWrapStep();
  if (target !== null) S.selectStep?.(target);
};
S.guidePrev = () => {
  // Stepping back from the Overview (the position before the first step) wraps to the end —
  // the last unreviewed step, else the last step.
  if (S.overviewOpen) {
    const w = prevWrapStep();
    if (w !== null) S.selectStep?.(w);
    return;
  }
  // Off the first step, drop to the Overview (unchanged); the wrap happens from there.
  const p = prevStep(currentStep());
  if (p === null) S.openOverview?.();
  else S.selectStep?.(p);
};
// Review-order stepping (⇧←/⇧→) — guide order when guided (or on the Overview), else the
// Files tree's top-to-bottom order (see nextStep).
S.nextFile = () => {
  if (hasGuide() || S.overviewOpen) {
    S.guideNext?.();
    return;
  }
  // Off the last file, wrap to the first unreviewed file (else the first file).
  const target = nextStep(currentStep()) ?? nextWrapStep();
  if (target !== null) S.selectStep?.(target);
};
S.prevFile = () => {
  if (hasGuide() || S.overviewOpen) {
    S.guidePrev?.();
    return;
  }
  // Off the first file, wrap to the last unreviewed file (else the last file). Without a guide
  // there's no Overview to step back into, so the wrap applies straight from the first file.
  const target = prevStep(currentStep()) ?? prevWrapStep();
  if (target !== null) S.selectStep?.(target);
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
// The sidebar's Change requests list; a row goes to its request, as `]` / `[` landing on it do.
S.openRequest = openRequest;
// The top bar: what is under review, the agent's presence, and whether Send Review is the next
// step.
S.deskTitle = () => (S.state ? deskTitle(S.state) : "");
S.deskSubtitle = () => (S.state ? deskSubtitle(S.state, uiOnly()) : "");
// Presence and the open change requests walk every comment and the done state builds the flow
// index, so one effect derives them once per change into the store, rather than every binding
// re-deriving them. The review is
// done when every in-flow step is signed off and current (reviewTally), the same count that opens
// the Send sheet after the last approval, so Send never turns primary short of it. A desk with no
// files (UI-only) has no code review to complete.
let shownPresence = S.presence;
Alpine.effect(() => {
  const presence = agentPresence({
    awaitingAgent: S.awaitingAgent,
    queuedReviews: S.queuedReviews,
    queuedQuestions: S.queuedQuestions,
    activity: S.agentActivity,
    unansweredAsks: unansweredAsks(S.state?.comments ?? [], S.state?.annotations ?? []),
  });
  if (presence.kind !== shownPresence.kind || presence.line !== shownPresence.line)
    S.presence = shownPresence = presence;
  const tally = reviewTally();
  S.reviewDone = !!S.state?.files.length && tally.done === tally.total;
  S.requests = requestRows();
});
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
  await openEditorAt(file.path, sel ? rowAnchor(sel.side, sel.lineNumber).line : 1);
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
  const {
    side,
    line: lineNumber,
    endLine,
  } = selectionAnchor(S.selected.side, S.selected.lineNumber, S.selected.endLine);
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
    endLine,
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
  // The thread just written in stays open as its card (a new one opens), so the reviewer sees
  // what they sent and what comes back.
  S.openThread = threadKey(c);
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
    D.fileDiff = D.rawFileDiff = null;
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
    // The change requests went with it: their held bands go now, not on the next poll.
    updateAwaitingDom();
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
// Its annotations (uilane.ts): the mode toggle, the page annotation button, the address bar's page
// pins and the stage's Unplaced tray, a pin's card, and the enlarged screenshot.
S.setAppMode = setAppMode;
S.annotatePage = annotatePage;
S.pagePins = pagePins;
S.unplacedPins = unplacedPins;
S.selectAnnotation = selectAnnotation;
S.closeShot = closeShot;
S.shotSrc = shotSrc;
S.shotTitle = shotTitle;

// Alpine: register the reactive store, then start.
(window as any).Alpine = Alpine;
// x-keys draws a shortcut as keycaps: the expression's combo, or else the element's own text.
Alpine.directive("keys", (el, { expression }, { evaluateLater, effect }) => {
  if (!expression) return renderKeycaps(el, el.textContent ?? "");
  const combo = evaluateLater<string>(expression);
  effect(() => combo((c) => renderKeycaps(el, String(c ?? ""))));
});
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
if (!hasGuide()) S.fileIndex = navSteps()[0]?.fileIndex ?? 0;
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
// A resize of the diff — the window's, or a sidebar drag's — reflows line heights (and wrap), so
// the cursor's cached row measurements no longer hold: drop the cache so the next navigation
// re-measures. (Scroll doesn't: the cached tops are content-relative, so scrolling leaves the row
// list unchanged — see cursor.ts.)
new ResizeObserver(invalidateCursorRows).observe($("diff"));
setInterval(pollState, 1500);
