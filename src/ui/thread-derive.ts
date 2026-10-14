import type { ThreadMessage } from "./types";
import { answered } from "./uilane-derive";

// Pure derivations for a thread's card (store-free, so they unit-test): what its header names it,
// and which band closes it. annotations.ts builds the card.

export type ThreadKind = "change" | "question" | "note" | "agent" | "resolved";

// What a thread is, by what the reviewer asked in it: a change request (even one that began as a
// question), a question, a note; a thread only the agent spoke in is the agent's note.
export function threadKind(
  status: "open" | "resolved",
  comments: readonly ThreadMessage[],
): ThreadKind {
  if (status === "resolved") return "resolved";
  const mine = comments.filter((m) => m.role !== "agent");
  if (mine.some((m) => m.intent === "action")) return "change";
  if (mine.some((m) => m.intent === "question")) return "question";
  return mine.length ? "note" : "agent";
}

// A thread waits on the agent while one of the reviewer's questions in it has no agent reply after
// it was asked.
export const questionWaiting = (comments: readonly ThreadMessage[]) =>
  comments.some((m) => m.role !== "agent" && m.intent === "question" && !answered(m, comments));

// "Held — goes with Send" closes a change request until the review is sent. While the agent has
// it (awaitingAgent), it isn't held any more; once the agent replies it goes with the next Send.
export const showsHeld = (asksChange: boolean, awaitingAgent: boolean) =>
  asksChange && !awaitingAgent;

// The line a thread sits on, or the range it covers.
export const lineLabel = (line: number, endLine?: number) =>
  endLine !== undefined && endLine !== line ? `L${line}–${endLine}` : `L${line}`;
