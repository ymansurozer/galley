import { S, $, esc, toast, persist } from "./store";
import { currentComments, currentChanges } from "./changes";
import { acceptChange } from "./decisions";
import { editComment, deleteComment } from "./comments";
import { selectionLabel, placeNearActionPop } from "./selection";
import { render } from "./render";
import type { AnnotationInput, AnnotationMeta, ReviewComment } from "./types";

export function annotations(): AnnotationInput[] {
  const out: AnnotationInput[] = [];
  const seen = new Set<string>();
  const groups = new Map<string, ReviewComment[]>();
  for (const c of currentComments()) {
    const key = `${c.side}:${c.lineNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  for (const comments of groups.values()) {
    comments.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    const first = comments[0];
    const change = currentChanges().find((ch) => ch.status === "pending" && ch.side === first.side && ch.lineNumber === first.lineNumber);
    if (change) seen.add(change.id);
    out.push({ side: first.side, lineNumber: first.lineNumber, metadata: { type: "thread", path: first.path, side: first.side, lineNumber: first.lineNumber, status: comments.some((c) => c.status === "open") ? "open" : "resolved", comments, changeId: change?.id } });
  }
  for (const ch of currentChanges().filter((ch) => ch.status === "pending" && !seen.has(ch.id))) {
    out.push({ side: ch.side, lineNumber: ch.endLine ?? ch.lineNumber, metadata: { type: "change", id: ch.id, side: ch.side, lineNumber: ch.lineNumber, title: ch.title, path: ch.path } });
  }
  return out;
}

// `a` is @pierre/diffs' annotation callback argument (loose by contract); the
// metadata we tucked into it is our own typed AnnotationMeta.
export function renderAnnotation(a: { metadata: AnnotationMeta }) {
  const c = a.metadata;
  const change = c.type === "change" ? S.state.changes.find((x) => x.id === c.id) : (c.changeId ? S.state.changes.find((x) => x.id === c.changeId) : null);
  const el = document.createElement("div");
  el.className = `annotation ${c.type === "thread" && c.status === "resolved" ? "resolved" : ""}`;
  if (c.type === "change") {
    el.innerHTML = `<div class="change-actions"><button class="reject">Undo</button><button class="accept">Keep</button></div>`;
  } else {
    const messages = c.status === "resolved"
      ? `<div class="thread-summary"><b>${c.comments.length}</b> comment${c.comments.length === 1 ? "" : "s"} <span>(Resolved)</span><button class="reopen-inline">Reopen</button></div>`
      : c.comments.map((m) => {
          const own = m.role !== "agent";
          const edited = m.updatedAt && m.createdAt && m.updatedAt !== m.createdAt ? " · edited" : "";
          const actions = own ? `<span class="msg-actions"><button class="edit-comment" data-id="${m.id}">Edit</button><button class="delete-comment" data-id="${m.id}">Delete</button></span>` : "";
          return `<div class="msg ${own ? "" : "agent"}"><div class="meta"><span class="author ${own ? "" : "agent"}">${own ? "You" : "Agent"}</span><time>now${edited}</time>${actions}</div><p>${esc(m.body)}</p></div>`;
        }).join("");
    el.innerHTML = `<div class="comment-box">${messages}<div class="thread-actions">${c.status === "resolved" ? '<button class="reopen-thread">Reopen</button>' : '<button class="reply-thread">Reply</button><button class="resolve-thread">Resolve</button>'}</div></div>${change ? `<div class="change-actions"><button class="reject">Undo</button><button class="accept">Keep</button></div>` : ""}`;
  }
  const acceptButton = el.querySelector(".accept");
  const rejectButton = el.querySelector(".reject");
  if (change && acceptButton && rejectButton) { (acceptButton as HTMLButtonElement).onclick = () => acceptChange(change.id, "accepted"); (rejectButton as HTMLButtonElement).onclick = () => acceptChange(change.id, "rejected"); }
  const reply = el.querySelector(".reply-thread") as HTMLButtonElement | null;
  if (reply) reply.onclick = () => { S.selected = { side: c.side, lineNumber: c.lineNumber }; S.composerBody = ""; S.composerTitle = selectionLabel(); S.editingCommentId = null; placeNearActionPop($("composer")); S.composerOpen = true; setTimeout(() => $("commentBody").focus(), 0); };
  el.querySelectorAll(".edit-comment").forEach((b) => ((b as HTMLButtonElement).onclick = () => editComment((b as HTMLElement).dataset.id!)));
  el.querySelectorAll(".delete-comment").forEach((b) => ((b as HTMLButtonElement).onclick = () => deleteComment((b as HTMLElement).dataset.id!)));
  const resolve = el.querySelector(".resolve-thread") as HTMLButtonElement | null;
  if (resolve) resolve.onclick = () => { S.state.comments.filter((x) => x.path === c.path && x.side === c.side && x.lineNumber === c.lineNumber).forEach((x) => (x.status = "resolved")); render(); toast("Resolved"); persist(); };
  const reopen = el.querySelector(".reopen-thread,.reopen-inline") as HTMLButtonElement | null;
  if (reopen) reopen.onclick = () => { S.state.comments.filter((x) => x.path === c.path && x.side === c.side && x.lineNumber === c.lineNumber).forEach((x) => (x.status = "open")); render(); toast("Reopened"); persist(); };
  return el;
}
