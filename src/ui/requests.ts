import { S, $, toast } from "./store";
import { currentFile, fromDisplayLine } from "./changes";
import { isUnanchored } from "./unanchored";
import { flashThread, jumpToBlocker } from "./blockers";
import { cursorReset, cursorSelection } from "./cursor";
import { hasGuide, reviewFileOrder } from "./guide";
import { isFileSkimCollapsed, toggleFileSkim } from "./skim";
import { openRequestCount, requestStops, stepRequest, type RequestStop } from "./requests-derive";

// ── The walk through open change requests ────────────────────────────────────
// Change requests stay open across Sends until the reviewer resolves them, so after the agent
// handles a round the reviewer steps through each one (`]` / `[`, or the top bar's count) to check
// it. The walk crosses files in review order (requests-derive.ts holds the order and the step).

export const openRequests = () => openRequestCount(S.state?.comments ?? []);

// The stop the walk last landed on. A strip or rendered-markdown thread isn't on a diff row, so the
// cursor can't hold the place there.
let last: RequestStop | null = null;

const inOverview = () => !!S.overviewOpen && hasGuide();

// Where the walk steps from in the file on screen: the cursor, else the last stop in this file,
// else the file's top.
function here(): RequestStop | null {
  const file = currentFile();
  if (!file || inOverview()) return null;
  const sel = cursorSelection();
  if (sel)
    return {
      path: file.path,
      side: sel.side,
      lineNumber: fromDisplayLine(sel.side, sel.lineNumber),
      unanchored: false,
    };
  if (last?.path === file.path) return last;
  return { path: file.path, side: "deletions", lineNumber: 0, unanchored: true };
}

export function stepOpenRequest(dir: 1 | -1) {
  const ranks = new Map(reviewFileOrder().map((i, r) => [S.state.files[i]?.path, r]));
  const rank = (path: string) => ranks.get(path) ?? Infinity;
  const files = new Map(S.state.files.map((f) => [f.path, f]));
  if (S.preview) files.set(S.preview.path, S.preview);
  const stops = requestStops(S.state.comments, rank, (c) => {
    const f = files.get(c.path);
    return f ? isUnanchored(c, f) : c.unanchored === true;
  });
  const step = stepRequest(stops, rank, here(), dir);
  if (!step) {
    toast("No open change requests");
    return;
  }
  if (step.wrapped) toast(`Wrapped to the ${dir > 0 ? "first" : "last"} change request`);
  last = step.stop;
  void land(step.stop);
}

// Open the stop's file (a changed one, else as a preview), wait for it to render, then bring the
// thread into view where it shows: a rendered markdown file's thread, the unanchored strip's, else
// the cursor on its line.
async function land(stop: RequestStop) {
  if (inOverview() || currentFile()?.path !== stop.path) {
    const i = S.state.files.findIndex((f) => f.path === stop.path);
    await (i >= 0 ? S.selectFile?.(i) : S.previewFile?.(stop.path));
  }
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
    jumpToBlocker({
      kind: "thread",
      side: stop.side,
      lineNumber: stop.lineNumber,
      preview: "",
      unanchored: !!strip,
    });
}
