import type { TopicOption, TopicThread } from "../types";
import { isOpenChange } from "./topicthreads-derive";

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
