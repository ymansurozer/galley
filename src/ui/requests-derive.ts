import type { ReviewComment, Side, UiAnnotationRecord } from "./types";
import { firstLine, isOpenChange } from "./uilane-derive";

// Pure derivations for the open change requests across both lanes: the sidebar's Change requests
// list, its count, and the walk `]` / `[` take through it. Store-free so they unit-test;
// requests.ts is the store-reading side.

// A code request is a thread (a path's comments on one side and line) on its line, or in the strip
// above its file's diff when it lost its anchor. An app request is an annotation. `text` is the
// first line of the message that asks for the change.
export type CodeRequest = {
  kind: "code";
  path: string;
  side: Side;
  lineNumber: number;
  unanchored: boolean;
  text: string;
};
export type AppRequest = { kind: "app"; id: string; number: number; text: string };
export type OpenRequest = CodeRequest | AppRequest;

// A place the walk steps from: a request, or anywhere between two (the cursor's line, a file's
// top, the selected annotation when it's a question).
export type RequestPlace = Omit<CodeRequest, "text"> | { kind: "app"; number: number };

// A thread asks for a change while a reviewer's comment in it is open and isn't a question: the
// rule fileObjections, the blockers chip and the Send's codeChangeRequests count by. So an ask the
// reviewer followed with Request change counts; a resolved thread, an ask, the agent's note and a
// stale thread (its file left the diff) don't.
const asksChange = (c: ReviewComment) =>
  c.status === "open" && c.role !== "agent" && c.intent !== "question";

const threadKey = (c: ReviewComment) => `${c.path}\n${c.side}:${c.lineNumber}`;

// List order: the code requests, then the app's. Code goes by the file's place in review order
// (`rank`; a file outside it, such as a preview, ranks Infinity and those go by path), then the
// strip (it sits above the diff), then by line, the deleted line before the added one on the same
// number. App requests go by number.
function compare(rank: (path: string) => number) {
  return (a: RequestPlace, b: RequestPlace) => {
    if (a.kind === "app" && b.kind === "app") return a.number - b.number;
    if (a.kind === "code" && b.kind === "code")
      return (
        rank(a.path) - rank(b.path) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        +b.unanchored - +a.unanchored ||
        a.lineNumber - b.lineNumber ||
        +(a.side === "additions") - +(b.side === "additions")
      );
    return a.kind === "code" ? -1 : 1;
  };
}

// The open change requests in list order. A thread sits in the strip when any of its comments lost
// its anchor (`unanchored`), as annotations.ts places it. App questions and resolved annotations
// aren't requests; a question the reviewer followed with Request change is.
export function openRequestList(
  comments: readonly ReviewComment[],
  rank: (path: string) => number,
  unanchored: (c: ReviewComment) => boolean,
  annotations: readonly UiAnnotationRecord[],
): OpenRequest[] {
  const threads = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const thread = threads.get(threadKey(c));
    if (thread) thread.push(c);
    else threads.set(threadKey(c), [c]);
  }
  const list: OpenRequest[] = [];
  for (const thread of threads.values()) {
    const ask = thread.find(asksChange);
    if (!ask) continue;
    const { path, side, lineNumber } = ask;
    list.push({
      kind: "code",
      path,
      side,
      lineNumber,
      unanchored: thread.some(unanchored),
      text: firstLine(ask.body),
    });
  }
  for (const a of annotations) {
    if (!isOpenChange(a)) continue;
    // The opening message of a change request, else the reply that turned a question into one.
    const ask =
      a.comments.find((m) => m.role !== "agent" && m.intent === "action") ?? a.comments[0];
    list.push({ kind: "app", id: a.id, number: a.number, text: firstLine(ask?.body ?? "") });
  }
  return list.sort(compare(rank));
}

// The sidebar row: a key for the x-for, and the request's place as the row names it — the file's
// name and line, "· lost" for one in the strip, the pin's number for the app.
export function requestRow(r: OpenRequest) {
  if (r.kind === "app") return { ...r, key: `app:${r.id}`, loc: `#${r.number}` };
  const name = r.path.split("/").pop() || r.path;
  return {
    ...r,
    key: `code:${r.path}\n${r.side}:${r.lineNumber}`,
    loc: r.unanchored ? `${name} · lost` : `${name}:${r.lineNumber}`,
  };
}
export type RequestRow = ReturnType<typeof requestRow>;

// Where `]` (dir 1) or `[` (dir -1) goes from `at`: the nearest request strictly past it, wrapping
// off either end. With no place, the walk starts at its first request, or its last going back.
export function stepRequest(
  list: readonly OpenRequest[],
  rank: (path: string) => number,
  at: RequestPlace | null,
  dir: 1 | -1,
): { request: OpenRequest; wrapped: boolean } | null {
  const end = dir > 0 ? list[0] : list[list.length - 1];
  if (!end) return null;
  if (!at) return { request: end, wrapped: false };
  const cmp = compare(rank);
  if (dir > 0) {
    const next = list.find((r) => cmp(r, at) > 0);
    if (next) return { request: next, wrapped: false };
  } else
    for (let i = list.length - 1; i >= 0; i--)
      if (cmp(list[i]!, at) < 0) return { request: list[i]!, wrapped: false };
  return { request: end, wrapped: true };
}
