import { S, $, toast } from "./store";
import { currentFile, flowIndex, fromDisplayLine, toDisplayLine } from "./changes";
import { isUnanchored } from "./unanchored";
import { flashThread, jumpToBlocker } from "./blockers";
import { cursorOn, cursorReset, cursorSelection } from "./cursor";
import { attributeComment, placeBlocks, type PlacedBlock } from "./flow-index";
import { currentStep, hasGuide, reviewSteps } from "./guide";
import { isFileSkimCollapsed, toggleFileSkim } from "./skim";
import { openRequestCount, requestStops, stepRequest, type RequestStop } from "./requests-derive";
import { blockStep, stepKey, type Step } from "./steps";
import type { Side } from "./types";

// ── The walk through open change requests ────────────────────────────────────
// Change requests stay open across Sends until the reviewer resolves them, so after the agent
// handles a round the reviewer steps through each one (`]` / `[`, or the top bar's count) to check
// it. The walk crosses steps in review order, a split file's part by part (requests-derive.ts
// holds the order and the step).

export const openRequests = () => openRequestCount(S.state?.comments ?? []);

// The stop the walk last landed on. A strip or rendered-markdown thread isn't on a diff row, so the
// cursor can't hold the place there.
let last: RequestStop | null = null;

const inOverview = () => !!S.overviewOpen && hasGuide();

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
  const at = (path: string, side: Side, lineNumber: number): Pick<RequestStop, "step" | "rank"> => {
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

// Where the walk steps from in the file on screen: the last stop in this file while the cursor is
// off the diff or still on that stop's row, else the cursor, else the file's top. A context row
// holds the cursor at its new-side number, which can differ from a deleted-side stop's own. A part
// or Rest view stands in its own step wherever the cursor is; the whole file, in the step of the
// cursor's line.
function here(place: ReturnType<typeof placer>): RequestStop | null {
  const file = currentFile();
  if (!file || inOverview()) return null;
  const sel = cursorSelection();
  if (
    last?.path === file.path &&
    (!sel || (!last.unanchored && cursorOn(last.side, toDisplayLine(last.side, last.lineNumber))))
  )
    return last;
  const pos: Pick<RequestStop, "side" | "lineNumber" | "unanchored"> = sel
    ? { side: sel.side, lineNumber: fromDisplayLine(sel.side, sel.lineNumber), unanchored: false }
    : { side: "deletions", lineNumber: 0, unanchored: true };
  const step = currentStep();
  return {
    path: file.path,
    ...pos,
    ...(S.preview || step.part === undefined
      ? place.at(file.path, pos.side, pos.lineNumber)
      : { step, rank: place.rankOf(step) }),
  };
}

export function stepOpenRequest(dir: 1 | -1) {
  const place = placer();
  const files = new Map(S.state.files.map((f) => [f.path, f]));
  if (S.preview) files.set(S.preview.path, S.preview);
  const stops = requestStops(
    S.state.comments,
    (c) => place.at(c.path, c.side, c.lineNumber),
    (c) => {
      const f = files.get(c.path);
      return f ? isUnanchored(c, f) : c.unanchored === true;
    },
  );
  const step = stepRequest(stops, here(place), dir);
  if (!step) {
    toast("No open change requests");
    return;
  }
  if (step.wrapped)
    toast(
      stops.length === 1
        ? "Only 1 open change request"
        : `Wrapped to the ${dir > 0 ? "first" : "last"} change request`,
    );
  last = step.stop;
  void land(step.stop);
}

// Open the stop's step (its part, its file's Rest, or the file; a file outside the review as a
// preview), wait for it to render, then bring the thread into view where it shows: a rendered
// markdown file's thread, the unanchored strip's, else the cursor on its line.
async function land(stop: RequestStop) {
  const { step } = stop;
  const there = step
    ? !S.preview && stepKey(step) === stepKey(currentStep())
    : currentFile()?.path === stop.path;
  if (inOverview() || !there) await (step ? S.selectStep?.(step) : S.previewFile?.(stop.path));
  // A skimmed file the reviewer folded back hides its diff, the thread with it.
  if (isFileSkimCollapsed(stop.path)) await toggleFileSkim(stop.path);
  // The reviewer may have moved on while it rendered.
  if (currentFile()?.path !== stop.path || last !== stop) return;
  const diff = $("diff");
  const md = diff.querySelector<HTMLElement>(`.md-thread[data-thread="${stop.lineNumber}"]`);
  const strip = diff.querySelector(
    `.unanchored-strip [data-thread="${stop.side}:${stop.lineNumber}"]`,
  );
  if (md || strip) cursorReset();
  if (md) flashThread(md);
  else
    await jumpToBlocker(
      {
        kind: "thread",
        side: stop.side,
        lineNumber: stop.lineNumber,
        preview: "",
        unanchored: !!strip,
      },
      // Opening the thread's part renders again: the reviewer may move on meanwhile too.
      () => last === stop,
    );
}
