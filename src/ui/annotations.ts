import { S, esc, toast, persist } from "./store";
import {
  currentComments,
  currentChanges,
  currentFile,
  toDisplayLine,
  fromDisplayLine,
} from "./changes";
import { isUnanchored } from "./unanchored";
import { acceptChange } from "./decisions";
import { editComment, deleteComment, turnComment } from "./comments";
import { renderCommentBody } from "./markdown";
import {
  buildComposer,
  buildEditor,
  composerInUi,
  composerTargets,
  openComposer,
} from "./composer";
import { render } from "./render";
import { isBlockSkimCollapsed, skimStripLabel, toggleSkimBlock } from "./skim";
import { answered, turnsInto } from "./uilane-derive";
import type {
  AnnotationInput,
  AnnotationMeta,
  ThreadMeta,
  ThreadMessage,
  ReviewComment,
} from "./types";
import { keycapsHtml } from "./keycaps";
import { cursorChangeId } from "./cursor";

export function annotations(): AnnotationInput[] {
  const threads: AnnotationInput[] = [];
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
      },
    });
  }
  const changes: AnnotationInput[] = [];
  for (const ch of currentChanges().filter((ch) => ch.status === "pending")) {
    const anchor = ch.displayEndLine ?? toDisplayLine(ch.side, ch.endLine ?? ch.lineNumber);
    // A skimmable block gets a collapse/expand strip. While collapsed, skim.ts hides its rows
    // and the strip stands in for it — so suppress the decision bar (it returns on expand).
    // isBlockSkimCollapsed owns the default (expanded for fully-skimmed files, collapsed
    // otherwise) — reading S.skimExpanded directly here would diverge from the row hiding.
    if (ch.skim) {
      const collapsed = isBlockSkimCollapsed(ch);
      changes.push({
        side: ch.side,
        lineNumber: anchor,
        metadata: {
          type: "skim",
          id: ch.id,
          side: ch.side,
          lineNumber: anchor,
          label: skimStripLabel(ch),
          collapsed,
        },
      });
      if (collapsed) continue;
    }
    // With per-change verdicts off no change gets its Undo | Keep control.
    if (!S.settings.perChangeVerdicts) continue;
    changes.push({
      side: ch.side,
      lineNumber: anchor,
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
  // A new line comment (not a reply, not an edit) opens as its own composer annotation
  // under the selected line. Suppressed only when an OPEN thread already sits there — that
  // thread hosts the reply composer itself (in the diff, or in the unanchored strip). A
  // resolved thread renders as a collapsed summary and never hosts a composer, so the new
  // comment still needs its own row. S.selected is display space; groups are keyed raw.
  const composers: AnnotationInput[] = [];
  if (file && S.composerOpen && !S.editingCommentId && !composerInUi()) {
    const rawSel = fromDisplayLine(S.selected.side, S.selected.lineNumber);
    const group = groups.get(`${S.selected.side}:${rawSel}`);
    const openThreadHere = !!group && group.some((c) => c.status === "open");
    if (!openThreadHere)
      composers.push({
        side: S.selected.side,
        lineNumber: S.selected.lineNumber,
        metadata: {
          type: "composer",
          side: S.selected.side,
          lineNumber: S.selected.lineNumber,
          path: file.path,
        },
      });
  }
  // When a thread and a change land on the same display line, the change's control
  // must sit immediately under the hunk with the thread below it — annotations
  // render in array order, so changes go first, the composer last.
  return [...changes, ...threads, ...composers];
}

// The waiting indicator under an unanswered question has three states, derived per
// poll tick from the desk-liveness fields: queued (the question never reached an
// agent — nothing is awaiting), active (delivered, and the agent posted a `galley
// status` line), or plain waiting. Desk-global by design: one desk, one agent.
export function awaitingParts() {
  const queued = S.queuedQuestions > 0;
  return {
    queued,
    label: queued ? "No agent attached — question queued" : "Working",
    activity: queued ? "" : (S.agentActivity ?? ""),
  };
}

// Patch every mounted waiting indicator in place. Called from the 1.5s poll:
// activity/presence changes alone must not trigger a full render() (it rebuilds
// the diff DOM), so the indicator spans are updated directly.
export function updateAwaitingDom() {
  const parts = awaitingParts();
  for (const el of document.querySelectorAll(".awaiting-answer")) {
    el.classList.toggle("queued", parts.queued);
    const label = el.querySelector(".awaiting-label");
    if (label && label.textContent !== parts.label) label.textContent = parts.label;
    const activity = el.querySelector(".agent-activity");
    const text = parts.activity ? ` · ${parts.activity}` : "";
    if (activity && activity.textContent !== text) activity.textContent = text;
  }
}

function awaitingHtml() {
  const parts = awaitingParts();
  return `<div class="awaiting-answer${parts.queued ? " queued" : ""}"><span class="awaiting-label">${esc(parts.label)}</span><span class="agent-activity">${parts.activity ? esc(` · ${parts.activity}`) : ""}</span></div>`;
}

// Coarse relative time for a message ("now", "5m ago", "3h ago", "2d ago", else a date). The
// thread rebuilds on every render/poll, so this refreshes often enough without a live ticker.
function relTime(iso?: string): string {
  if (!iso) return "";
  const t = +new Date(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "now";
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// What a thread's buttons act on. A code thread is the comments on one path/side/line
// (lineThread); a UI annotation's thread is keyed by the annotation's id (uilane.ts).
export type ThreadControls = {
  // Its reply composer is open.
  replying: boolean;
  reply: () => void;
  setStatus: (status: "open" | "resolved") => void;
  edit: (messageId: string) => void;
  remove: (messageId: string) => void;
  // Turn the opening message into the other kind: a change request into a question, or back.
  turn: (messageId: string) => void;
};

// A code thread's controls: its comments are the ones on the thread's path/side/line.
export function lineThread(c: ThreadMeta): ThreadControls {
  return {
    replying: composerTargets(c.side, c.lineNumber),
    reply: () => {
      // S.selected is display space; the thread's anchor is raw.
      S.selected = { side: c.side, lineNumber: toDisplayLine(c.side, c.lineNumber) };
      openComposer();
    },
    setStatus: (status) => {
      S.state.comments
        .filter((x) => x.path === c.path && x.side === c.side && x.lineNumber === c.lineNumber)
        .forEach((x) => (x.status = status));
      render();
      toast(status === "resolved" ? "Resolved" : "Reopened");
      persist();
    },
    edit: editComment,
    remove: deleteComment,
    turn: turnComment,
  };
}

// The comment-box element for one thread (messages + reply/resolve/reopen + per-message
// edit/delete). The one thread component: the diff annotations, the markdown-file view
// (mdfile.ts) and the UI lane's annotation sidebar (uilane.ts) all render through it.
export function buildCommentThread(
  c: { status: "open" | "resolved"; comments: ThreadMessage[] },
  controls: ThreadControls,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "comment-box";
  const replyOpen = controls.replying;
  const messages =
    c.status === "resolved"
      ? `<div class="thread-summary"><b>${c.comments.length}</b> comment${c.comments.length === 1 ? "" : "s"} <span>(Resolved)</span><button class="reopen-inline">Reopen</button></div>`
      : c.comments
          .map((m, i) => {
            const own = m.role !== "agent";
            const editing = S.editingCommentId === m.id;
            const edited =
              m.updatedAt && m.createdAt && m.updatedAt !== m.createdAt ? " · edited" : "";
            // Only a change request wears a badge; a question reads as a plain message (its
            // awaiting line says when it's still waiting on the agent).
            const badge =
              own && m.intent === "action"
                ? '<span class="intent-badge a">Change requested</span>'
                : "";
            const awaiting = own && m.intent === "question" && !answered(m, c.comments);
            // Only the opening message carries the thread's kind, so only it turns.
            const into = i === 0 ? turnsInto(m) : null;
            const label = into === "question" ? "Turn into ask" : "Turn into change request";
            // The glyph stands in for the label in a narrow thread (styles/threads.css, .turn-comment).
            const turn = into
              ? `<button class="turn-comment" data-id="${m.id}" aria-label="${label}" data-tip="${label}" data-tip-align="end"><svg class="turn-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13"/></svg><span class="turn-label">${label}</span></button>`
              : "";
            const actions =
              own && !editing
                ? `<span class="msg-actions">${turn}<button class="edit-comment" data-id="${m.id}">Edit</button><button class="delete-comment" data-id="${m.id}">Delete</button></span>`
                : "";
            // The body is left empty for the message being edited — buildEditor replaces it
            // below (it needs live DOM wiring, not an innerHTML string).
            const body = editing ? "" : `<div class="md">${renderCommentBody(m)}</div>`;
            return `<div class="msg ${own ? "" : "agent"}${editing ? " editing" : ""}" data-id="${m.id}"><div class="meta"><span class="author ${own ? "" : "agent"}">${own ? "You" : "Agent"}</span>${badge}<time>${esc(relTime(m.createdAt))}${edited}</time>${actions}</div>${body}${awaiting ? awaitingHtml() : ""}</div>`;
          })
          .join("");
  // Reply hides while its own composer is open (only Resolve stays); the composer card sits
  // between the last message and the action bar.
  const foot =
    c.status === "resolved"
      ? '<div class="thread-actions"><button class="reopen-thread">Reopen</button></div>'
      : replyOpen
        ? '<div class="thread-actions"><button class="resolve-thread">Resolve</button></div>'
        : '<div class="thread-actions"><button class="reply-thread">Reply</button><button class="resolve-thread">Resolve</button></div>';
  box.innerHTML = `${messages}${foot}`;
  // Mount the in-place editor into the message being edited.
  if (S.editingCommentId && c.status !== "resolved") {
    const msgEl = box.querySelector(`.msg[data-id="${S.editingCommentId}"]`);
    msgEl?.appendChild(buildEditor());
  }
  // Mount the reply composer above the action bar.
  if (replyOpen && c.status !== "resolved")
    box.querySelector(".thread-actions")?.before(buildComposer());
  const reply = box.querySelector(".reply-thread") as HTMLButtonElement | null;
  if (reply) reply.onclick = controls.reply;
  box
    .querySelectorAll(".edit-comment")
    .forEach(
      (b) =>
        ((b as HTMLButtonElement).onclick = () => controls.edit((b as HTMLElement).dataset.id!)),
    );
  box
    .querySelectorAll(".turn-comment")
    .forEach(
      (b) =>
        ((b as HTMLButtonElement).onclick = () => controls.turn((b as HTMLElement).dataset.id!)),
    );
  box
    .querySelectorAll(".delete-comment")
    .forEach(
      (b) =>
        ((b as HTMLButtonElement).onclick = () => controls.remove((b as HTMLElement).dataset.id!)),
    );
  const resolve = box.querySelector(".resolve-thread") as HTMLButtonElement | null;
  if (resolve) resolve.onclick = () => controls.setStatus("resolved");
  const reopen = box.querySelector(".reopen-thread,.reopen-inline") as HTMLButtonElement | null;
  if (reopen) reopen.onclick = () => controls.setStatus("open");
  return box;
}

// `a` is @pierre/diffs' annotation callback argument (loose by contract); the
// metadata we tucked into it is our own typed AnnotationMeta.
export function renderAnnotation(a: { metadata: AnnotationMeta }) {
  const c = a.metadata;
  // A new-comment composer injected under the selected line (reply/edit render inside a
  // thread instead — see buildCommentThread).
  if (c.type === "composer") {
    const el = document.createElement("div");
    el.className = "annotation composer-annotation";
    el.appendChild(buildComposer());
    return el;
  }
  // The skim collapse/expand strip standing in for a skimmable block (skim.ts hides the rows
  // while collapsed). One click toggles; it re-renders as an annotation, so it survives in
  // both split and stacked views.
  if (c.type === "skim") {
    const el = document.createElement("div");
    el.className = "annotation skim-strip" + (c.collapsed ? " collapsed" : " expanded");
    el.innerHTML = `<button class="skim-toggle"><span class="skim-caret">${c.collapsed ? "▸" : "▾"}</span><span class="skim-label">${esc(c.label)}</span><span class="skim-action">${c.collapsed ? "Expand" : "Collapse"}</span></button>`;
    (el.querySelector(".skim-toggle") as HTMLButtonElement).onclick = () => toggleSkimBlock(c.id);
    return el;
  }
  // A pending change's Undo | Keep, under its last changed line. Every control carries its
  // keycaps; only the one the cursor marks shows them (cursor.ts markCursorChange).
  if (c.type === "change") {
    const el = document.createElement("div");
    // Classic indicators draw +/− signs ahead of the code, so the code column sits further in.
    el.className =
      "annotation verdict-row" + (S.settings.diffIndicators === "classic" ? " signs" : "");
    const control = document.createElement("div");
    control.className = "verdict seg xs" + (c.id === cursorChangeId() ? " at-cursor" : "");
    control.dataset.change = c.id;
    control.setAttribute("role", "group");
    control.setAttribute("aria-label", "Decide this change");
    const decide = (cls: string, label: string, keys: string, status: "accepted" | "rejected") => {
      const b = document.createElement("button");
      b.className = cls;
      b.innerHTML = `${label} ${keycapsHtml(keys)}`;
      b.onclick = () => acceptChange(c.id, status);
      return b;
    };
    control.append(
      decide("reject", "Undo", "⇧N", "rejected"),
      decide("accept", "Keep", "⇧Y", "accepted"),
    );
    el.appendChild(control);
    return el;
  }
  const el = document.createElement("div");
  el.className = `annotation ${c.status === "resolved" ? "resolved" : ""}`;
  el.appendChild(buildCommentThread(c, lineThread(c)));
  return el;
}
