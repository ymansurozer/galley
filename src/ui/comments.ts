import { S, toast, persist, saver } from "./store";
import { toDisplayLine } from "./changes";
import { render } from "./render";
import { turnInto } from "./uilane-derive";

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
  toast("Comment deleted");
}

// Hand a question to the agent now, once the save carrying it has landed: the desk builds the
// question event from its stored copy of the comment.
export async function askComment(id: string) {
  await saver.settled();
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch(() => null);
  if (!res?.ok) toast("Couldn't reach the agent — the question goes with the next Send");
}

// Turn the reviewer's opening comment into the other kind. A change request turned into a question
// is asked now, as a fresh Ask is; a question turned into a change request goes with the next Send.
export function turnComment(id: string) {
  const comment = S.state.comments.find((c) => c.id === id);
  if (!comment || comment.role === "agent") return;
  const intent = comment.intent === "question" ? "action" : "question";
  turnInto(comment, intent, new Date().toISOString());
  render();
  persist();
  if (intent === "question") {
    void askComment(id);
    toast("Turned into an ask — waiting for answer");
  } else toast("Turned into a change request — it goes with the next Send");
}
