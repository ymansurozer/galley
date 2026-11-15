import type { TopicOption, TopicThread, ThreadMessage } from "../types";
import { isOpenChange } from "./topicthreads-derive";

// A body pick is an open change request created by choosing an option, not an ordinary comment
// on that option. There is one per topic: its alternatives are mutually exclusive, so a new pick
// replaces the earlier request rather than asking the agent to implement both.
export const isPick = (t: TopicThread, topic: string) =>
  t.target.topic === topic &&
  t.target.part.startsWith("option:") &&
  t.option !== undefined &&
  isOpenChange(t);
export function replacePick(
  threads: readonly TopicThread[],
  topic: string,
  pick?: TopicThread,
): TopicThread[] {
  const kept = threads.filter((t) => !isPick(t, topic));
  return pick ? [...kept, pick] : kept;
}
export function selectedOption(
  options: readonly TopicOption[],
  threads: readonly TopicThread[],
  topic: string,
): number {
  const pick = threads.find((t) => isPick(t, topic));
  return pick
    ? options.findIndex((o) => o.label === pick.option)
    : options.findIndex((o) => o.ships);
}

// A reply keeps its discussion and ordinary requests, with at most one reviewer pick message.
// Selecting what ships retracts that pick; selecting it again must not manufacture a new request.
export function replaceReplyPick(
  t: TopicThread,
  option: TopicOption,
  message: ThreadMessage,
): TopicThread {
  const picked = t.comments.find((m) => m.role !== "agent" && m.option !== undefined);
  if (option.ships ? !picked : picked?.option === option.label) return t;
  const comments = t.comments.filter((m) => m.role === "agent" || m.option === undefined);
  return {
    ...t,
    comments: option.ships ? comments : [...comments, message],
    status: option.ships ? t.status : "open",
  };
}

// Browser bundles cannot import backend code at runtime. Body options arrive stamped by the
// desk; this copy reads an agent's reply. Keep its shape checks identical to topicoptions.ts.
export function parseOptions(source: string): TopicOption[] | null {
  try {
    const value: unknown = JSON.parse(source);
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      !value.every(
        (o) =>
          o &&
          typeof o === "object" &&
          !Array.isArray(o) &&
          typeof o.label === "string" &&
          (o.note === undefined || typeof o.note === "string") &&
          (o.ships === undefined || typeof o.ships === "boolean") &&
          (o.recommended === undefined || typeof o.recommended === "boolean"),
      ) ||
      value.filter((o) => o.ships).length > 1
    )
      return null;
    return value.map(({ label, note, ships, recommended }) => ({
      label,
      ...(note !== undefined && { note }),
      ...(ships !== undefined && { ships }),
      ...(recommended !== undefined && { recommended }),
    }));
  } catch {
    return null;
  }
}
