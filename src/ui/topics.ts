import { S, $ } from "./store";
import { renderMarkdown } from "./markdown";
import { isGuideBaseStale } from "./guide-derive";
import { lineTotals } from "./walkthrough";
import {
  firstTopic,
  placeOf,
  stepGroup,
  stepTopic,
  topicPlaces,
  topicsNavRows,
  type TopicAt,
} from "./topics-derive";
import { renderTopicPage, renderTopicsNav, renderTopicsOverview } from "./topics-dom";

// Decisions mode: the guide's topics, read one page at a time. It draws into its own sidebar list
// (#topicsNav) and centre (#topics); Code mode's diff and lists stand aside while it shows
// (styles/topics.css). Nothing here settles or comments yet.

// The guide has topics, so the desk has Decisions mode.
export const hasTopics = () => !!S.state?.guide?.stages?.length;

const stages = () => S.state?.guide?.stages ?? [];

// What the centre showed when it was last drawn, so a redraw of the same page keeps its scroll.
let drawn: TopicAt | undefined;

// Draw the sidebar list and the Overview or the open topic. A topic a new guide dropped falls back
// to the Overview.
export function renderTopics() {
  if (!hasTopics()) return;
  if (!placeOf(stages(), S.topicAt)) S.topicAt = null;
  const nav = $("topicsNav");
  renderTopicsNav(nav, topicsNavRows(stages(), S.topicAt));
  document
    .querySelector('.side-nav [data-key="topics-overview"]')
    ?.classList.toggle("active", S.topicAt === null);
  const page = $("topics");
  const place = placeOf(stages(), S.topicAt);
  if (place) renderTopicPage(page, place, renderMarkdown);
  else renderTopicsOverview(page, overview(), renderMarkdown);
  if (drawn !== S.topicAt) {
    page.scrollTop = 0;
    nav.querySelector(".node.active, .node.current")?.scrollIntoView({ block: "nearest" });
  }
  drawn = S.topicAt;
}

function overview() {
  const st = S.state;
  const g = st.guide!;
  const groups = stages().reduce((n, s) => n + s.groups.length, 0);
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const totals = lineTotals(st.files);
  return {
    title: g.title || st.target || "Review",
    facts: [
      st.mode,
      st.session,
      count(st.files.length, "file"),
      count(stages().length, "stage"),
      count(groups, "group"),
      count(topicPlaces(stages()).length, "topic"),
    ],
    added: totals.added,
    removed: totals.removed,
    summary: g.overview,
    stale: isGuideBaseStale(st.baseDiffHash, g.baseDiffHash),
  };
}

// Open the Overview (null) or a topic. Decisions mode is showing: its keys and rows are its own.
export function openTopic(at: TopicAt) {
  S.topicAt = at;
  S.treeDrawerOpen = false;
  renderTopics();
}

// ⇧→ / ⇧←, ⇧↓ / ⇧↑: a step that has nowhere to go stays put.
export function topicStep(dir: 1 | -1) {
  const to = stepTopic(stages(), S.topicAt, dir);
  if (to !== undefined) openTopic(to);
}

export function groupStep(dir: 1 | -1) {
  const to = stepGroup(stages(), S.topicAt, dir);
  if (to !== undefined) openTopic(to);
}

// Start Review (↵ on the Overview): the first topic.
export function startTopics() {
  const first = firstTopic(stages());
  if (first) openTopic(first);
}

// Rows and the Start button act through delegation, since every draw replaces them. A group row
// opens its first topic.
export function installTopics() {
  $("topicsNav").addEventListener("click", (e) => {
    const row = (e.target as Element).closest<HTMLElement>("[data-topic], [data-group]");
    if (row?.dataset.topic) openTopic(row.dataset.topic);
    else if (row?.dataset.group) {
      const group = stages()
        .flatMap((s) => s.groups)
        .find((g) => g.id === row.dataset.group);
      if (group?.topics[0]) openTopic(group.topics[0].id);
    }
  });
  $("topics").addEventListener("click", (e) => {
    if ((e.target as Element).closest('[data-act="start"]')) startTopics();
  });
}
