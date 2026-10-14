import { S, toast } from "./store";
import { currentFile, flowIndex, rowAnchor, toDisplayLine } from "./changes";
import { isUnanchored } from "./unanchored";
import { jumpToBlocker } from "./blockers";
import { cursorOn, cursorSelection } from "./cursor";
import { attributeComment, placeBlocks, type PlacedBlock } from "./flow-index";
import { currentStep, hasGuide, reviewSteps } from "./guide";
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
import { blockStep, stepKey, type Step } from "./steps";
import type { Side } from "./types";

// ── The open change requests, across both lanes ──────────────────────────────
// Change requests stay open across Sends until the reviewer resolves them, so after the agent
// handles a round the reviewer steps through each one (`]` / `[`, or the sidebar's Change requests
// list) to check it. The walk crosses steps in review order, a split file's part by part, then the
// app's annotations, switching views as it goes (requests-derive.ts holds the order and the step).

// Where a thread on a line sits in the walk: the step it's attributed to (the step of the block
// nearest its line: a part or Rest in a split file, else the file) and that step's place in review
// order. A file outside the review (a preview) has no step and ranks last.
function placer() {
  const ranks = new Map<string, number>();
  const fileRanks = new Map<number, number>();
  reviewSteps().forEach((s, r) => {
    ranks.set(stepKey(s), r);
    if (!fileRanks.has(s.fileIndex)) fileRanks.set(s.fileIndex, r);
  });
  const rankOf = (step: Step) =>
    ranks.get(stepKey(step)) ?? fileRanks.get(step.fileIndex) ?? Infinity;
  const ix = flowIndex();
  const indexOf = new Map(S.state.files.map((f, i) => [f.path, i] as const));
  const placed = new Map<string, PlacedBlock[]>();
  const at = (path: string, side: Side, lineNumber: number): Pick<CodeRequest, "step" | "rank"> => {
    const fileIndex = indexOf.get(path);
    if (fileIndex === undefined) return { rank: Infinity };
    let blocks = placed.get(path);
    if (!blocks) {
      const hunks = S.state.files[fileIndex]?.hunks ?? [];
      blocks = placeBlocks(ix.changesByPath.get(path) ?? [], hunks);
      placed.set(path, blocks);
    }
    const block = attributeComment({ side, lineNumber }, blocks);
    const step = block ? blockStep(S.state.guide?.files ?? [], fileIndex, block) : { fileIndex };
    return { step, rank: rankOf(step) };
  };
  return { at, rankOf };
}

function requestList(place = placer()) {
  const files = new Map(S.state.files.map((f) => [f.path, f]));
  if (S.preview) files.set(S.preview.path, S.preview);
  return openRequestList(
    S.state.comments,
    (c) => place.at(c.path, c.side, c.lineNumber),
    (c) => {
      const f = files.get(c.path);
      return f ? isUnanchored(c, f) : c.unanchored === true;
    },
    S.state.annotations ?? [],
  );
}

// The sidebar's rows (the template may evaluate before the initial fetch).
export const requestRows = (): RequestRow[] => (S.state ? requestList().map(requestRow) : []);

// The request the walk last landed on. A strip or rendered-markdown thread isn't on a diff row, so
// the cursor can't hold the place there.
let last: OpenRequest | null = null;

const inOverview = () => !!S.overviewOpen && hasGuide();

// Where the walk steps from. In the App view: the selected annotation, which sits between requests
// when it's a question; with none, the app's start, past every code request. In the code view, in
// the file on screen: the last request in this file while the cursor is off the diff or still on
// that request's row, else the cursor, else the file's top. A context row holds the cursor at its
// new-side number, which can differ from a deleted-side request's own. A part or Rest view stands
// in its own step wherever the cursor is; the whole file, in the step of the cursor's line. On the
// Overview: nowhere, so the walk starts at its ends.
function here(place: ReturnType<typeof placer>): RequestPlace | null {
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
  const at = sel && rowAnchor(sel.side, sel.lineNumber);
  const pos: Pick<CodeRequest, "side" | "lineNumber" | "unanchored"> = at
    ? { side: at.side, lineNumber: at.line, unanchored: false }
    : { side: "deletions", lineNumber: 0, unanchored: true };
  const step = currentStep();
  return {
    kind: "code",
    path: file.path,
    ...pos,
    ...(S.preview || step.part === undefined
      ? place.at(file.path, pos.side, pos.lineNumber)
      : { step, rank: place.rankOf(step) }),
  };
}

export function stepOpenRequest(dir: 1 | -1) {
  const place = placer();
  const list = requestList(place);
  const step = stepRequest(list, here(place), dir);
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
// view; a code one opens its step in the code view and lands on its thread.
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

// Open the request's step (its part, its file's Rest, or the file; a file outside the review as a
// preview), wait for it to render, then bring the thread into view the way the blockers list does:
// a rendered markdown file's thread, the unanchored strip's, else the cursor on its line. Coming
// from the App view, the diff's repaint (`shown`) settles first, so nothing draws over the landing
// and no second render races it.
async function land(r: CodeRequest, shown?: Promise<void>) {
  await shown;
  // The reviewer may have moved on meanwhile.
  if (last !== r) return;
  const { step } = r;
  const there = step
    ? !S.preview && stepKey(step) === stepKey(currentStep())
    : currentFile()?.path === r.path;
  if (inOverview() || !there) await (step ? S.selectStep?.(step) : S.previewFile?.(r.path));
  // The reviewer may have moved on while it rendered, or while the thread's own part renders.
  const current = () => currentFile()?.path === r.path && last === r;
  if (!current()) return;
  const { side, lineNumber, unanchored } = r;
  await jumpToBlocker({ kind: "thread", side, lineNumber, preview: "", unanchored }, current);
}
