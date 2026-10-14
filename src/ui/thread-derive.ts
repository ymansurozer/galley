import type { ThreadMessage } from "./types";
import { answered } from "./uilane-derive";
import { agentPresence, type PresenceSignals } from "./topbar-derive";

// Pure derivations for a thread's card (store-free, so they unit-test): what its header names it,
// whether it's held for Send, which messages are labelled and which wait on the agent.
// annotations.ts builds the card.

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

// A reviewer's question waits on the agent until an agent reply lands after it was asked; its own
// status line sits under it until then. Each question waits on its own: one asked after the
// agent's answer to an earlier one waits again.
export const messageWaiting = (m: ThreadMessage, comments: readonly ThreadMessage[]) =>
  m.role !== "agent" && m.intent === "question" && !answered(m, comments);

// A thread waits on the agent while one of its questions does.
export const questionWaiting = (comments: readonly ThreadMessage[]) =>
  comments.some((m) => messageWaiting(m, comments));

// A waiting question's status line: the top bar's presence rule (topbar-derive) read from the same
// signals, this question counted as unanswered, so the two never disagree. Amber with the top
// bar's words when nothing picked the review or the question up; else "Working", and what the
// agent says it's doing once it says. Desk-global by design: one desk, one agent.
export function questionStatus(s: Omit<PresenceSignals, "unansweredAsks">) {
  const presence = agentPresence({ ...s, unansweredAsks: 1 });
  return presence.kind === "notAttached"
    ? { queued: true, label: presence.line, activity: "" }
    : { queued: false, label: "Working", activity: s.activity ?? "" };
}

// "Held for Send" chips a change request's header until the review is sent. While the agent has
// it (awaitingAgent), it isn't held any more; once the agent replies it goes with the next Send.
export const showsHeld = (asksChange: boolean, awaitingAgent: boolean) =>
  asksChange && !awaitingAgent;

// The pill a reviewer's message wears where the thread's kind doesn't already say what it is: a
// question in a thread that isn't a question, and a change requested anywhere but a change
// request's opening message (its header names that). So a one-intent thread's messages stay
// bare. `i`: the message's place in the thread.
export function intentPill(
  m: ThreadMessage,
  i: number,
  kind: ThreadKind | undefined,
): "change" | "question" | null {
  if (m.role === "agent") return null;
  if (m.intent === "action") return i === 0 && kind === "change" ? null : "change";
  if (m.intent === "question") return kind === "question" ? null : "question";
  return null;
}

// The line a thread sits on, or the range it covers.
export const lineLabel = (line: number, endLine?: number) =>
  endLine !== undefined && endLine !== line ? `L${line}–${endLine}` : `L${line}`;

// The line label a card's header carries, if any. A card sits under its line, so a one-line one
// needs none; a range's card sits under its last line, so the range is named, and a thread that
// lost its line keeps the old number.
export const cardLoc = (line: number, endLine: number | undefined, lost: boolean) =>
  lost || (endLine !== undefined && endLine !== line) ? lineLabel(line, endLine) : null;
