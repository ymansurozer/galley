import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";

import type {
  Guide,
  GuideTopic,
  ReviewState,
  ThreadMessage,
  TopicChangeRequest,
  TopicQuestion,
  TopicThread,
} from "./types.js";

// Threads on the parts of a topic (types.ts, TopicThread): which blocks of a body take a comment,
// what a thread quotes and where it goes when a new guide rewrites its topic, reading them off a
// reviewer's save, and what the agent gets of them.

// ── Parts ────────────────────────────────────────────────────────────────────────────────────────

// The tab renders a body with markdown-it and footnotes, and stamps each top-level block and each
// list item with its source line (ui/markdown-source.ts). The same parse, here, says which of
// those elements are parts.
const parser = new MarkdownIt({ html: false }).use(footnote);

// Fences another part of the page draws in its own way, not as a block of the body.
const OWN_FENCES = new Set(["lines", "options"]);

export type BodyBlock = { line: number; text: string };

// The blocks of a topic's body a comment can sit on, in order, by their 1-based source line, each
// with its markdown source. A list is not a part: its items are, each with what is nested in it (a
// list and its first item share a line, and only the item is a part). A table, a code block and a
// diagram are one part each. A rule has nothing to say.
export function bodyBlocks(body: string): BodyBlock[] {
  const lines = body.split("\n");
  const blocks: BodyBlock[] = [];
  for (const t of parser.parse(body, {})) {
    if (!t.map || t.nesting === -1) continue;
    const top =
      t.level === 0 &&
      t.type !== "bullet_list_open" &&
      t.type !== "ordered_list_open" &&
      t.type !== "hr" &&
      !(t.type === "fence" && OWN_FENCES.has(t.info.trim()));
    const item = t.type === "list_item_open" && t.level === 1;
    if (!top && !item) continue;
    const [start, end] = t.map;
    blocks.push({ line: start + 1, text: lines.slice(start, end).join("\n").trim() });
  }
  return blocks;
}

// A part as a thread names it: one of the topic's fields, or a body block by its source line.
// Other kinds join here.
type Part = { kind: "title" | "recorded" | "flag" } | { kind: "body"; line: number };
function readPart(part: string): Part | null {
  if (part === "title" || part === "recorded" || part === "flag") return { kind: part };
  const body = /^body:([1-9]\d{0,6})$/.exec(part);
  return body ? { kind: "body", line: Number(body[1]) } : null;
}
export const bodyPart = (line: number) => `body:${line}`;

// The text a part shows on `topic` now, or undefined where the topic has no such part.
export function partText(topic: GuideTopic, part: string): string | undefined {
  const p = readPart(part);
  if (!p) return undefined;
  if (p.kind === "body") return bodyBlocks(topic.body).find((b) => b.line === p.line)?.text;
  return { title: topic.title, recorded: topic.recorded, flag: topic.flag }[p.kind];
}

const topicsOf = (guide: Guide | undefined) =>
  new Map(
    guide?.stages?.flatMap((s) => s.groups.flatMap((g) => g.topics.map((t) => [t.id, t]))) ?? [],
  );

// ── Following a new guide ────────────────────────────────────────────────────────────────────────

// Where a thread on `topic` sits once its topic is `topic` (a new guide): a body block where its
// quote still is, the nearest one to its old line when the text is there more than once (the
// earlier on a tie); the title, `moved`, once the text is gone or the part it named is (a flag the
// topic no longer raises). A part that still stands keeps it and quotes its text now.
function follow(t: TopicThread, topic: GuideTopic): TopicThread {
  const p = readPart(t.target.part);
  const moved = { ...t, target: { ...t.target, part: "title" }, moved: true as const };
  if (t.moved || !p) return { ...t, title: topic.title };
  if (p.kind !== "body") {
    const text = partText(topic, t.target.part);
    return text === undefined
      ? { ...moved, title: topic.title }
      : { ...t, title: topic.title, quote: text };
  }
  const matches = bodyBlocks(topic.body).filter((b) => b.text === t.quote);
  const near = matches.sort((a, b) => Math.abs(a.line - p.line) - Math.abs(b.line - p.line))[0];
  return near
    ? { ...t, title: topic.title, target: { ...t.target, part: bodyPart(near.line) } }
    : { ...moved, title: topic.title };
}

// The threads carried onto a new guide (launch with --guide, reload --guide): each on a topic still
// in it follows its part (follow). On a topic the guide dropped, an open change request stays, under
// the title the thread kept, so it still goes to the agent; its questions and resolved threads go.
// Threads on the Overview stay as they are.
export function carryTopicThreads(state: Pick<ReviewState, "guide" | "topicThreads">) {
  if (!state.topicThreads) return;
  const topics = topicsOf(state.guide);
  state.topicThreads = state.topicThreads.flatMap((t) => {
    if (t.target.topic === "overview") return [t];
    const topic = topics.get(t.target.topic);
    if (topic) return [follow(t, topic)];
    return isOpenChange(t) ? [t] : [];
  });
}

// ── A reviewer's save ────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
// Thread and message ids (uuids from the tab) end up in the desk's markup: word characters only.
const isId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
const ROLES = new Set<unknown>(["user", "agent"]);
const INTENTS = new Set<unknown>(["note", "action", "question"]);

function readMessage(v: unknown): ThreadMessage | null {
  if (!isObj(v) || !isId(v.id) || !isString(v.body)) return null;
  if (!isString(v.createdAt) || !isString(v.updatedAt)) return null;
  const m: ThreadMessage = {
    id: v.id,
    body: v.body,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
  if (INTENTS.has(v.intent)) m.intent = v.intent as ThreadMessage["intent"];
  if (ROLES.has(v.role)) m.role = v.role as ThreadMessage["role"];
  if (isString(v.askedAt)) m.askedAt = v.askedAt;
  return m;
}

function readThread(v: unknown): TopicThread | null {
  if (!isObj(v) || !isId(v.id) || !isObj(v.target)) return null;
  const { topic, part } = v.target;
  if (!isString(topic) || !isString(part) || topic.length > 200 || part.length > 200) return null;
  if (v.intent !== "change" && v.intent !== "question") return null;
  if (v.status !== "open" && v.status !== "resolved") return null;
  if (!Array.isArray(v.comments)) return null;
  const comments = v.comments.flatMap((m) => readMessage(m) ?? []);
  if (!comments.length) return null;
  const t: TopicThread = {
    id: v.id,
    target: { topic, part },
    title: isString(v.title) ? v.title : "",
    intent: v.intent,
    status: v.status,
    comments,
  };
  if (isString(v.quote)) t.quote = v.quote;
  if (v.moved === true) t.moved = true;
  return t;
}

// A save's topic threads, malformed ones dropped. Undefined when the save carries none.
export function readTopicThreads(value: unknown): TopicThread[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  return value.flatMap((v) => {
    const t = readThread(v);
    if (!t || seen.has(t.id)) return [];
    seen.add(t.id);
    return [t];
  });
}

// A thread a save sends whole, onto the desk's copy of it (`prev`), or as the desk first takes it.
// Where it sits, its title and its quote are the desk's: a new guide moved them, and a tab that
// hasn't caught up still sends the old ones. A new thread is placed on the desk's guide: its title
// and quote from the topic, on the title when the part it names isn't there. An agent reply (`galley
// comment --topic`) lands between the tab's polls, so a save from a tab that hasn't seen it yet
// lacks it; the tab can't delete an agent message, so every one the save lacks is kept.
export function takeTopicThread(
  t: TopicThread,
  prev: TopicThread | undefined,
  guide: Guide | undefined,
): TopicThread {
  if (prev) {
    const have = new Set(t.comments.map((m) => m.id));
    const replies = prev.comments.filter((m) => m.role === "agent" && !have.has(m.id));
    const { quote, moved } = prev;
    const placed: TopicThread = { ...t, target: prev.target, title: prev.title };
    delete placed.quote;
    delete placed.moved;
    return {
      ...placed,
      ...(quote !== undefined && { quote }),
      ...(moved && { moved }),
      comments: [...t.comments, ...replies],
    };
  }
  const topic = topicsOf(guide).get(t.target.topic);
  if (!topic) return t;
  const placed: TopicThread = { ...t, title: topic.title };
  delete placed.quote;
  delete placed.moved;
  const quote = partText(topic, t.target.part);
  if (quote !== undefined) return { ...placed, quote };
  return { ...placed, target: { ...t.target, part: "title" }, quote: topic.title };
}

// A save's topic threads onto the desk's: each taken as takeTopicThread says.
export function takeTopicThreads(
  sent: TopicThread[],
  desk: readonly TopicThread[] | undefined,
  guide: Guide | undefined,
): TopicThread[] {
  const own = new Map(desk?.map((t) => [t.id, t]));
  return sent.map((t) => takeTopicThread(t, own.get(t.id), guide));
}

// ── What the agent gets ──────────────────────────────────────────────────────────────────────────

// A thread requests a change when it was opened as one, or when the reviewer requested one later in
// it (the tab's rule too, ui/topicthreads-derive.ts).
export const requestsChange = (t: TopicThread) =>
  t.intent === "change" || t.comments.some((m) => m.role !== "agent" && m.intent === "action");
export const isOpenChange = (t: TopicThread) => t.status === "open" && requestsChange(t);

// The agent's reply in a topic thread (`galley comment --topic`), added to `state`. Null when the
// review has no thread with that id.
export function replyToTopicThread(
  state: Pick<ReviewState, "topicThreads">,
  id: string,
  body: string,
  now: string,
): ThreadMessage | null {
  const t = state.topicThreads?.find((x) => x.id === id);
  if (!t) return null;
  const reply: ThreadMessage = {
    id: crypto.randomUUID(),
    role: "agent",
    intent: "note",
    body,
    createdAt: now,
    updatedAt: now,
  };
  t.comments.push(reply);
  return reply;
}

// `question` is a message in thread `t`.
export function topicQuestionPayload(
  state: Pick<ReviewState, "mode" | "session">,
  t: TopicThread,
  question: ThreadMessage,
): TopicQuestion {
  return {
    lane: "topic",
    id: t.id,
    topic: t.target.topic,
    part: t.target.part,
    ...(t.quote !== undefined && { quote: t.quote }),
    body: question.body,
    mode: state.mode,
    session: state.session,
  };
}

// A part's place on its topic's page, top to bottom: the title, Recorded, the body by line, the
// flag, then any other.
function partRank(part: string): number {
  const p = readPart(part);
  if (!p) return 4;
  if (p.kind === "body") return 2 + p.line / 1e7;
  return { title: 0, recorded: 1, flag: 3 }[p.kind];
}

// The open change requests for the review result: by topic in the guide's order, then down the
// page, then in the order they were made; those on topics the guide no longer has come last. The
// body is the message that asks for the change: the opening one, else the reply that turned a
// question into a change request.
export function topicChangeRequests(
  state: Pick<ReviewState, "guide" | "topicThreads">,
): TopicChangeRequest[] {
  const order = new Map([...topicsOf(state.guide).keys()].map((id, i) => [id, i]));
  const rank = (t: TopicThread) => order.get(t.target.topic) ?? order.size;
  return (state.topicThreads ?? [])
    .filter(isOpenChange)
    .map((t, i) => ({ t, i }))
    .sort(
      (a, b) =>
        rank(a.t) - rank(b.t) || partRank(a.t.target.part) - partRank(b.t.target.part) || a.i - b.i,
    )
    .map(({ t }) => {
      const ask =
        t.comments.find((m) => m.role !== "agent" && m.intent === "action") ?? t.comments[0];
      return {
        id: t.id,
        topic: t.target.topic,
        part: t.target.part,
        ...(t.quote !== undefined && { quote: t.quote }),
        body: ask?.body ?? "",
      };
    });
}
