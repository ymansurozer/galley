import type { ReviewComment } from "./types";
import { asksChange, codeThreads } from "./requests-derive";
import { messageWaiting } from "./thread-derive";

// The Send dialog's topics line: how many topics go as settled, and how many are still to do.
export function topicsSendLine(done: number, total: number) {
  const left = total - done;
  const settled = `${done} topic${done === 1 ? "" : "s"} settled`;
  return left ? `${settled} · ${left} still to do` : `${settled} · none left to do`;
}

// The Send dialog's Code line, the code lane's counterpart of sendSummary (uilane-derive.ts):
// what goes, by what it asks of the agent, and what doesn't. Store-free, so it unit-tests.

// A reviewer's question still open in its thread.
const asks = (c: ReviewComment) =>
  c.status === "open" && c.role !== "agent" && c.intent === "question";

// What goes: the open change requests, counted by thread as the sidebar's Change requests list
// lists them, and the files they sit on; the threads whose open question no agent reply answers
// yet (they go as openQuestions); and the per-change verdicts set to rejected (`rejected`), which
// go whether or not the desk shows per-change verdicts. What doesn't: resolved threads, and
// threads whose questions were all answered that request no change. `topics`: the topic threads'
// own words (topicthreads-derive topicSendParts), on a desk whose receipt has no lanes, so it
// never reads "No change requests" while topic requests go.
export function codeSendSummary(
  comments: readonly ReviewComment[],
  rejected: number,
  topics: readonly string[] = [],
) {
  const threads = codeThreads(comments);
  const requests = threads.filter((t) => t.some(asksChange));
  const files = new Set(requests.flat().map((c) => c.path)).size;
  const waits = (t: readonly ReviewComment[]) => t.some((c) => asks(c) && messageWaiting(c, t));
  const waiting = threads.filter(waits).length;
  const answered = threads.filter((t) => t.some(asks) && !t.some(asksChange) && !waits(t)).length;
  const resolved = threads.filter((t) => t.every((c) => c.status === "resolved")).length;
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  const notSent = [
    resolved ? `${resolved} resolved` : "",
    answered ? n(answered, "answered question") : "",
  ].filter(Boolean);
  return {
    code:
      [
        requests.length ? `${n(requests.length, "change request")} in ${n(files, "file")}` : "",
        waiting ? n(waiting, "open question") : "",
        rejected ? n(rejected, "rejected change") : "",
        ...topics,
      ]
        .filter(Boolean)
        .join(" · ") || "No change requests",
    codeNotSent: notSent.length ? `Not sent: ${notSent.join(" · ")}` : "",
  };
}
