import type { GuideGroup, GuideStage, GuideTopic, ReviewState } from "../types";

// Decisions mode's pure logic: the order topics are read in, where the step keys land, what is
// settled, and the sidebar's rows. Topics are read in the guide's order: stage by stage, group by
// group.

// What settling reads off the review: the desk's stamp per topic (its cover hash now), the
// reviewer's sign-offs, and the round.
export type TopicsReview = Pick<ReviewState, "topics" | "settledTopics" | "round">;

// The review's round: one more than the number of Sends.
export const roundOf = (review: TopicsReview) => review.round ?? 1;

// Whether a topic is settled: the reviewer's sign-off names the cover hash the topic has now. The
// one rule the sidebar, the bar, the counts, progress and Send judge by (the desk's twin:
// state.ts topicSettled).
export function topicSettled(review: TopicsReview, id: string): boolean {
  const hash = review.topics?.[id]?.coverHash;
  return hash !== undefined && review.settledTopics?.[id]?.hash === hash;
}

// The round a topic settled in an earlier round was settled in: folded away under its group and
// out of its count. undefined for one to do or settled this round.
function earlierRound(review: TopicsReview, id: string) {
  const round = topicSettled(review, id) ? review.settledTopics?.[id]?.round : undefined;
  return round !== undefined && round < roundOf(review) ? round : undefined;
}

// Where Decisions mode is: the Overview (null) or a topic, by id.
export type TopicAt = string | null;

export type TopicPlace = { topic: GuideTopic; group: GuideGroup; stage: GuideStage };

const groupsOf = (stages: GuideStage[]) =>
  stages.flatMap((stage) => stage.groups.map((group) => ({ group, stage })));

export const topicPlaces = (stages: GuideStage[]): TopicPlace[] =>
  groupsOf(stages).flatMap(({ group, stage }) =>
    group.topics.map((topic) => ({ topic, group, stage })),
  );

export const placeOf = (stages: GuideStage[], id: TopicAt) =>
  id === null ? undefined : topicPlaces(stages).find((p) => p.topic.id === id);

// Where a group is entered (⇧↓ / ⇧↑, a click on its row or its box on the map): its first topic
// still to do, or its first topic when every one is settled.
export const groupEntry = (group: GuideGroup, review: TopicsReview = {}) =>
  (group.topics.find((t) => !topicSettled(review, t.id)) ?? group.topics[0])?.id;

export const firstTopic = (stages: GuideStage[]) => topicPlaces(stages)[0]?.topic.id;

// Where ↵ on the Overview goes: the review's first topic still to do. undefined when none is.
export const firstTodo = (stages: GuideStage[], review: TopicsReview) =>
  topicPlaces(stages).find((p) => !topicSettled(review, p.topic.id))?.topic.id;

// Where settling `from` goes next: the next topic still to do later in its group, then earlier in
// it, then on through the following groups in order, wrapping to the groups before. So ⇧A clears a
// group before it leaves it. undefined when no other topic is to do.
export function nextTodo(stages: GuideStage[], review: TopicsReview, from: string) {
  const groups = groupsOf(stages).map(({ group }) => group);
  const todo = (t: GuideTopic) => t.id !== from && !topicSettled(review, t.id);
  const here = placeOf(stages, from)?.group;
  const g = here ? groups.indexOf(here) : 0;
  if (here) {
    const i = here.topics.findIndex((t) => t.id === from);
    const own = [...here.topics.slice(i + 1), ...here.topics.slice(0, i)].find(todo);
    if (own) return own.id;
  }
  for (let k = here ? 1 : 0; k < groups.length; k++) {
    const t = groups[(g + k) % groups.length]!.topics.find(todo);
    if (t) return t.id;
  }
  return undefined;
}

// How far the review is: topics settled out of all of them, earlier rounds' included.
export function topicsDone(stages: GuideStage[], review: TopicsReview) {
  const places = topicPlaces(stages);
  return {
    done: places.filter((p) => topicSettled(review, p.topic.id)).length,
    total: places.length,
  };
}

// ⇧→ / ⇧←: the next or previous topic in reading order, across group and stage boundaries. The
// Overview comes before the first topic. undefined when there is nowhere to go: before the
// Overview, or past the last topic. A topic the guide no longer has counts as the Overview.
export function stepTopic(stages: GuideStage[], at: TopicAt, dir: 1 | -1): TopicAt | undefined {
  const order = topicPlaces(stages).map((p) => p.topic.id);
  const i = at === null ? -1 : order.indexOf(at);
  if (i < 0) return dir > 0 ? order[0] : undefined;
  if (i + dir < 0) return null;
  return order[i + dir];
}

// ⇧↓ / ⇧↑: the next or previous group, where it is entered (groupEntry). Up from the first group
// is the Overview; down from the Overview is the first group.
export function stepGroup(
  stages: GuideStage[],
  at: TopicAt,
  dir: 1 | -1,
  review: TopicsReview = {},
): TopicAt | undefined {
  const groups = groupsOf(stages).map(({ group }) => group);
  const here = placeOf(stages, at)?.group;
  const i = here ? groups.indexOf(here) : -1;
  if (i < 0) return dir > 0 && groups[0] ? groupEntry(groups[0], review) : undefined;
  if (i + dir < 0) return null;
  const next = groups[i + dir];
  return next ? groupEntry(next, review) : undefined;
}

export type TopicsNavRow =
  | { kind: "stage"; key: string; label: string }
  | {
      kind: "group";
      key: string;
      id: string;
      title: string;
      // Settled out of the topics this round: those settled in an earlier round are in neither.
      done: number;
      total: number;
      // Done once no topic of the group is still to do.
      settled: boolean;
      current: boolean;
    }
  | {
      kind: "topic";
      key: string;
      id: string;
      title: string;
      flagged: boolean;
      open: boolean;
      settled: boolean;
    }
  // The topics of a group settled in earlier rounds, folded into one row.
  | { kind: "earlier"; key: string; group: string; label: string; open: boolean };

// The fold's words: "N settled in round R" when they share a round, else "in earlier rounds".
export function earlierLabel(rounds: readonly number[]) {
  const one = rounds.every((r) => r === rounds[0]);
  return `${rounds.length} settled in ${one ? `round ${rounds[0]}` : "earlier rounds"}`;
}

// The sidebar under Overview and Change requests: each stage as a header, its groups under it with
// what is done of this round's topics, and the open topic's group unfolded into its topics. Topics
// settled in an earlier round fold into one row after them, closed until the reviewer opens it
// (`earlierOpen`, by group id) or one of them is the open topic. On the Overview no group is
// unfolded.
export function topicsNavRows(
  stages: GuideStage[],
  at: TopicAt,
  review: TopicsReview = {},
  earlierOpen: ReadonlySet<string> = new Set(),
): TopicsNavRow[] {
  const current = placeOf(stages, at)?.group;
  const rows: TopicsNavRow[] = [];
  const topicRow = (topic: GuideTopic): TopicsNavRow => ({
    kind: "topic",
    key: `topic:${topic.id}`,
    id: topic.id,
    title: topic.title,
    flagged: !!topic.flag,
    open: topic.id === at,
    settled: topicSettled(review, topic.id),
  });
  for (const stage of stages) {
    rows.push({ kind: "stage", key: `stage:${stage.id}`, label: stage.label });
    for (const group of stage.groups) {
      const open = group === current;
      const earlier = group.topics.flatMap((t) => {
        const round = earlierRound(review, t.id);
        return round === undefined ? [] : [{ topic: t, round }];
      });
      const folded = new Set(earlier.map((e) => e.topic));
      const now = group.topics.filter((t) => !folded.has(t));
      const done = now.filter((t) => topicSettled(review, t.id)).length;
      rows.push({
        kind: "group",
        key: `group:${group.id}`,
        id: group.id,
        title: group.title,
        done,
        total: now.length,
        settled: done === now.length,
        current: open,
      });
      if (!open) continue;
      rows.push(...now.map(topicRow));
      if (!earlier.length) continue;
      const unfolded = earlierOpen.has(group.id) || earlier.some((e) => e.topic.id === at);
      rows.push({
        kind: "earlier",
        key: `earlier:${group.id}`,
        group: group.id,
        label: earlierLabel(earlier.map((e) => e.round)),
        open: unfolded,
      });
      if (unfolded) rows.push(...earlier.map((e) => topicRow(e.topic)));
    }
  }
  return rows;
}
