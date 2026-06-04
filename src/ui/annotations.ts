import { S, $, show, esc, toast, persist } from "./store";
import { currentComments, currentChanges } from "./changes";
import { acceptChange } from "./decisions";
import { selectionLabel, placeNearActionPop } from "./selection";
import { render } from "./render";

export function annotations() {
  const out: any[] = [];
  const seen = new Set();
  const groups = new Map<string, any[]>();
  for (const c of currentComments()) {
    const key = `${c.side}:${c.lineNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  for (const comments of groups.values()) {
    comments.sort((a: any, b: any) => (new Date(a.createdAt) as any) - (new Date(b.createdAt) as any));
    const first = comments[0];
    const change = currentChanges().find((ch: any) => ch.status === "pending" && ch.side === first.side && ch.lineNumber === first.lineNumber);
    if (change) seen.add(change.id);
    out.push({ side: first.side, lineNumber: first.lineNumber, metadata: { type: "thread", path: first.path, side: first.side, lineNumber: first.lineNumber, status: comments.some((c: any) => c.status === "open") ? "open" : "resolved", comments, changeId: change?.id } });
  }
  for (const ch of currentChanges().filter((ch: any) => ch.status === "pending" && !seen.has(ch.id))) {
    out.push({ side: ch.side, lineNumber: ch.endLine ?? ch.lineNumber, metadata: { type: "change", id: ch.id, side: ch.side, lineNumber: ch.lineNumber, title: ch.title, path: ch.path } });
  }
  return out;
}

export function renderAnnotation(a: any) {
  const c = a.metadata;
  const change = c.type === "change" ? S.state.changes.find((x: any) => x.id === c.id) : (c.changeId ? S.state.changes.find((x: any) => x.id === c.changeId) : null);
  const el = document.createElement("div");
  el.className = `annotation ${c.status === "resolved" ? "resolved" : ""}`;
  if (c.type === "change") {
    el.innerHTML = `<div class="change-actions"><button class="reject">Undo</button><button class="accept">Keep</button></div>`;
  } else {
    const messages = c.status === "resolved"
      ? `<div class="thread-summary"><b>${c.comments.length}</b> comment${c.comments.length === 1 ? "" : "s"} <span>(Resolved)</span><button class="reopen-inline">Reopen</button></div>`
      : c.comments.map((m: any) => `<div class="msg ${m.role === "agent" ? "agent" : ""}"><div class="meta"><span class="author ${m.role === "agent" ? "agent" : ""}">${m.role === "agent" ? "Agent" : "You"}</span><time>now</time></div><p>${esc(m.body)}</p></div>`).join("");
    el.innerHTML = `<div class="comment-box">${messages}<div class="thread-actions">${c.status === "resolved" ? '<button class="reopen-thread">Reopen</button>' : '<button class="reply-thread">Reply</button><button class="resolve-thread">Resolve</button>'}</div></div>${change ? `<div class="change-actions"><button class="reject">Undo</button><button class="accept">Keep</button></div>` : ""}`;
  }
  const acceptButton = el.querySelector(".accept");
  const rejectButton = el.querySelector(".reject");
  if (change && acceptButton && rejectButton) { (acceptButton as any).onclick = () => acceptChange(change.id, "accepted"); (rejectButton as any).onclick = () => acceptChange(change.id, "rejected"); }
  const reply = el.querySelector(".reply-thread");
  if (reply) (reply as any).onclick = () => { S.selected = { side: c.side, lineNumber: c.lineNumber }; $("commentBody").value = ""; $("composerTitle").textContent = selectionLabel(); placeNearActionPop($("composer")); show($("composer")); $("commentBody").focus(); };
  const resolve = el.querySelector(".resolve-thread");
  if (resolve) (resolve as any).onclick = () => { S.state.comments.filter((x: any) => x.path === c.path && x.side === c.side && x.lineNumber === c.lineNumber).forEach((x: any) => (x.status = "resolved")); render(); toast("Resolved"); persist(); };
  const reopen = el.querySelector(".reopen-thread,.reopen-inline");
  if (reopen) (reopen as any).onclick = () => { S.state.comments.filter((x: any) => x.path === c.path && x.side === c.side && x.lineNumber === c.lineNumber).forEach((x: any) => (x.status = "open")); render(); toast("Reopened"); persist(); };
  return el;
}
