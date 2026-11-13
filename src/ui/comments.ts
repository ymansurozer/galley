import { S, toast, persist, saver } from "./store";
import { toDisplayLine } from "./changes";
import { render } from "./render";
import { updateAwaitingDom } from "./annotations";
import { askStamp, turnInto, turnsInto } from "./uilane-derive";
import { uuid } from "./uuid";
import type { Side } from "./types";

// A new line comment by the reviewer, wherever it was made: on a line of Code mode's diff, or on a
// line of a line block on a topic page (topics-lines.ts). Either is the same ReviewComment on the
// file's own path, side and raw line, so the thread is one thread in both places. `anchorText` is
// the anchored line's text, which a reload re-anchors the thread by (reanchorComments). A question
// is asked of the agent at once.
export function addLineComment(
  at: { path: string; side: Side; lineNumber: number; endLine?: number; anchorText?: string },
  body: string,
  intent: "question" | "action",
) {
  const now = new Date().toISOString();
  const c = {
    id: uuid(),
    ...at,
    createdAt: now,
    updatedAt: now,
    status: "open" as const,
    role: "user" as const,
    body,
    intent,
  };
  S.state.comments.push(c);
  persist();
  if (intent === "question") void askComment(c.id);
}

// Edit & delete the reviewer's own comments. Agent replies (role "agent") are
// read-only and never get edit/delete affordances, but we guard here too.

export function editComment(id: string) {
  const comment = S.state.comments.find((c) => c.id === id);
  if (!comment || comment.role === "agent") return;
  // Comments persist raw lines; S.selected is display space. The edit renders in place
  // inside the thread (see buildCommentThread) — render() mounts it and restores focus.
  S.selected = { side: comment.side, lineNumber: toDisplayLine(comment.side, comment.lineNumber) };
  S.composerBody = comment.body;
  S.editingCommentId = id;
  S.composerAnnotation = null;
  S.composerOpen = true;
  render();
}

export async function deleteComment(id: string) {
  const comment = S.state.comments.find((c) => c.id === id);
  if (!comment || comment.role === "agent") return;
  if (S.editingCommentId === id) {
    S.editingCommentId = null;
    S.composerOpen = false;
  }
  S.state.comments = S.state.comments.filter((c) => c.id !== id);
  render();
  await persist(); // await so the next poll can't re-add it before the save lands
}

// Hand a question to the agent now, once the save carrying it has landed: the desk builds the
// question event from its stored copy of the comment. A save that didn't land leaves the desk
// nothing to ask from, so the question waits for the next Send, as one the desk couldn't deliver.
// A turn made while the save drained supersedes this ask: one back to a change request withdraws
// it, and one into a question again asks for itself.
export async function askComment(id: string) {
  const asked = askStamp(S.state.comments.find((c) => c.id === id));
  const saved = await saver.settled();
  if (askStamp(S.state.comments.find((c) => c.id === id)) !== asked) return;
  const res = saved
    ? await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      }).catch(() => null)
    : null;
  if (res?.ok) S.undeliveredAsks.delete(id);
  else {
    S.undeliveredAsks.add(id);
    toast("Couldn't reach the agent — the question goes with the next Send");
    updateAwaitingDom();
  }
}

// Turn the reviewer's opening comment into the other kind. A change request turned into a question
// is asked now, as a fresh Ask is; a question turned into a change request goes with the next Send.
export function turnComment(id: string) {
  const comment = S.state.comments.find((c) => c.id === id);
  const intent = comment && turnsInto(comment);
  if (!comment || !intent) return;
  turnInto(comment, intent, new Date().toISOString());
  render();
  persist();
  if (intent === "question") void askComment(id);
}
