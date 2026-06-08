import { S } from "./store";
import { hasGuide } from "./guide";
import { approveCurrentFile } from "./decisions";
import {
  cursorMoveLine,
  cursorMoveHunk,
  cursorComment,
  cursorVerdict,
  cursorResolve,
} from "./cursor";

// ── Central keyboard map ─────────────────────────────────────────────────────
// One ordered table is the single source of truth: the dispatcher runs the first binding whose
// key matches and whose scope is active, and the ? help overlay renders from the same table — so
// hints can never drift from behavior. Scopes keep a key meaning the right thing in context.

type Group = "Navigate" | "Review" | "Comment" | "View" | "App";
type Hotkey = {
  combo: string;
  desc: string;
  group: Group;
  test: (e: KeyboardEvent) => boolean;
  run: () => void;
  when?: () => boolean; // scope guard (default: anywhere not typing)
  typing?: boolean; // also fires while typing in the composer
  hide?: boolean; // omit from the help overlay
};

// Scopes
const inComposer = () => S.composerOpen;
const inModal = () => S.settingsOpen || !!S.confirmMsg;
const inOverview = () => !!S.overviewOpen && hasGuide();
const inDiff = () => !inComposer() && !inModal() && !inOverview();
const navigable = () => !inComposer() && !inModal();
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
  if (S.confirmMsg) {
    S.confirmMsg = "";
    return;
  }
  if (S.settingsOpen) {
    S.settingsOpen = false;
    return;
  }
  if (S.composerOpen || S.popoverOpen || S.editingCommentId) {
    S.composerOpen = false;
    S.popoverOpen = false;
    S.editingCommentId = null;
  }
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
  // Navigate
  {
    combo: "⇧→",
    desc: "Next file (review order)",
    group: "Navigate",
    test: shift("ArrowRight"),
    when: navigable,
    run: () => S.nextFile?.(),
  },
  {
    combo: "⇧←",
    desc: "Previous file (review order)",
    group: "Navigate",
    test: shift("ArrowLeft"),
    when: navigable,
    run: () => S.prevFile?.(),
  },
  {
    combo: "⌘⇧↓",
    desc: "Next file (tree order)",
    group: "Navigate",
    test: cmdShift("ArrowDown"),
    when: navigable,
    run: () => S.treeStep?.(1),
  },
  {
    combo: "⌘⇧↑",
    desc: "Previous file (tree order)",
    group: "Navigate",
    test: cmdShift("ArrowUp"),
    when: navigable,
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
    combo: "o",
    desc: "Overview",
    group: "Navigate",
    test: k("o"),
    when: () => hasGuide() && navigable(),
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
    run: () => cursorVerdict("accepted"),
  },
  {
    combo: "⇧N",
    desc: "Reject change (Undo)",
    group: "Review",
    test: shift("N"),
    when: inDiff,
    run: () => cursorVerdict("rejected"),
  },
  // View
  {
    combo: "v",
    desc: "Split / unified",
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
  // Finalize (⇧ trio) + app
  {
    combo: "⇧A",
    desc: "Approve / mark file reviewed",
    group: "Review",
    test: shift("A"),
    when: inDiff,
    run: () => approveCurrentFile(),
  },
  {
    combo: "⇧R",
    desc: "Reset review",
    group: "App",
    test: shift("R"),
    when: navigable,
    run: () =>
      askConfirm("Reset the whole review? This clears every decision and comment.", () =>
        S.reset?.(),
      ),
  },
  {
    combo: "⇧S",
    desc: "Send to agent",
    group: "App",
    test: shift("S"),
    when: navigable,
    run: () => askConfirm("Send this review to the agent?", () => S.send?.()),
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
    run: escape,
  },
];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || !!t?.isContentEditable;
}

export function installKeys() {
  document.addEventListener("keydown", (e) => {
    const typing = isTyping(e);
    for (const h of HOTKEYS) {
      if (!h.test(e)) continue;
      if (typing && !h.typing) continue;
      if (h.when && !h.when()) continue;
      e.preventDefault();
      h.run();
      return;
    }
  });
}

// Grouped view for the ? help overlay (built from the table so it stays in sync).
export function helpGroups(): { group: Group; items: { combo: string; desc: string }[] }[] {
  const order: Group[] = ["Navigate", "Review", "Comment", "View", "App"];
  return order.map((group) => ({
    group,
    items: HOTKEYS.filter((h) => h.group === group && !h.hide).map((h) => ({
      combo: h.combo,
      desc: h.desc,
    })),
  }));
}
