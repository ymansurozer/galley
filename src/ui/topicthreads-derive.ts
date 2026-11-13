import type { GuideStage, GuideTopic, TopicStamp, TopicThread } from "../types";
import { firstLine } from "./uilane-derive";
import { messageWaiting } from "./thread-derive";

// Pure logic for the threads on a topic's parts (types.ts, TopicThread): which parts a topic page
// has and in what order, where a thread sits on it, the change requests it holds, and what they
// make of the topic's mark and its bar. Store-free, so it unit-tests; topicthreads.ts is the
// store-reading side and topicthreads-dom.ts the markup.

// The parts of a topic page a comment can sit on, top to bottom, as a thread names them: the
// title, Recorded, each block of the body by the source line the desk stamped (TopicStamp
// bodyParts, so the desk's quote and the tab's part are the same block), then the Flagged card.
// The cursor (j / k) walks this list. A kind of part a later page adds joins it here.
export function topicParts(topic: GuideTopic, stamp: TopicStamp | undefined): string[] {
  const body = [
    ...(stamp?.bodyParts ?? []).map((line) => ({ part: `body:${line}`, line })),
    ...(stamp?.options ?? []).map((_, i) => ({
      part: `option:${i + 1}`,
      line: stamp?.optionsLine ?? Infinity,
    })),
  ].sort((a, b) => a.line - b.line);
  return ["title", "recorded", ...body.map((b) => b.part), ...(topic.flag ? ["flag"] : [])];
}

// A body part's source line, or undefined for any other part.
export const bodyLine = (part: string) => {
  const m = /^body:(\d+)$/.exec(part);
  return m ? Number(m[1]) : undefined;
};

// Where a part's threads sit: under the part itself, except the title's, which sit under the
// Recorded line with Recorded's own, so the heading stays one block.
export const threadSlot = (part: string) => (part === "title" ? "recorded" : part);

// What a thread's card says of where it sits, when its place doesn't say it: one on Recorded says
// so, as one on the title does (they share the slot under Recorded), and one whose part a new
// guide took away says it moved.
// The composer for a new thread says what its thread will.
export function threadPlace(t: Pick<TopicThread, "target" | "moved">): string | null {
  if (t.moved) return "its part changed";
  if (t.target.part === "title") return "on the title";
  return t.target.part === "recorded" ? "on Recorded" : null;
}

// A thread requests a change when it was opened as one, or when the reviewer requested one later in
// it: what the Send sends (topicthreads.ts keeps the desk's copy of the rule).
export const requestsChange = (t: TopicThread) =>
  t.intent === "change" || t.comments.some((m) => m.role !== "agent" && m.intent === "action");
export const isOpenChange = (t: TopicThread) => t.status === "open" && requestsChange(t);

// The threads on topics the guide no longer has (the Overview's own aside), in the order made.
export function droppedThreads(threads: readonly TopicThread[], stages: readonly GuideStage[]) {
  const ids = new Set(stages.flatMap((s) => s.groups.flatMap((g) => g.topics.map((t) => t.id))));
  return threads.filter((t) => t.target.topic !== "overview" && !ids.has(t.target.topic));
}

// A topic's threads, in the order they were made.
export const threadsOf = (threads: readonly TopicThread[], topic: string) =>
  threads.filter((t) => t.target.topic === topic);

// A topic's open change requests: its blockers.
export const topicBlockers = (threads: readonly TopicThread[], topic: string) =>
  threadsOf(threads, topic).filter(isOpenChange);

// The message that asks for a thread's change: its first Request change, else its opening one.
export const askOf = (t: TopicThread) =>
  [...t.comments]
    .reverse()
    .find((m) => m.role !== "agent" && m.intent === "action" && m.option !== undefined) ??
  t.comments.find((m) => m.role !== "agent" && m.intent === "action") ??
  t.comments[0];

// What the topic's bar offers and says. To do: Settle Topic, or Mark Reviewed while it has open
// change requests. Settled (a sign-off by either button): Settled, or "Reviewed with requests"
// while it still has open ones. Either way it is done: the mark below says what is left.
export type TopicSignOffStand = "settle" | "mark" | "settled" | "reviewed";
export function signOffStand(settled: boolean, requests: number): TopicSignOffStand {
  if (settled) return requests ? "reviewed" : "settled";
  return requests ? "mark" : "settle";
}

// A topic's or a group's mark in the sidebar: change requested while any of its topics has an open
// change request, done once every one is settled, else to do. Derived, never stored.
export type TopicMark = "todo" | "done" | "change";
export const topicMark = (settled: boolean, requested: boolean): TopicMark =>
  requested ? "change" : settled ? "done" : "todo";

// The open topic change requests for the sidebar's list and the `]` / `[` walk, in the result's
// order: by topic in the guide's order, then down its page, then as made; those on topics the
// guide no longer has come last, named by the title their thread kept.
export type TopicRequest = {
  kind: "topic";
  id: string;
  topic: string;
  title: string;
  part: string;
  // The topic's place in the guide (Infinity once the guide has dropped it), the part's place on
  // its page, and the thread's place among them, as the list orders them.
  rank: number;
  partRank: number;
  seq: number;
  text: string;
};

// A part's place on its topic's page, top to bottom (topicParts).
export function partRank(part: string): number {
  if (part.startsWith("option:")) return 3 + Number(part.slice(7)) / 1e7;
  const line = bodyLine(part);
  if (line !== undefined) return 2 + line / 1e7;
  return ({ title: 0, recorded: 1, flag: 3 } as Record<string, number>)[part] ?? 4;
}

export function topicRequestList(
  threads: readonly TopicThread[],
  stages: readonly GuideStage[],
): TopicRequest[] {
  const topics = stages.flatMap((s) => s.groups.flatMap((g) => g.topics));
  const rank = new Map(topics.map((t, i) => [t.id, i]));
  const title = new Map(topics.map((t) => [t.id, t.title]));
  return threads
    .flatMap((t, seq) =>
      isOpenChange(t)
        ? [
            {
              kind: "topic" as const,
              id: t.id,
              topic: t.target.topic,
              title: title.get(t.target.topic) ?? t.title,
              part: t.target.part,
              rank: rank.get(t.target.topic) ?? Infinity,
              partRank: partRank(t.target.part),
              seq,
              text: firstLine(askOf(t)?.body ?? ""),
            },
          ]
        : [],
    )
    .sort((a, b) => compareTopicRequests(a, b));
}

export const compareTopicRequests = (
  a: Pick<TopicRequest, "rank" | "partRank" | "seq">,
  b: Pick<TopicRequest, "rank" | "partRank" | "seq">,
) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1) || a.partRank - b.partRank || a.seq - b.seq;

// The Send dialog's words for the topic threads: the change requests that go, and the questions
// still waiting on the agent (they go as openQuestions). Empty with neither.
export function topicThreadsSendLine(threads: readonly TopicThread[]) {
  const open = threads.filter((t) => t.status === "open");
  const requests = open.filter(requestsChange).length;
  const waiting = open.filter((t) => t.comments.some((m) => messageWaiting(m, t.comments))).length;
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  return [
    requests ? n(requests, "topic change request") : "",
    waiting ? n(waiting, "open topic question") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// The topic threads a tab takes with a new guide: the desk's (`desk`), which the guide moved onto its
// parts or dropped, keeping what the tab holds and hasn't saved. A thread the tab changed since its
// confirmed copy (`confirmed`) keeps the tab's messages and status where the desk put it, with any
// agent reply the tab lacks; one the tab made that neither the desk nor the confirmed copy has
// stays; one the tab deleted stays deleted. One the confirmed copy has and the desk's list lacks
// was dropped by the guide, and stays dropped.
export function keepUnsavedThreads(
  desk: readonly TopicThread[],
  local: readonly TopicThread[],
  confirmed: readonly TopicThread[],
): TopicThread[] {
  const before = new Map(confirmed.map((t) => [t.id, JSON.stringify(t)]));
  const mine = new Map(local.map((t) => [t.id, t]));
  const onDesk = new Set(desk.map((t) => t.id));
  const kept = desk.flatMap((d) => {
    const l = mine.get(d.id);
    if (!l) return before.has(d.id) ? [] : [d];
    if (before.get(d.id) === JSON.stringify(l)) return [d];
    const have = new Set(l.comments.map((m) => m.id));
    const replies = d.comments.filter((m) => m.role === "agent" && !have.has(m.id));
    const { quote: _quote, moved: _moved, ...own } = l;
    return [
      {
        ...own,
        target: d.target,
        title: d.title,
        ...(d.quote !== undefined && { quote: d.quote }),
        ...(d.moved && { moved: d.moved }),
        comments: [...l.comments, ...replies],
      },
    ];
  });
  return [...kept, ...local.filter((t) => !onDesk.has(t.id) && !before.has(t.id))];
}
