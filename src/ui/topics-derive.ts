import type { GuideGroup, GuideStage, GuideTopic } from "../types";

// Decisions mode's pure logic: the order topics are read in, where the step keys land, and the
// sidebar's rows. Topics are read in the guide's order: stage by stage, group by group.

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

// Where a group is entered: its first topic.
const groupEntry = (group: GuideGroup) => group.topics[0]?.id;

export const firstTopic = (stages: GuideStage[]) => topicPlaces(stages)[0]?.topic.id;

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

// ⇧↓ / ⇧↑: the next or previous group, at its first topic. Up from the first group is the
// Overview; down from the Overview is the first group.
export function stepGroup(stages: GuideStage[], at: TopicAt, dir: 1 | -1): TopicAt | undefined {
  const groups = groupsOf(stages).map(({ group }) => group);
  const here = placeOf(stages, at)?.group;
  const i = here ? groups.indexOf(here) : -1;
  if (i < 0) return dir > 0 && groups[0] ? groupEntry(groups[0]) : undefined;
  if (i + dir < 0) return null;
  const next = groups[i + dir];
  return next ? groupEntry(next) : undefined;
}

export type TopicsNavRow =
  | { kind: "stage"; key: string; label: string }
  | { kind: "group"; key: string; id: string; title: string; count: number; current: boolean }
  | { kind: "topic"; key: string; id: string; title: string; flagged: boolean; open: boolean };

// The sidebar under Overview and Change requests: each stage as a header, its groups under it with
// their topic count, and the open topic's group unfolded into its topics. On the Overview no group
// is unfolded.
export function topicsNavRows(stages: GuideStage[], at: TopicAt): TopicsNavRow[] {
  const current = placeOf(stages, at)?.group;
  const rows: TopicsNavRow[] = [];
  for (const stage of stages) {
    rows.push({ kind: "stage", key: `stage:${stage.id}`, label: stage.label });
    for (const group of stage.groups) {
      const open = group === current;
      rows.push({
        kind: "group",
        key: `group:${group.id}`,
        id: group.id,
        title: group.title,
        count: group.topics.length,
        current: open,
      });
      if (!open) continue;
      for (const topic of group.topics)
        rows.push({
          kind: "topic",
          key: `topic:${topic.id}`,
          id: topic.id,
          title: topic.title,
          flagged: !!topic.flag,
          open: topic.id === at,
        });
    }
  }
  return rows;
}
