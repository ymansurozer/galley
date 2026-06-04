import { S, $, toast, persist } from "./store";
import { placeNearActionPop } from "./selection";
import { render } from "./render";

// Edit & delete the reviewer's own comments. Agent replies (role "agent") are
// read-only and never get edit/delete affordances, but we guard here too.

export function editComment(id: string) {
  const comment = S.state.comments.find((c) => c.id === id);
  if (!comment || comment.role === "agent") return;
  S.selected = { side: comment.side, lineNumber: comment.lineNumber };
  S.composerBody = comment.body;
  S.composerTitle = "Edit comment";
  S.editingCommentId = id;
  S.popoverOpen = false;
  placeNearActionPop($("composer"));
  S.composerOpen = true;
  setTimeout(() => $("commentBody").focus(), 0); // after Alpine shows it
}

export async function deleteComment(id: string) {
  const comment = S.state.comments.find((c) => c.id === id);
  if (!comment || comment.role === "agent") return;
  if (S.editingCommentId === id) { S.editingCommentId = null; S.composerOpen = false; }
  S.state.comments = S.state.comments.filter((c) => c.id !== id);
  render();
  await persist(); // await so the next poll can't re-add it before the save lands
  toast("Comment deleted");
}
