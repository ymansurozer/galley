import type { ReviewComment, Side } from "./types";

// Pure derivations for the walk through open change requests (`]` / `[` and the top bar's count),
// store-free so they unit-test. requests.ts is the store-reading side.

// One stop on the walk: a thread (a path's comments on one side and line) on its line, or in the
// strip above its file's diff when it lost its anchor.
export type RequestStop = { path: string; side: Side; lineNumber: number; unanchored: boolean };

// A thread asks for a change while a reviewer's comment in it is open and isn't a question: the
// rule fileObjections, the blockers chip and the Send's codeChangeRequests count by. So an ask the
// reviewer followed with Request change counts; a resolved thread, an ask, the agent's note and a
// stale thread (its file left the diff) don't.
const asksChange = (c: ReviewComment) =>
  c.status === "open" && c.role !== "agent" && c.intent !== "question";

const threadKey = (c: ReviewComment) => `${c.path}\n${c.side}:${c.lineNumber}`;

export const openRequestCount = (comments: readonly ReviewComment[]) =>
  new Set(comments.filter(asksChange).map(threadKey)).size;

// Walk order: by the file's place in review order (`rank`; a file outside it, such as a preview,
// ranks Infinity and those go by path), then the strip (it sits above the diff), then by line, the
// deleted line before the added one on the same number.
function compare(rank: (path: string) => number) {
  return (a: RequestStop, b: RequestStop) =>
    rank(a.path) - rank(b.path) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    +b.unanchored - +a.unanchored ||
    a.lineNumber - b.lineNumber ||
    +(a.side === "additions") - +(b.side === "additions");
}

// The open change requests in walk order. A thread sits in the strip when any of its comments lost
// its anchor (`unanchored`), as annotations.ts places it.
export function requestStops(
  comments: readonly ReviewComment[],
  rank: (path: string) => number,
  unanchored: (c: ReviewComment) => boolean,
): RequestStop[] {
  const threads = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const thread = threads.get(threadKey(c));
    if (thread) thread.push(c);
    else threads.set(threadKey(c), [c]);
  }
  const stops: RequestStop[] = [];
  for (const thread of threads.values()) {
    if (!thread.some(asksChange)) continue;
    // A thread holds at least the comment that started it.
    const { path, side, lineNumber } = thread[0]!;
    stops.push({ path, side, lineNumber, unanchored: thread.some(unanchored) });
  }
  return stops.sort(compare(rank));
}

// Where `]` (dir 1) or `[` (dir -1) goes from `at`: the nearest stop strictly past it, wrapping off
// either end. `at` is a stop or any place between stops (the cursor's line, a file's top); with
// none, the walk starts at its first stop, or its last going back.
export function stepRequest(
  stops: readonly RequestStop[],
  rank: (path: string) => number,
  at: RequestStop | null,
  dir: 1 | -1,
): { stop: RequestStop; wrapped: boolean } | null {
  const end = dir > 0 ? stops[0] : stops[stops.length - 1];
  if (!end) return null;
  if (!at) return { stop: end, wrapped: false };
  const cmp = compare(rank);
  if (dir > 0) {
    const next = stops.find((s) => cmp(s, at) > 0);
    if (next) return { stop: next, wrapped: false };
  } else
    for (let i = stops.length - 1; i >= 0; i--)
      if (cmp(stops[i]!, at) < 0) return { stop: stops[i]!, wrapped: false };
  return { stop: end, wrapped: true };
}
