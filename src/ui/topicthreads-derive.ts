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
  return [
    "title",
    "recorded",
    ...(stamp?.bodyParts ?? []).map((line) => `body:${line}`),
    ...(topic.flag ? ["flag"] : []),
  ];
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
// so (it shares its slot with the title's), and one whose part a new guide took away says it moved.
export function threadPlace(t: Pick<TopicThread, "target" | "moved">): string | null {
  if (t.moved) return "The part it was on changed";
  return t.target.part === "recorded" ? "On Recorded" : null;
}

// The composer's header for a new thread on `part`: "on Recorded" there, as the thread will say.
export const composerPlace = (part: string) => (part === "recorded" ? "on Recorded" : null);

// A thread requests a change when it was opened as one, or when the reviewer requested one later in
// it: what the Send sends (topicthreads.ts keeps the desk's copy of the rule).
export const requestsChange = (t: TopicThread) =>
  t.intent === "change" || t.comments.some((m) => m.role !== "agent" && m.intent === "action");
export const isOpenChange = (t: TopicThread) => t.status === "open" && requestsChange(t);

// A topic's threads, in the order they were made.
export const threadsOf = (threads: readonly TopicThread[], topic: string) =>
  threads.filter((t) => t.target.topic === topic);

// A topic's open change requests: its blockers.
export const topicBlockers = (threads: readonly TopicThread[], topic: string) =>
  threadsOf(threads, topic).filter(isOpenChange);

// The message that asks for a thread's change: its first Request change, else its opening one.
export const askOf = (t: TopicThread) =>
  t.comments.find((m) => m.role !== "agent" && m.intent === "action") ?? t.comments[0];

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
