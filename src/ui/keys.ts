import { S } from "./store";
import { hasGuide } from "./guide";
import { approveCurrentStep } from "./decisions";
import { isOversizedPlaceholder, loadOversizedDiff } from "./oversized";
import { closeComposer, composerInUi } from "./composer";
import { hasUi, toggleView, uiOnly } from "./appview";
import {
  annotatePage,
  clearPendingPicks,
  closeShot,
  selectAnnotation,
  setAppMode,
  stepAnnotation,
  toggleAppMode,
} from "./uilane";
import { stepOpenRequest } from "./requests";
import { closeBlockers } from "./blockers";
import { closeGuideCard } from "./guidecard";
import { closeThreadCard, cursorToComposingThread } from "./rests";
import type { ForwardedKey } from "./types";
import {
  cursorMoveLine,
  cursorMoveHunk,
  cursorComment,
  cursorVerdict,
  cursorResolve,
  cursorReset,
  cursorSelection,
  golineActive,
  golineDigit,
  golineCommit,
  golineCancel,
} from "./cursor";

// ── Central keyboard map ─────────────────────────────────────────────────────
// One ordered table is the single source of truth: the dispatcher runs the first binding whose
// key matches and whose scope is active, and the ? help overlay renders from the same table — so
// hints can never drift from behavior. Scopes keep a key meaning the right thing in context.

type Group = "Navigate" | "Review" | "Comment" | "View" | "UI" | "App";
type Hotkey = {
  combo: string;
  desc: string;
  group: Group;
  test: (e: KeyboardEvent) => boolean;
  run: (e: KeyboardEvent) => void;
  when?: () => boolean; // scope guard (default: anywhere not typing)
  typing?: boolean; // also fires while typing in the composer
  hide?: boolean; // omit from the help overlay
  enabled?: () => boolean; // false when a setting switches it off: it neither runs nor shows in help
  goline?: boolean; // part of the go-to-line gesture — doesn't cancel a pending digit buffer
};

// Scopes
const inComposer = () => S.composerOpen;
const inModal = () => S.settingsOpen || !!S.confirmMsg || S.sendOpen || !!S.shotView;
const inOverview = () => !!S.overviewOpen && hasGuide();
// The UI view (the proxied app) takes over the centre: diff and file bindings stand down there.
const inUiView = () => S.view === "ui";
const inDiff = () => !inComposer() && !inModal() && !inOverview() && !inUiView();
const navigable = () => !inComposer() && !inModal();
const inCode = () => navigable() && !inUiView();
const isMd = () => inDiff() && !!S.isMarkdownFile?.();

// Key matchers
const k = (key: string) => (e: KeyboardEvent) =>
  e.key === key && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
const enter = (e: KeyboardEvent) =>
  e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
const shift = (key: string) => (e: KeyboardEvent) =>
  e.key === key && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
const cmd = (key: string) => (e: KeyboardEvent) =>
  e.key === key && (e.metaKey || e.ctrlKey) && !e.shiftKey;
const cmdShift = (key: string) => (e: KeyboardEvent) =>
  e.key === key && (e.metaKey || e.ctrlKey) && e.shiftKey;

// Esc cascade: close the topmost transient surface.
function escape() {
  if (golineActive()) {
    golineCancel();
    return;
  }
  if (S.confirmMsg) {
    S.confirmMsg = "";
    return;
  }
  if (S.sendOpen) {
    S.sendCancel?.();
    return;
  }
  if (S.settingsOpen) {
    S.settingsOpen = false;
    return;
  }
  if (S.shotView) {
    closeShot();
    return;
  }
  // The open pin card over the app, unless a composer in it is open: that goes first, then the card.
  if (inUiView() && S.selectedAnnotation && !(S.composerOpen && composerInUi())) {
    selectAnnotation(null);
    return;
  }
  // The popovers over the code: above everything in it, below the dialogs (which close the
  // blockers list as they open — see installBlockers). Then the guide card opened over the code.
  if (closeBlockers()) return;
  if (closeGuideCard()) return;
  // An expanded resolved card, once its composer (below) has closed: Esc closes a reply first.
  if (!S.composerOpen && !S.editingCommentId && closeThreadCard()) return;
  if (S.composerOpen || S.editingCommentId) {
    // A code composer also drops the line highlight it was anchored to, unless it's a reply or an
    // edit in a thread's card: the cursor goes to the card's line, where r, ↵ and c act on it.
    if (!composerInUi() && !cursorToComposingThread()) cursorReset();
    closeComposer(); // rebuilds the lane so the inline composer's DOM goes away
    return;
  }
  // The UI view unwinds ⇧-picks waiting for ⇧'s release first, then Annotate.
  if (inUiView() && S.appMode === "annotate" && S.pendingPicks) {
    clearPendingPicks();
    return;
  }
  if (inUiView() && S.appMode === "annotate") {
    setAppMode("interact");
    return;
  }
  // A lone line selection (keyboard cursor, or a click that left the highlight without an open
  // surface): Esc clears it. Below the surfaces above so Esc dismisses a composer/modal first.
  if (cursorSelection()) {
    cursorReset();
    return;
  }
  // Lowest priority: the narrow-width file drawer. Closes only once every transient surface
  // above it is gone, so Esc dismisses a composer/modal opened over the drawer first.
  if (S.treeDrawerOpen) S.treeDrawerOpen = false;
}

// Stage a destructive action behind a confirm dialog (Enter confirms, Esc cancels).
let pending: (() => void) | null = null;
export function askConfirm(msg: string, run: () => void) {
  S.confirmMsg = msg;
  pending = run;
}
export function confirmYes() {
  const run = pending;
  S.confirmMsg = "";
  pending = null;
  run?.();
}
export function confirmNo() {
  S.confirmMsg = "";
  pending = null;
}

const HOTKEYS: Hotkey[] = [
  // Confirm dialog (⇧R / ⇧S / ⇧A): Enter accepts (Esc cancels via the escape cascade). First so
  // it wins over any plain-key binding while the dialog is up.
  {
    combo: "↵",
    desc: "Confirm",
    group: "App",
    test: enter,
    when: () => !!S.confirmMsg,
    run: confirmYes,
    hide: true,
  },
  // Send modal: ⌘↵ sends (typing:true — focus is in the note box). Plain Enter has no matching
  // typing hotkey, so it falls through to a textarea newline; Esc cancels via the escape cascade.
  {
    combo: "⌘↵",
    desc: "Send to agent",
    group: "App",
    test: cmd("Enter"),
    when: () => S.sendOpen,
    typing: true,
    run: () => S.sendConfirm?.(),
    hide: true,
  },
  // Navigate
  {
    combo: "⇧→",
    desc: "Next file (review order)",
    group: "Navigate",
    test: shift("ArrowRight"),
    when: inCode,
    run: () => S.nextFile?.(),
  },
  {
    combo: "⇧←",
    desc: "Previous file (review order)",
    group: "Navigate",
    test: shift("ArrowLeft"),
    when: inCode,
    run: () => S.prevFile?.(),
  },
  {
    combo: "⌘⇧↓",
    desc: "Next file (tree order)",
    group: "Navigate",
    test: cmdShift("ArrowDown"),
    when: inCode,
    run: () => S.treeStep?.(1),
  },
  {
    combo: "⌘⇧↑",
    desc: "Previous file (tree order)",
    group: "Navigate",
    test: cmdShift("ArrowUp"),
    when: inCode,
    run: () => S.treeStep?.(-1),
  },
  {
    combo: "⇧↓",
    desc: "Next change",
    group: "Navigate",
    test: shift("ArrowDown"),
    when: inDiff,
    run: () => cursorMoveHunk(1),
  },
  {
    combo: "⇧↑",
    desc: "Previous change",
    group: "Navigate",
    test: shift("ArrowUp"),
    when: inDiff,
    run: () => cursorMoveHunk(-1),
  },
  // Across both views: the walk switches to the one its next request is in.
  {
    combo: "]",
    desc: "Next open change request",
    group: "Navigate",
    test: k("]"),
    when: navigable,
    run: () => stepOpenRequest(1),
  },
  {
    combo: "[",
    desc: "Previous open change request",
    group: "Navigate",
    test: k("["),
    when: navigable,
    run: () => stepOpenRequest(-1),
  },
  {
    combo: "↑",
    desc: "Move up a line",
    group: "Navigate",
    test: k("ArrowUp"),
    when: inDiff,
    run: () => cursorMoveLine(-1),
  },
  {
    combo: "↓",
    desc: "Move down a line",
    group: "Navigate",
    test: k("ArrowDown"),
    when: inDiff,
    run: () => cursorMoveLine(1),
  },
  {
    combo: "j",
    desc: "Next change",
    group: "Navigate",
    test: k("j"),
    when: inDiff,
    run: () => cursorMoveHunk(1),
    hide: true,
  },
  {
    combo: "k",
    desc: "Previous change",
    group: "Navigate",
    test: k("k"),
    when: inDiff,
    run: () => cursorMoveHunk(-1),
    hide: true,
  },
  {
    combo: "1–9",
    desc: "Go to a line (type its number)",
    group: "Navigate",
    test: (e) => /^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey,
    when: inDiff,
    run: (e) => golineDigit(e.key),
    goline: true,
  },
  {
    combo: "o",
    desc: "Overview",
    group: "Navigate",
    test: k("o"),
    when: () => hasGuide() && inCode(),
    run: () => S.openOverview?.(),
  },
  {
    combo: "↵",
    desc: "Start review",
    group: "Navigate",
    test: enter,
    when: inOverview,
    run: () => S.startGuided?.(),
  },
  // Goline commit must outrank "comment on line" while digits are pending — same key, same scope.
  {
    combo: "↵",
    desc: "Jump to typed line",
    group: "Navigate",
    test: enter,
    when: () => inDiff() && golineActive(),
    run: () => golineCommit(),
    goline: true,
    hide: true,
  },
  // On an oversized-file placeholder card there's no line to comment on — ↵ loads the real diff
  // instead. More specific than the plain-↵ comment binding below, so it wins in that one scope.
  {
    combo: "↵",
    desc: "Load diff anyway (large file)",
    group: "Review",
    test: enter,
    when: () => inDiff() && isOversizedPlaceholder(),
    run: () => loadOversizedDiff(),
  },
  // Comment
  {
    combo: "↵",
    desc: "Comment / reply on line",
    group: "Comment",
    test: enter,
    when: inDiff,
    run: () => cursorComment(),
  },
  {
    combo: "c",
    desc: "Comment on line",
    group: "Comment",
    test: k("c"),
    when: inDiff,
    run: () => cursorComment(),
    hide: true,
  }, // alias for ↵
  {
    combo: "r",
    desc: "Resolve / reopen thread",
    group: "Comment",
    test: k("r"),
    when: inDiff,
    run: () => cursorResolve(),
  },
  {
    combo: "⌘↵",
    desc: "Submit comment (Request change)",
    group: "Comment",
    test: cmd("Enter"),
    when: inComposer,
    typing: true,
    run: () => S.saveComment?.(),
  },
  {
    combo: "⌘⇧↵",
    desc: "Submit as question (Ask)",
    group: "Comment",
    test: cmdShift("Enter"),
    when: () => inComposer() && !S.editingCommentId,
    typing: true,
    run: () => S.ask?.(),
  },
  // Review
  {
    combo: "⇧Y",
    desc: "Accept change (Keep)",
    group: "Review",
    test: shift("Y"),
    when: inDiff,
    enabled: () => S.settings.perChangeVerdicts,
    run: () => cursorVerdict("accepted"),
  },
  {
    combo: "⇧N",
    desc: "Reject change (Undo)",
    group: "Review",
    test: shift("N"),
    when: inDiff,
    enabled: () => S.settings.perChangeVerdicts,
    run: () => cursorVerdict("rejected"),
  },
  // View
  {
    combo: "v",
    desc: "Unified / Split",
    group: "View",
    test: k("v"),
    when: inDiff,
    run: () => S.setStyle?.(S.diffStyle === "split" ? "unified" : "split"),
  },
  {
    combo: "m",
    desc: "Rendered / source (markdown)",
    group: "View",
    test: k("m"),
    when: isMd,
    run: () => S.setFileView?.(S.fileView === "rendered" ? "source" : "rendered"),
  },
  {
    combo: "w",
    desc: "Review / Files sidebar",
    group: "View",
    when: () => hasGuide() && inCode(),
    test: k("w"),
    run: () => S.setSidebarTab?.(S.sidebarTab === "tree" ? "walkthrough" : "tree"),
  },
  {
    combo: "⇧U",
    desc: "Code / App view",
    group: "View",
    // Only with both lanes. From inside the app it arrives only while annotating (dispatchKey).
    when: () => navigable() && hasUi() && !uiOnly(),
    test: shift("U"),
    // Called through an arrow: appview and uilane import this module back, so their exports
    // aren't initialised yet while this table is built.
    run: () => toggleView(),
  },
  // UI view: the app's mode, annotating the page, and stepping through annotations. ⌥A and ⇧
  // chords pressed in the app arrive here too: the bridge forwards them (dispatchKey).
  {
    combo: "⌥A",
    desc: "Interact / Annotate",
    group: "UI",
    // By code, not key: ⌥A types "å" on a Mac keyboard.
    test: (e) => e.code === "KeyA" && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey,
    when: () => inUiView() && !inModal(),
    run: () => toggleAppMode(),
  },
  {
    combo: "⌥P",
    desc: "Annotate the whole page",
    group: "UI",
    // By code, not key: ⌥P types "π" on a Mac keyboard. From inside the app it arrives only while
    // annotating (dispatchKey).
    test: (e) => e.code === "KeyP" && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey,
    when: () => inUiView() && !inModal(),
    run: () => annotatePage(),
  },
  {
    combo: "⇧↓",
    desc: "Next annotation",
    group: "UI",
    test: shift("ArrowDown"),
    when: () => inUiView() && navigable(),
    run: () => stepAnnotation(1),
  },
  {
    combo: "⇧↑",
    desc: "Previous annotation",
    group: "UI",
    test: shift("ArrowUp"),
    when: () => inUiView() && navigable(),
    run: () => stepAnnotation(-1),
  },
  {
    combo: "⇧B",
    desc: "Collapse sidebar (the drawer on narrow screens)",
    group: "View",
    when: () => navigable() && !uiOnly(),
    test: shift("B"),
    // Collapses the sidebar to its rail on wide screens, in either view; at narrow widths, where
    // the sidebar is the off-canvas drawer, it opens and closes that instead.
    run: () => {
      if (matchMedia("(max-width: 1100px)").matches) S.treeDrawerOpen = !S.treeDrawerOpen;
      else S.sidebarCollapsed = !S.sidebarCollapsed;
    },
  },
  {
    combo: "⇧E",
    desc: "Open in editor",
    group: "View",
    test: shift("E"),
    when: inDiff,
    run: () => S.openInEditor?.(),
  },
  // Finalize (⇧ trio) + app
  {
    combo: "⇧A",
    desc: "Approve / mark reviewed (the part on screen, else the file)",
    group: "Review",
    test: shift("A"),
    when: inDiff,
    run: () => approveCurrentStep(),
  },
  {
    combo: "⇧R",
    desc: "Reset Review",
    group: "App",
    test: shift("R"),
    when: navigable,
    // The server's reset clears the app's annotations with the comments, so a desk with an app
    // says so.
    run: () =>
      askConfirm(
        `Reset the whole review? This clears every decision, sign-off${hasUi() ? ", comment and annotation" : " and comment"}.`,
        () => S.reset?.(),
      ),
  },
  {
    combo: "⇧S",
    desc: "Send review",
    group: "App",
    test: shift("S"),
    when: navigable,
    run: () => S.confirmSend?.(),
  },
  {
    combo: "⇧,",
    desc: "Settings",
    group: "App",
    test: (e) =>
      (e.key === "<" || (e.key === "," && e.shiftKey)) && !e.metaKey && !e.ctrlKey && !e.altKey,
    when: () => !inComposer(),
    run: () => S.openSettings?.(),
  },
  {
    combo: "Esc",
    desc: "Close / cancel",
    group: "App",
    test: (e) => e.key === "Escape",
    typing: true,
    run: escape, // cancels pending goline digits first (see escape()), so no dispatcher pre-cancel
    goline: true,
  },
];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || !!t?.isContentEditable;
}

function dispatch(e: KeyboardEvent) {
  const typing = isTyping(e);
  for (const h of HOTKEYS) {
    if (!h.test(e)) continue;
    if (typing && !h.typing) continue;
    if (h.enabled && !h.enabled()) continue;
    if (h.when && !h.when()) continue;
    // Any other action abandons pending goline digits — otherwise the idle timer would
    // yank the cursor away ~800ms after e.g. a j/⇧Y that already moved on.
    if (!h.goline) golineCancel();
    e.preventDefault();
    h.run(e);
    return;
  }
}

export function installKeys() {
  document.addEventListener("keydown", dispatch);
}

// A key pressed in the app page, passed up by the bridge: it runs as if pressed in the desk.
export function dispatchKey(k: ForwardedKey) {
  dispatch(new KeyboardEvent("keydown", k));
}

// Grouped view for the ? help overlay (built from the table so it stays in sync).
export function helpGroups(): { group: Group; items: { combo: string; desc: string }[] }[] {
  const order: Group[] = ["Navigate", "Review", "Comment", "View", "UI", "App"];
  return order.map((group) => ({
    group,
    items: HOTKEYS.filter((h) => h.group === group && !h.hide && h.enabled?.() !== false).map(
      (h) => ({ combo: h.combo, desc: h.desc }),
    ),
  }));
}
