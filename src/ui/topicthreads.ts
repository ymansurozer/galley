import { S, $, persist, saver, toast } from "./store";
import {
  buildCommentThread,
  newCommentCard,
  updateAwaitingDom,
  type ThreadControls,
} from "./annotations";
import {
  closeComposer,
  composerInTopics,
  openTopicComposer,
  restoreComposerFocus,
} from "./composer";
import { openTopic, renderTopics } from "./topics";
import { setView } from "./appview";
import { threadKind } from "./thread-derive";
import { askStamp, firstLine, turnAnnotationInto, turnsInto } from "./uilane-derive";
import {
  askOf,
  composerPlace,
  partRank,
  requestsChange,
  threadPlace,
  threadSlot,
  threadsOf,
  topicBlockers,
  topicParts,
  topicRequestList,
  type TopicRequest,
} from "./topicthreads-derive";
import { markParts, topicBlockersChip, underPart } from "./topicthreads-dom";
import { uuid } from "./uuid";
import type { GuideTopic, TopicThread } from "../types";

// The threads on a topic's parts (ReviewState.topicThreads): the gutter button, ⇧ click and the
// keyboard's cursor that open the composer on a part, the threads drawn under their parts with the
// code lane's thread component, Ask and Request change, and the topic's change requests in the
// walk and on its bar. topics.ts draws the page; decorateTopicPage makes it commentable.

const threads = () => S.state?.topicThreads ?? [];
const find = (id: string | null) => threads().find((t) => t.id === id);
const stages = () => S.state?.guide?.stages ?? [];

// The keyboard's cursor: the part it is on, by topic, and whether its rail shows. The rail shows
// once j or k has been pressed, and a click on the page hides it again.
const cursorAt = new Map<string, string>();
let railShown = false;

const partsOf = (topic: GuideTopic) => topicParts(topic, S.state.topics?.[topic.id]);

// Draw what makes the open topic's page commentable, once renderTopicPage has drawn it: its parts,
// each part's threads under it, the composer when it is open on this topic, and the bar's blockers.
export function decorateTopicPage(host: HTMLElement, topic: GuideTopic) {
  const page = host.querySelector<HTMLElement>(".topic-page");
  if (!page) return;
  const parts = partsOf(topic);
  const mine = threadsOf(threads(), topic.id);
  const has = new Set(mine.filter((t) => t.status === "open").map((t) => t.target.part));
  const cursor = cursorAt.get(topic.id) ?? parts[0] ?? null;
  const marked = markParts(page, parts, cursor, has);
  page.classList.toggle("topic-kb", railShown);
  // A thread whose part isn't on the page (its block went with a guide the tab hasn't taken yet)
  // sits with the title's.
  const holder = (part: string) => marked.get(threadSlot(part)) ?? marked.get("recorded");
  for (const t of mine) {
    const at = holder(t.target.part);
    if (at) underPart(at).append(threadCard(t));
  }
  const draft = S.composerOpen && !S.composerTopic ? S.topicDraft : null;
  if (draft?.topic === topic.id) {
    const at = holder(draft.part);
    const card = document.createElement("div");
    card.className = "annotation topic-thread";
    card.append(newCommentCard(composerPlace(draft.part)));
    if (at) underPart(at).append(card);
  }
  const chip = topicBlockersChip(
    document,
    topicBlockers(threads(), topic.id).map((t) => ({
      id: t.id,
      where: partName(t.target.part),
      text: firstLine(askOf(t)?.body ?? ""),
    })),
  );
  if (chip) {
    host.querySelector(".topics-bar .fb-actions")?.prepend(chip);
    wireChip(chip);
  }
  if (composerInTopics()) restoreComposerFocus();
}

// How the blockers list names a part.
function partName(part: string) {
  if (part === "title") return "Title";
  if (part === "recorded") return "Recorded";
  if (part === "flag") return "Flagged";
  return part.startsWith("body:") ? "Body" : part;
}

function wireChip(wrap: HTMLElement) {
  const btn = wrap.querySelector<HTMLButtonElement>(".blockers-chip")!; // topicBlockersChip's own
  const close = () => {
    wrap.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
  };
  const outside = (e: MouseEvent) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (wrap.classList.contains("open")) return close();
    wrap.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", outside, true);
  };
  for (const row of wrap.querySelectorAll<HTMLElement>("[data-thread]"))
    row.onclick = () => {
      close();
      landOnThread(row.dataset.thread!);
    };
}

// A thread's card: the code lane's thread component, its header naming what it is and, where its
// place doesn't say it, where it sits. A resolved one rests as one line with Reopen.
function threadCard(t: TopicThread): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "annotation topic-thread";
  wrap.dataset.thread = t.id;
  const head =
    t.status === "resolved"
      ? undefined
      : {
          kind: threadKind(t.status, t.comments),
          loc: threadPlace(t),
          held: requestsChange(t),
        };
  wrap.append(buildCommentThread({ ...t, head }, controls(t), "chrome"));
  return wrap;
}

function controls(t: TopicThread): ThreadControls {
  return {
    replying: S.composerOpen && !S.editingCommentId && S.composerTopic === t.id,
    reply: () => openTopicComposer(null, t.id),
    setStatus: (status) => {
      if (S.composerTopic === t.id) closeComposer();
      t.status = status;
      renderTopics();
      persist();
    },
    edit: (messageId) => {
      const m = t.comments.find((x) => x.id === messageId);
      if (!m || m.role === "agent") return;
      openTopicComposer(null, t.id, m.body, m.id);
    },
    turn: (messageId) => {
      const opener = t.comments[0];
      const intent = opener?.id === messageId ? turnsInto(opener) : null;
      if (!opener || !intent) return;
      turnAnnotationInto(t, intent, new Date().toISOString());
      renderTopics();
      persist();
      if (intent === "question") void askAgent(t.id, opener.id);
    },
    // The opening message is what the thread asks: deleting it deletes the thread.
    remove: (messageId) => {
      if (S.composerTopic === t.id) closeComposer();
      if (t.comments[0]?.id === messageId)
        S.state.topicThreads = threads().filter((x) => x.id !== t.id);
      else t.comments = t.comments.filter((m) => m.id !== messageId);
      renderTopics();
      persist();
    },
  };
}

// Hand a question to the agent now, once the save carrying it has landed: the desk builds the
// question event from its stored copy of the thread. One whose save didn't land waits for the next
// Send, as one the desk couldn't deliver. A turn made while the save drained supersedes this ask.
async function askAgent(threadId: string, messageId: string) {
  const message = () => find(threadId)?.comments.find((m) => m.id === messageId);
  const asked = askStamp(message());
  const saved = await saver.settled();
  if (askStamp(message()) !== asked) return;
  const res = saved
    ? await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicThreadId: threadId, messageId }),
      }).catch(() => null)
    : null;
  if (res?.ok) S.undeliveredAsks.delete(messageId);
  else {
    S.undeliveredAsks.add(messageId);
    toast("Couldn't reach the agent — the question goes with the next Send");
    updateAwaitingDom();
  }
}

// Submit the topic page's open composer, as a change request ("action") or a question: a new
// thread on the part it is open on, a reply in a thread, or an edited message (which keeps its
// intent, as in the other lanes).
export function submitTopicComposer(intent: "action" | "question") {
  const body = S.composerBody.trim();
  if (!body) return;
  const now = new Date().toISOString();
  const draft = S.topicDraft;
  const t = find(S.composerTopic);
  const message = {
    id: uuid(),
    role: "user" as const,
    intent,
    body,
    createdAt: now,
    updatedAt: now,
  };
  let asked: { thread: string; message: string } | null = null;
  if (S.editingCommentId) {
    const m = t?.comments.find((x) => x.id === S.editingCommentId);
    if (m) {
      m.body = body;
      m.updatedAt = now;
    }
  } else if (draft) {
    const topic = stages()
      .flatMap((s) => s.groups.flatMap((g) => g.topics))
      .find((x) => x.id === draft.topic);
    const created: TopicThread = {
      id: uuid(),
      target: { topic: draft.topic, part: draft.part },
      title: topic?.title ?? "",
      intent: intent === "question" ? "question" : "change",
      status: "open",
      comments: [message],
    };
    (S.state.topicThreads ??= []).push(created);
    if (intent === "question") asked = { thread: created.id, message: message.id };
  } else if (t) {
    t.comments.push(message);
    if (intent === "question") asked = { thread: t.id, message: message.id };
  }
  closeComposer();
  persist();
  if (asked) void askAgent(asked.thread, asked.message);
}

// ── Opening the composer on a part ───────────────────────────────────────────────────────────────

export function commentOn(part: string) {
  if (S.topicAt === null) return;
  cursorAt.set(S.topicAt, part);
  openTopicComposer({ topic: S.topicAt, part });
}

// c and ↵ on a topic page: comment on the part under the cursor (the title before j or k moved it).
export function commentAtCursor() {
  const topic = openTopicPlace();
  if (!topic) return;
  commentOn(cursorAt.get(topic.id) ?? partsOf(topic)[0] ?? "title");
}

const openTopicPlace = () =>
  stages()
    .flatMap((s) => s.groups.flatMap((g) => g.topics))
    .find((t) => t.id === S.topicAt);

// j / k: the first press shows the rail where the cursor is; the next ones move it a part.
export function moveTopicCursor(dir: 1 | -1) {
  const topic = openTopicPlace();
  const page = document.querySelector<HTMLElement>("#topics .topic-page");
  if (!topic || !page) return;
  const parts = partsOf(topic);
  const at = cursorAt.get(topic.id) ?? parts[0];
  let i = Math.max(0, parts.indexOf(at ?? ""));
  if (railShown) i = Math.max(0, Math.min(parts.length - 1, i + dir));
  railShown = true;
  page.classList.add("topic-kb");
  const part = parts[i];
  if (part === undefined) return;
  cursorAt.set(topic.id, part);
  for (const el of page.querySelectorAll(".topic-part.topic-cur")) el.classList.remove("topic-cur");
  const el = page.querySelector<HTMLElement>(`.topic-part[data-part="${part}"]`);
  el?.classList.add("topic-cur");
  el?.scrollIntoView({ block: "nearest" });
}

// Esc's lowest layer on a topic page: hide the rail. False when it isn't showing.
export function hideTopicRail(): boolean {
  if (!railShown) return false;
  railShown = false;
  document.querySelector("#topics .topic-page")?.classList.remove("topic-kb");
  return true;
}

// Clicks on the page: the gutter button opens the composer on its part, as ⇧ click on a part does;
// any click hides the keyboard's rail, and a plain click on a part puts the cursor there unseen.
// While ⇧ is held the comment icon of the part under the pointer turns blue (topicthreads.css).
export function installTopicThreads() {
  const host = $("topics");
  const inThread = (el: Element) => !!el.closest("textarea, input, button, a, .topic-threads");
  host.addEventListener("mousedown", (e) => {
    const target = e.target as Element;
    if (e.shiftKey && target.closest(".topic-part") && !inThread(target)) e.preventDefault();
  });
  host.addEventListener("click", (e) => {
    const target = e.target as Element;
    hideTopicRail();
    const gut = target.closest<HTMLElement>("[data-gut]");
    if (gut?.dataset.gut) return commentOn(gut.dataset.gut);
    const part = target.closest<HTMLElement>(".topic-part");
    if (!part?.dataset.part || inThread(target)) return;
    if (e.shiftKey) {
      e.preventDefault();
      return commentOn(part.dataset.part);
    }
    if (S.topicAt !== null) {
      cursorAt.set(S.topicAt, part.dataset.part);
      for (const el of host.querySelectorAll(".topic-part.topic-cur"))
        el.classList.remove("topic-cur");
      part.classList.add("topic-cur");
    }
  });
  const typing = (e: KeyboardEvent) =>
    /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? "");
  const shift = (on: boolean) => document.body.classList.toggle("topic-shift", on);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Shift" && !typing(e)) shift(true);
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Shift") shift(false);
  });
  window.addEventListener("blur", () => shift(false));
}

// ── Change requests ──────────────────────────────────────────────────────────────────────────────

export const topicRequests = (): TopicRequest[] => topicRequestList(threads(), stages());

// Where the `]` / `[` walk stands in Decisions mode: on the request it last landed on, while its
// topic is open, else at the top of the open topic (before its own requests). Null on the Overview.
export function topicWalkPlace(last: TopicRequest | null) {
  if (S.topicAt === null) return null;
  if (last && last.topic === S.topicAt) return last;
  const rank = stages()
    .flatMap((s) => s.groups.flatMap((g) => g.topics))
    .findIndex((t) => t.id === S.topicAt);
  return { kind: "topic" as const, rank, partRank: partRank("title") - 1, seq: -1 };
}

// Go to a topic request, from the walk or its sidebar row: Decisions mode, its topic, its thread.
export function openTopicRequest(r: TopicRequest) {
  if (S.view !== "topics") void setView("topics");
  if (!stages().some((s) => s.groups.some((g) => g.topics.some((t) => t.id === r.topic)))) {
    toast(`"${r.title}" left the guide; its change request still goes with Send`);
    return;
  }
  if (S.topicAt !== r.topic) openTopic(r.topic);
  landOnThread(r.id);
}

// Scroll a thread on the open topic's page into view and flash it.
function landOnThread(id: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(
      `#topics .topic-thread[data-thread="${CSS.escape(id)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("flash");
  });
}
