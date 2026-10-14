import { S, D, esc, toast, persist } from "./store";
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
import { firstLine, turnsInto } from "./uilane-derive";
import { agentPresence } from "./topbar-derive";
import { asksChange } from "./requests-derive";
import {
  lineLabel,
  questionWaiting,
  showsHeld,
  threadKind,
  type ThreadKind,
} from "./thread-derive";
import type {
  AnnotationInput,
  AnnotationMeta,
  ThreadMeta,
  ThreadMessage,
  ReviewComment,
} from "./types";
import { keycapsHtml } from "./keycaps";
import { cursorChangeId } from "./cursor";
import { changeBlocks, threadGroups } from "./thread-groups";
import { threadGroupElement, threadKey, threadSlot } from "./rests";

export function annotations(): AnnotationInput[] {
  const lineThreads: (ThreadMeta & { line: number })[] = [];
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
    const t: ThreadMeta = {
      type: "thread",
      path: first.path,
      side: first.side,
      lineNumber: first.lineNumber,
      status: comments.some((c) => c.status === "open") ? "open" : "resolved",
      comments,
    };
    lineThreads.push({ ...t, line: t.lineNumber });
  }
  // A reply or an edit happens in its thread's card, so that thread is the open one.
  const editing = S.editingCommentId
    ? S.state.comments.find((c) => c.id === S.editingCommentId && c.path === file?.path)
    : undefined;
  const replying =
    S.composerOpen && !editing && !composerInUi()
      ? lineThreads.find((t) => t.status === "open" && composerTargets(t.side, t.lineNumber))
      : undefined;
  const composing = editing ? threadKey(editing) : replying && threadKey(replying);
  if (composing) S.openThread = composing;
  // One annotation per group of nearby threads, at its last line. It goes to @pierre in DISPLAY
  // coordinates (it matches rendered gutter numbers); the threads keep their raw lines so thread
  // actions filter comments correctly.
  const blocks = D.fileDiff ? changeBlocks(D.fileDiff) : [];
  const threads: AnnotationInput[] = threadGroups(lineThreads, toDisplayLine, blocks).map((g) => ({
    side: g.side,
    lineNumber: g.line,
    metadata: { type: "group", side: g.side, lineNumber: g.line, threads: g.threads },
  }));
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
  // under the selected line. Suppressed only when it's a reply: an OPEN thread sits there and
  // hosts the composer in its card. A resolved thread never hosts one, so a new comment on its
  // line still needs its own row.
  const composers: AnnotationInput[] = [];
  if (file && S.composerOpen && !S.editingCommentId && !composerInUi()) {
    if (!replying)
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

// The waiting band under an unanswered question has three states, derived per poll tick from
// the desk-liveness fields: queued (the question never reached an agent — nothing is awaiting),
// active (delivered, and the agent posted a `galley status` line), or plain waiting. It's the top
// bar's presence rule (topbar-derive) asked about this one question, sent review or not, so the
// two never disagree. Desk-global by design: one desk, one agent.
export function awaitingParts() {
  const presence = agentPresence({
    awaitingAgent: false,
    queuedReviews: 0,
    queuedQuestions: S.queuedQuestions,
    activity: S.agentActivity,
    unansweredAsks: 1,
  });
  // "Working · <activity>" splits into its label and the activity, which reads brighter.
  const [label = "Working", ...activity] =
    presence.kind === "hidden" ? [] : presence.line.split(" · ");
  return { queued: presence.kind === "notAttached", label, activity: activity.join(" · ") };
}

// Patch every mounted waiting band in place, and show or hide the held bands. Called from the
// 1.5s poll and on Send: activity/presence changes alone must not trigger a full render() (it
// rebuilds the diff DOM), so the bands are updated directly.
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
  // Only a change request draws a held band, so the review's sent state alone decides it.
  const hide = !showsHeld(true, S.awaitingAgent);
  for (const el of document.querySelectorAll<HTMLElement>(".tc-band.held"))
    if (el.hidden !== hide) el.hidden = hide;
}

function awaitingHtml() {
  const parts = awaitingParts();
  return `<div class="tc-band awaiting-answer${parts.queued ? " queued" : ""}"><span class="tc-spin" aria-hidden="true"></span><span><span class="awaiting-label">${esc(parts.label)}</span><span class="agent-activity">${parts.activity ? esc(` · ${parts.activity}`) : ""}</span></span></div>`;
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
      // Resolving closes the thread's own reply composer while it holds no draft: there's nothing
      // left to reply to, and it would come back on the line as a new comment. A draft stays.
      if (status === "resolved" && composerTargets(c.side, c.lineNumber) && !S.composerBody.trim())
        S.composerOpen = false;
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

// Glyphs the sprite doesn't carry: a question's bubble, and the two avatars.
const BUBBLE =
  '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.4c0-2.7 2.5-4.65 5.5-4.65s5.5 1.95 5.5 4.65S11 12.05 8 12.05c-.6 0-1.15-.07-1.68-.2L3.4 13.3l.75-2.4C3.12 10 2.5 8.8 2.5 7.4Z"/></svg>';
const AVATAR = {
  you: '<span class="av"><svg viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><circle cx="5" cy="3.4" r="2"/><path d="M1.3 9.3c.4-2.1 1.9-3.2 3.7-3.2s3.3 1.1 3.7 3.2z"/></svg></span>',
  agent:
    '<span class="av agent"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 3 4.4 5 2.2 7M5.6 7.4h2.4"/></svg></span>',
};
const sprite = (id: string) => `<svg class="ic"><use href="#gly-${id}"></use></svg>`;
export const KINDS: Record<ThreadKind, { label: string; glyph: string }> = {
  change: { label: "Change request", glyph: sprite("flag") },
  question: { label: "Question", glyph: BUBBLE },
  note: { label: "Note", glyph: sprite("page-note") },
  agent: { label: "Agent note", glyph: sprite("page-note") },
  resolved: { label: "Resolved", glyph: sprite("check") },
};

// A thread as its card draws it. A code thread's card names what it is and where it sits in a
// header (`loc`, struck through when the thread lost its line), and closes with the held band
// while its change request waits for Send. The UI lane's row names its annotation itself, so it
// passes no head.
export type ThreadView = {
  status: "open" | "resolved";
  comments: ThreadMessage[];
  head?: { kind: ThreadKind; loc: string; lost?: boolean; held: boolean };
};

const locHtml = (head: { loc: string; lost?: boolean }) =>
  head.lost
    ? `<span class="tc-loc" title="This thread lost its line"><s>${esc(head.loc)}</s></span>`
    : `<span class="tc-loc">${esc(head.loc)}</span>`;

function headHtml(c: ThreadView, head: NonNullable<ThreadView["head"]>) {
  const { label, glyph } = KINDS[head.kind];
  const state =
    head.kind !== "question"
      ? ""
      : questionWaiting(c.comments)
        ? "waiting"
        : c.comments.at(-1)?.role === "agent"
          ? "answered"
          : "";
  return `<div class="tc-head"><span class="tc-kind">${glyph}${label}</span>${state ? `<span class="tc-state">· ${state}</span>` : ""}${locHtml(head)}</div>`;
}

// The card for one thread: its header, the messages (each with its author's avatar, and the
// reviewer's own with Edit / Delete / Turn into), the band its state ends in, then Reply… and
// Resolve. A resolved thread rests as one line with Reopen. The one thread component: the diff
// annotations, the unanchored block, the markdown-file view (mdfile.ts) and the UI lane's
// annotation sidebar (uilane.ts) all render through it.
export function buildCommentThread(c: ThreadView, controls: ThreadControls): HTMLElement {
  const box = document.createElement("div");
  box.className = `comment-box thread-card${c.head ? ` k-${c.head.kind}` : ""}`;
  const replyOpen = controls.replying;
  // The UI lane's resolved row rests as one line; a code thread's card opens on the whole thread.
  if (c.status === "resolved" && !c.head) {
    box.classList.add("resolved");
    const n = c.comments.length;
    const first = firstLine(c.comments[0]?.body ?? "");
    box.innerHTML = `<div class="thread-summary">${KINDS.resolved.glyph}<b>Resolved</b><span class="tc-state">· ${n} message${n === 1 ? "" : "s"}</span><span class="tc-first">${esc(first)}</span>${c.head ? locHtml(c.head) : ""}<button class="reopen-inline">Reopen</button></div>`;
    // The summary just written always carries Reopen.
    const reopen = box.querySelector(".reopen-inline") as HTMLButtonElement;
    reopen.onclick = () => controls.setStatus("open");
    return box;
  }
  const messages = c.comments
    .map((m, i) => {
      const own = m.role !== "agent";
      const editing = S.editingCommentId === m.id;
      const edited = m.updatedAt && m.createdAt && m.updatedAt !== m.createdAt ? " · edited" : "";
      // Only a change request wears a badge; a question reads as a plain message (the waiting
      // band says when it's still waiting on the agent). A change request's own card says so in
      // its header, so its opening message needs none.
      const badge =
        own && m.intent === "action" && !(i === 0 && c.head?.kind === "change")
          ? '<span class="intent-badge a">Change requested</span>'
          : "";
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
      return `<div class="msg${own ? "" : " agent"}${editing ? " editing" : ""}" data-id="${m.id}"><div class="meta">${own ? AVATAR.you : AVATAR.agent}<span class="author${own ? "" : " agent"}">${own ? "You" : "Agent"}</span>${badge}<time>${esc(relTime(m.createdAt))}${edited}</time>${actions}</div>${body}</div>`;
    })
    .join("");
  // The bands: waiting on the agent (live-patched by updateAwaitingDom), then held for Send. A
  // held band hides once the review is sent: the agent has it then.
  const resolved = c.status === "resolved";
  const waiting = !resolved && questionWaiting(c.comments) ? awaitingHtml() : "";
  const held = c.head?.held
    ? `<div class="tc-band held"${showsHeld(c.head.held, S.awaitingAgent) ? "" : " hidden"}>${sprite("flag")}<span>Held — goes with Send</span></div>`
    : "";
  // Reply… hides while its own composer is open (only Resolve stays); the composer sits between
  // the bands and the actions. A resolved thread's card offers Reopen instead.
  const foot = resolved
    ? '<div class="thread-actions"><span class="tc-kept">Resolved — kept here for reference</span><button class="reopen-inline">Reopen</button></div>'
    : `<div class="thread-actions">${replyOpen ? "" : '<button class="reply-thread">Reply…</button>'}<button class="resolve-thread">Resolve</button></div>`;
  box.innerHTML = `${c.head ? headHtml(c, c.head) : ""}${messages}${waiting}${held}${foot}`;
  // Mount the in-place editor into the message being edited.
  if (S.editingCommentId) {
    const msgEl = box.querySelector(`.msg[data-id="${S.editingCommentId}"]`);
    msgEl?.appendChild(buildEditor());
  }
  // The reply composer takes the footer's place, and Resolve leads its action row, so the card
  // still ends in one row.
  if (replyOpen) {
    const composer = buildComposer();
    const actions = box.querySelector(".thread-actions") as HTMLElement; // written just above
    composer.querySelector(".crow")?.prepend(...actions.children);
    actions.replaceWith(composer);
  }
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
  // The footer carries Resolve on an open thread, Reopen on a resolved one.
  const act = box.querySelector(".resolve-thread, .reopen-inline") as HTMLButtonElement;
  act.onclick = () => controls.setStatus(resolved ? "open" : "resolved");
  return box;
}

// A code thread's card, wherever the thread shows: on its line in the diff, in the unanchored
// block (`lost`), or under its block in the rendered markdown view.
export function threadCard(t: ThreadMeta, lost = false): HTMLElement {
  const asks = t.comments.some(asksChange);
  const head = {
    kind: threadKind(t.status, t.comments),
    loc: lineLabel(t.lineNumber, t.comments[0]?.endLine),
    lost,
    held: asks,
  };
  return buildCommentThread({ ...t, head }, lineThread(t));
}

// The new-comment composer as a card at its line: what it is and where, then the reviewer's
// composer. S.selected is display space; the header names the file's own line.
export function composerCard(): HTMLElement {
  const { side, lineNumber, endLine } = S.selected;
  const loc = lineLabel(
    fromDisplayLine(side, lineNumber),
    endLine === undefined ? undefined : fromDisplayLine(side, endLine),
  );
  const card = document.createElement("div");
  card.className = "comment-box thread-card k-new";
  card.innerHTML = `<div class="tc-head"><span class="tc-kind">${BUBBLE}New comment</span>${locHtml({ loc })}</div><div class="meta">${AVATAR.you}<span class="author">You</span></div>`;
  card.appendChild(buildComposer());
  return card;
}

// Open threads whose anchor line no longer renders, as a block at the top of the diff: their
// rests, which open in place like any thread, the old line struck through, so they stay
// actionable (they block approval until resolved). Each slot keeps `data-thread`, the target
// `]` / `[` and the blockers list jump to.
export function unanchoredBlock(orphans: ThreadMeta[]): HTMLElement {
  const block = document.createElement("div");
  block.className = "unanchored-strip";
  const head = document.createElement("div");
  head.className = "unanchored-head";
  head.innerHTML = `${sprite("warn")}<b>${orphans.length} comment thread${orphans.length === 1 ? "" : "s"} lost ${orphans.length === 1 ? "its" : "their"} place in this diff</b><span>resolve or reply here; ${orphans.length === 1 ? "it blocks" : "they block"} approval until then</span>`;
  block.appendChild(head);
  for (const t of orphans) {
    const box = document.createElement("div");
    box.className = "annotation";
    box.appendChild(threadSlot(t, true));
    block.appendChild(box);
  }
  return block;
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
    el.appendChild(composerCard());
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
  return threadGroupElement(c);
}
