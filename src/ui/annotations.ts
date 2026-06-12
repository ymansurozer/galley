import { S, $, toast, persist } from "./store";
import { currentComments, currentChanges, currentFile, toDisplayLine } from "./changes";
import { isUnanchored } from "./unanchored";
import { acceptChange } from "./decisions";
import { editComment, deleteComment } from "./comments";
import { renderCommentBody } from "./markdown";
import { selectionLabel, placeNearActionPop } from "./selection";
import { render } from "./render";
import type { AnnotationInput, AnnotationMeta, ThreadMeta, ReviewComment } from "./types";

export function annotations(): AnnotationInput[] {
  const threads: AnnotationInput[] = [];
  const seen = new Set<string>();
  const groups = new Map<string, ReviewComment[]>();
  for (const c of currentComments()) {
    const key = `${c.side}:${c.lineNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const file = currentFile();
  for (const comments of groups.values()) {
    comments.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    const first = comments[0];
    // Open threads whose anchor is gone render in the strip above the diff instead
    // (an annotation at a non-existent line would silently never attach).
    if (
      file &&
      comments.some((c) => c.status === "open") &&
      comments.some((c) => isUnanchored(c, file))
    )
      continue;
    const change = currentChanges().find(
      (ch) =>
        ch.status === "pending" && ch.side === first.side && ch.lineNumber === first.lineNumber,
    );
    if (change) seen.add(change.id);
    // The annotation goes to @pierre in DISPLAY coordinates (it matches rendered gutter
    // numbers); the metadata keeps the raw line so thread actions filter comments correctly.
    threads.push({
      side: first.side,
      lineNumber: toDisplayLine(first.side, first.lineNumber),
      metadata: {
        type: "thread",
        path: first.path,
        side: first.side,
        lineNumber: first.lineNumber,
        status: comments.some((c) => c.status === "open") ? "open" : "resolved",
        comments,
        changeId: change?.id,
      },
    });
  }
  const changes: AnnotationInput[] = [];
  for (const ch of currentChanges().filter((ch) => ch.status === "pending" && !seen.has(ch.id))) {
    changes.push({
      side: ch.side,
      lineNumber: ch.displayEndLine ?? toDisplayLine(ch.side, ch.endLine ?? ch.lineNumber),
      metadata: {
        type: "change",
        id: ch.id,
        side: ch.side,
        lineNumber: ch.lineNumber,
        title: ch.title,
        path: ch.path,
      },
    });
  }
  // When a thread and a change land on the same display line, the decision bar
  // must sit immediately under the hunk with the thread below it — annotations
  // render in array order, so changes go first.
  return [...changes, ...threads];
}

// The comment-box element for one thread (messages + reply/resolve/reopen + per-message
// edit/delete). Shared by the diff annotations and the markdown-file view (mdfile.ts).
export function buildCommentThread(c: ThreadMeta): HTMLElement {
  const box = document.createElement("div");
  box.className = "comment-box";
  const messages =
    c.status === "resolved"
      ? `<div class="thread-summary"><b>${c.comments.length}</b> comment${c.comments.length === 1 ? "" : "s"} <span>(Resolved)</span><button class="reopen-inline">Reopen</button></div>`
      : c.comments
          .map((m) => {
            const own = m.role !== "agent";
            const edited =
              m.updatedAt && m.createdAt && m.updatedAt !== m.createdAt ? " · edited" : "";
            const badge =
              own && m.intent === "question"
                ? '<span class="intent-badge q">Question</span>'
                : own && m.intent === "action"
                  ? '<span class="intent-badge a">Change requested</span>'
                  : "";
            // A question is "answered" once an agent reply lands after it in this thread.
            const awaiting =
              own &&
              m.intent === "question" &&
              !c.comments.some(
                (x) => x.role === "agent" && +new Date(x.createdAt) > +new Date(m.createdAt),
              );
            const actions = own
              ? `<span class="msg-actions"><button class="edit-comment" data-id="${m.id}">Edit</button><button class="delete-comment" data-id="${m.id}">Delete</button></span>`
              : "";
            return `<div class="msg ${own ? "" : "agent"}"><div class="meta"><span class="author ${own ? "" : "agent"}">${own ? "You" : "Agent"}</span>${badge}<time>now${edited}</time>${actions}</div><div class="md">${renderCommentBody(m)}</div>${awaiting ? '<div class="awaiting-answer">Waiting for answer…</div>' : ""}</div>`;
          })
          .join("");
  box.innerHTML = `${messages}<div class="thread-actions">${c.status === "resolved" ? '<button class="reopen-thread">Reopen</button>' : '<button class="reply-thread">Reply</button><button class="resolve-thread">Resolve</button>'}</div>`;
  const reply = box.querySelector(".reply-thread") as HTMLButtonElement | null;
  if (reply)
    reply.onclick = () => {
      // S.selected is display space; the thread's anchor is raw.
      S.selected = { side: c.side, lineNumber: toDisplayLine(c.side, c.lineNumber) };
      S.composerBody = "";
      S.composerTitle = selectionLabel();
      S.editingCommentId = null;
      placeNearActionPop($("composer"));
      S.composerOpen = true;
      setTimeout(() => $("commentBody").focus(), 0);
    };
  box
    .querySelectorAll(".edit-comment")
    .forEach(
      (b) => ((b as HTMLButtonElement).onclick = () => editComment((b as HTMLElement).dataset.id!)),
    );
  box
    .querySelectorAll(".delete-comment")
    .forEach(
      (b) =>
        ((b as HTMLButtonElement).onclick = () => deleteComment((b as HTMLElement).dataset.id!)),
    );
  const resolve = box.querySelector(".resolve-thread") as HTMLButtonElement | null;
  if (resolve)
    resolve.onclick = () => {
      S.state.comments
        .filter((x) => x.path === c.path && x.side === c.side && x.lineNumber === c.lineNumber)
        .forEach((x) => (x.status = "resolved"));
      render();
      toast("Resolved");
      persist();
    };
  const reopen = box.querySelector(".reopen-thread,.reopen-inline") as HTMLButtonElement | null;
  if (reopen)
    reopen.onclick = () => {
      S.state.comments
        .filter((x) => x.path === c.path && x.side === c.side && x.lineNumber === c.lineNumber)
        .forEach((x) => (x.status = "open"));
      render();
      toast("Reopened");
      persist();
    };
  return box;
}

// `a` is @pierre/diffs' annotation callback argument (loose by contract); the
// metadata we tucked into it is our own typed AnnotationMeta.
export function renderAnnotation(a: { metadata: AnnotationMeta }) {
  const c = a.metadata;
  const change =
    c.type === "change"
      ? S.state.changes.find((x) => x.id === c.id)
      : c.changeId
        ? S.state.changes.find((x) => x.id === c.changeId)
        : null;
  const el = document.createElement("div");
  el.className = `annotation ${c.type === "thread" && c.status === "resolved" ? "resolved" : ""}`;
  if (c.type === "change") {
    el.innerHTML = `<div class="change-actions"><button class="reject">Undo <kbd>⇧N</kbd></button><button class="accept">Keep <kbd>⇧Y</kbd></button></div>`;
  } else {
    el.appendChild(buildCommentThread(c));
    if (change) {
      const ca = document.createElement("div");
      ca.className = "change-actions";
      ca.innerHTML = `<button class="reject">Undo <kbd>⇧N</kbd></button><button class="accept">Keep <kbd>⇧Y</kbd></button>`;
      el.appendChild(ca);
    }
  }
  const acceptButton = el.querySelector(".accept");
  const rejectButton = el.querySelector(".reject");
  if (change && acceptButton && rejectButton) {
    (acceptButton as HTMLButtonElement).onclick = () => acceptChange(change.id, "accepted");
    (rejectButton as HTMLButtonElement).onclick = () => acceptChange(change.id, "rejected");
  }
  return el;
}
