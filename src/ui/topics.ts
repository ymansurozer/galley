import { currentFile } from "./changes";
import { appGo, hasUi, setView } from "./appview";
import { jumpToBlocker } from "./blockers";
import { topicPoints } from "./topics-coverage-derive";
import { renderPoints, renderTopicShare } from "./topics-coverage-dom";
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

// Keep evidence expansion across redraws; a different topic starts folded with ten items.
let pointsCount = 10;
let pointsOpen = false;
let coverageOpen = false;
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
  if (drawn !== S.topicAt) {
    pointsCount = 10;
    pointsOpen = false;
  }
  if (place) {
    const lines = S.state.topics?.[place.topic.id]?.lines ?? 0;
    const c = S.state.coverage;
    renderTopicPage(page, place, renderMarkdown, {
      share: renderTopicShare(lines, c ? c.totalLines - c.skimmedLines : 0),
      points: renderPoints(topicPoints(place.topic, S.state), lines, hasUi(), pointsCount),
    });
  } else renderTopicsOverview(page, overview(), renderMarkdown);
  const points = page.querySelector<HTMLDetailsElement>(".topic-points");
  if (points) {
    points.open = pointsOpen;
    points.addEventListener("toggle", () => {
      pointsOpen = points.open;
    });
  }
  const coverage = page.querySelector<HTMLDetailsElement>(".topic-coverage details");
  if (coverage) {
    coverage.open = coverageOpen;
    coverage.addEventListener("toggle", () => {
      coverageOpen = coverage.open;
    });
  }
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
    coverage: st.coverage,
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
    const target = e.target as Element;
    const code = target.closest<HTMLElement>("[data-topic-code]");
    if (code) void openTopicCode(code.dataset.topicCode!, Number(code.dataset.line));
    const app = target.closest<HTMLElement>("[data-topic-app]");
    if (app && hasUi()) {
      void setView("ui");
      appGo(app.dataset.topicApp!);
    }
    if (target.closest("[data-topic-more]")) {
      pointsCount += 10;
      renderTopics();
    }
    if ((e.target as Element).closest('[data-act="start"]')) startTopics();
  });
}

// Wait for Code's render before landing, so the mode switch cannot repaint over the cursor.
async function openTopicCode(path: string, lineNumber: number) {
  await setView("code");
  const fileIndex = S.state.files.findIndex((f) => f.path === path);
  if (fileIndex < 0) return;
  await S.selectStep?.({ fileIndex });
  await jumpToBlocker(
    { kind: "thread", side: "additions", lineNumber, preview: "", unanchored: false },
    () => S.view === "code" && currentFile()?.path === path,
  );
}
