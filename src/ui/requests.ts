import { S, $, toast } from "./store";
import { currentFile, fromDisplayLine, toDisplayLine } from "./changes";
import { isUnanchored } from "./unanchored";
import { flashThread, jumpToBlocker } from "./blockers";
import { cursorOn, cursorReset, cursorSelection } from "./cursor";
import { hasGuide, reviewFileOrder } from "./guide";
import { isFileSkimCollapsed, toggleFileSkim } from "./skim";
import { selectAnnotation } from "./uilane";
import {
  openRequestList,
  requestRow,
  stepRequest,
  type CodeRequest,
  type OpenRequest,
  type RequestPlace,
  type RequestRow,
} from "./requests-derive";

// ── The open change requests, across both lanes ──────────────────────────────
// Change requests stay open across Sends until the reviewer resolves them, so after the agent
// handles a round the reviewer steps through each one (`]` / `[`, or the sidebar's Change requests
// list) to check it. The walk crosses files in review order, then the app's annotations, switching
// views as it goes (requests-derive.ts holds the order and the step).

function requestList() {
  const ranks = new Map(reviewFileOrder().map((i, r) => [S.state.files[i]?.path, r]));
  const rank = (path: string) => ranks.get(path) ?? Infinity;
  const files = new Map(S.state.files.map((f) => [f.path, f]));
  if (S.preview) files.set(S.preview.path, S.preview);
  const list = openRequestList(
    S.state.comments,
    rank,
    (c) => {
      const f = files.get(c.path);
      return f ? isUnanchored(c, f) : c.unanchored === true;
    },
    S.state.annotations ?? [],
  );
  return { list, rank };
}

// The sidebar's rows (the template may evaluate before the initial fetch).
export const requestRows = (): RequestRow[] => (S.state ? requestList().list.map(requestRow) : []);

// The request the walk last landed on. A strip or rendered-markdown thread isn't on a diff row, so
// the cursor can't hold the place there.
let last: OpenRequest | null = null;

const inOverview = () => !!S.overviewOpen && hasGuide();

// Where the walk steps from. In the App view: the selected annotation, which sits between requests
// when it's a question; with none, the app's start, past every code request. In the code view, in
// the file on screen: the last request in this file while the cursor is off the diff or still on
// that request's row, else the cursor, else the file's top. A context row holds the cursor at its
// new-side number, which can differ from a deleted-side request's own. On the Overview: nowhere,
// so the walk starts at its ends.
function here(): RequestPlace | null {
  if (S.view === "ui") {
    const a = S.state.annotations?.find((x) => x.id === S.selectedAnnotation);
    return { kind: "app", number: a?.number ?? 0 };
  }
  const file = currentFile();
  if (!file || inOverview()) return null;
  const sel = cursorSelection();
  if (
    last?.kind === "code" &&
    last.path === file.path &&
    (!sel || (!last.unanchored && cursorOn(last.side, toDisplayLine(last.side, last.lineNumber))))
  )
    return last;
  if (sel)
    return {
      kind: "code",
      path: file.path,
      side: sel.side,
      lineNumber: fromDisplayLine(sel.side, sel.lineNumber),
      unanchored: false,
    };
  return { kind: "code", path: file.path, side: "deletions", lineNumber: 0, unanchored: true };
}

export function stepOpenRequest(dir: 1 | -1) {
  const { list, rank } = requestList();
  const step = stepRequest(list, rank, here(), dir);
  if (!step) {
    toast("No open change requests");
    return;
  }
  if (step.wrapped)
    toast(
      list.length === 1
        ? "Only 1 open change request"
        : `Wrapped to the ${dir > 0 ? "first" : "last"} change request`,
    );
  // The list the walk steps through stays in sight.
  S.requestsOpen = true;
  openRequest(step.request);
}

// Go to a request, from the walk or its sidebar row: an app one selects its annotation in the App
// view; a code one opens its file in the code view and lands on its thread.
export function openRequest(r: OpenRequest) {
  last = r;
  if (r.kind === "app") {
    S.treeDrawerOpen = false;
    if (S.view !== "ui") S.setView?.("ui");
    selectAnnotation(r.id);
    return;
  }
  if (S.view === "ui") S.setView?.("code");
  void land(r);
}

// Open the request's file (a changed one, else as a preview), wait for it to render, then bring the
// thread into view where it shows: a rendered markdown file's thread, the unanchored strip's, else
// the cursor on its line.
async function land(r: CodeRequest) {
  if (inOverview() || currentFile()?.path !== r.path) {
    const i = S.state.files.findIndex((f) => f.path === r.path);
    await (i >= 0 ? S.selectFile?.(i) : S.previewFile?.(r.path));
  }
  // A skimmed file the reviewer folded back hides its diff, the thread with it.
  if (isFileSkimCollapsed(r.path)) await toggleFileSkim(r.path);
  // The reviewer may have moved on while it rendered.
  if (currentFile()?.path !== r.path || last !== r) return;
  const diff = $("diff");
  const md = diff.querySelector<HTMLElement>(`.md-thread[data-thread="${r.lineNumber}"]`);
  const strip = diff.querySelector(`.unanchored-strip [data-thread="${r.side}:${r.lineNumber}"]`);
  if (md || strip) cursorReset();
  if (md) flashThread(md);
  else
    jumpToBlocker({
      kind: "thread",
      side: r.side,
      lineNumber: r.lineNumber,
      preview: "",
      unanchored: !!strip,
    });
}
