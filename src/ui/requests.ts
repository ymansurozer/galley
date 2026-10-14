import { S, toast } from "./store";
import { currentFile, fromDisplayLine, toDisplayLine } from "./changes";
import { isUnanchored } from "./unanchored";
import { jumpToBlocker } from "./blockers";
import { cursorOn, cursorSelection } from "./cursor";
import { hasGuide, reviewFileOrder } from "./guide";
import { selectAnnotation } from "./uilane";
import { setView } from "./appview";
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
    if (S.view !== "ui") setView("ui");
    selectAnnotation(r.id);
    return;
  }
  void land(r, S.view === "ui" ? setView("code") : undefined);
}

// Open the request's file (a changed one, else as a preview), wait for it to render, then bring the
// thread into view the way the blockers list does: a rendered markdown file's thread, the
// unanchored strip's, else the cursor on its line. Coming from the App view, the diff's repaint
// (`shown`) settles first, so nothing draws over the landing and no second render races it.
async function land(r: CodeRequest, shown?: Promise<void>) {
  await shown;
  // The reviewer may have moved on meanwhile.
  if (last !== r) return;
  if (inOverview() || currentFile()?.path !== r.path) {
    const i = S.state.files.findIndex((f) => f.path === r.path);
    await (i >= 0 ? S.selectFile?.(i) : S.previewFile?.(r.path));
  }
  // The reviewer may have moved on while it rendered.
  const current = () => currentFile()?.path === r.path && last === r;
  if (!current()) return;
  const { side, lineNumber, unanchored } = r;
  await jumpToBlocker({ kind: "thread", side, lineNumber, preview: "", unanchored }, current);
}
