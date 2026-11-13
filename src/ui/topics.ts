import { currentFile } from "./changes";
import { appGo, hasUi, setView } from "./appview";
import { jumpToBlocker } from "./blockers";
import { topicPoints } from "./topics-coverage-derive";
import { renderPoints, renderTopicShare } from "./topics-coverage-dom";
import { S, $, persist, toast } from "./store";
import { renderMarkdown } from "./markdown";
import { isGuideBaseStale } from "./guide-derive";
import { lineTotals } from "./walkthrough";
import { updateProgress } from "./progress";
import {
  firstTodo,
  groupEntry,
  nextTodo,
  placeOf,
  roundOf,
  stepGroup,
  stepTopic,
  topicPlaces,
  topicSettled,
  topicsDone,
  topicsNavRows,
  type TopicAt,
} from "./topics-derive";
import { decorateTopicPage, decorateTopicsOverview } from "./topicthreads";
import { groupPart, isOpenChange, mapTarget, topicBlockers } from "./topicthreads-derive";
import {
  renderTopicPage,
  renderTopicsNav,
  renderTopicsOverview,
  type TopicsOverview,
} from "./topics-dom";
import { layoutMap, MAP_WIDTH } from "./map-derive";
import { canvasMeasure, lightMapLinks } from "./map-dom";

// Decisions mode: the guide's topics, read one page at a time. It draws into its own sidebar list
// (#topicsNav) and centre (#topics); Code mode's diff and lists stand aside while it shows
// (styles/topics.css). The reviewer settles a topic (ReviewState.settledTopics) and resets it;
// nothing settles by being opened or read.

// The guide has topics, so the desk has Decisions mode.
export const hasTopics = () => !!S.state?.guide?.stages?.length;

const stages = () => S.state?.guide?.stages ?? [];

// Keep evidence expansion across redraws; a different topic starts folded with ten items.
let pointsCount = 10;
let pointsOpen = false;
let coverageOpen = false;
// What the centre showed when it was last drawn, so a redraw of the same page keeps its scroll.
let drawn: TopicAt | undefined;
// The groups whose fold of topics settled in earlier rounds the reviewer opened. Closed at first.
const earlierOpen = new Set<string>();

// Draw the sidebar list and the Overview or the open topic. A topic a new guide dropped falls back
// to the Overview.
export function renderTopics() {
  if (!hasTopics()) return;
  // A save or poll can redraw the list after a pick too; keep keyboard focus in that reply.
  const active = document.activeElement as HTMLElement | null;
  const replyOptions = active?.closest<HTMLElement>("[data-reply-options]")?.dataset.replyOptions;
  const optionPart = active?.closest<HTMLElement>("[data-option-part]")?.dataset.optionPart;
  if (!placeOf(stages(), S.topicAt)) S.topicAt = null;
  const nav = $("topicsNav");
  const threads = S.state.topicThreads ?? [];
  const requested = new Set(threads.filter(isOpenChange).map((t) => t.target.topic));
  renderTopicsNav(nav, topicsNavRows(stages(), S.topicAt, S.state, earlierOpen, requested));
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
    const settled = topicSettled(S.state, place.topic.id);
    const changed = !settled && !!S.state.topics?.[place.topic.id]?.changed;
    const requests = topicBlockers(threads, place.topic.id).length;
    renderTopicPage(
      page,
      place,
      renderMarkdown,
      { settled, changed, requests },
      {
        share: renderTopicShare(lines, c ? c.totalLines - c.skimmedLines : 0),
        points: renderPoints(topicPoints(place.topic, S.state), lines, hasUi(), pointsCount),
      },
    );
    decorateTopicPage(page, place.topic);
  } else {
    renderTopicsOverview(page, overview(page.clientWidth), renderMarkdown);
    decorateTopicsOverview(page);
    lightMap(page, lit);
  }
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
  updateProgress();
  if (replyOptions && optionPart)
    page
      .querySelector<HTMLElement>(
        `[data-reply-options="${CSS.escape(replyOptions)}"] [data-option-part="${CSS.escape(optionPart)}"] .topic-option`,
      )
      ?.focus({ preventScroll: true });
}

// The box or link the pointer names on the Overview, as a part (a box, or a link or a thread on
// one), so a redraw keeps it lit.
let lit: string | null = null;
function lightMap(page: HTMLElement, part: string | null) {
  const at = part === null ? null : mapTarget(part, S.state.guide?.links ?? []);
  if (at && "link" in at) lightMapLinks(page, null, at.link);
  else lightMapLinks(page, at?.group ?? null);
}

// The Overview's map is laid out for the room the page has: wider than the reading column, up to
// the widest it draws at, and never so narrow it stops being a map (it scrolls sideways instead).
function overview(room: number) {
  const st = S.state;
  const g = st.guide!;
  const links = g.links ?? [];
  const width = Math.max(720, Math.min(MAP_WIDTH, room - 76));
  const layout = layoutMap(stages(), links, canvasMeasure(), width);
  const groups = stages().reduce((n, s) => n + s.groups.length, 0);
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const totals = lineTotals(st.files);
  return {
    coverage: st.coverage,
    title: g.title || st.target || "Review",
    facts: [
      st.mode,
      st.session,
      `round ${roundOf(st)}`,
      count(st.files.length, "file"),
      count(stages().length, "stage"),
      count(groups, "group"),
      count(topicPlaces(stages()).length, "topic"),
    ],
    added: totals.added,
    removed: totals.removed,
    summary: g.overview,
    stale: isGuideBaseStale(st.baseDiffHash, g.baseDiffHash),
    way: wayIn(),
    ...(layout ? { map: { layout, stages: stages(), links } } : {}),
  };
}

// What the Overview's last button does: Start Review, Continue Review once anything is settled,
// and Send Review once nothing is left to do.
function wayIn(): TopicsOverview["way"] {
  const { done, total } = topicsDone(stages(), S.state);
  return done === total ? "send" : done ? "continue" : "start";
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
  const to = stepGroup(stages(), S.topicAt, dir, S.state);
  if (to !== undefined) openTopic(to);
}

// Open a group, by id, where it is entered: its first topic still to do (groupEntry). A group row
// in the sidebar and a box on the Overview's map.
export function openGroup(id: string) {
  const group = stages()
    .flatMap((s) => s.groups)
    .find((g) => g.id === id);
  const entry = group && groupEntry(group, S.state);
  if (entry) openTopic(entry);
}

// Start or Continue Review (↵ on the Overview): the review's first topic still to do. With none
// left, the way on is Send.
export function startTopics() {
  const first = firstTodo(stages(), S.state);
  if (first) openTopic(first);
  else S.confirmSend?.();
}

// Settle a topic (Settle Topic, ⇧A on the open one, its mark in the sidebar): its cover hash now,
// in this round. The desk stamps the round too, so a tab that missed another tab's Send can't
// misdate it (state.ts).
function settle(id: string) {
  const hash = S.state.topics?.[id]?.coverHash;
  if (hash === undefined) return false;
  S.state.settledTopics = { ...S.state.settledTopics, [id]: { hash, round: roundOf(S.state) } };
  persist();
  return true;
}

// What settling a topic says: Mark Reviewed, while it holds open change requests, marks it reviewed.
const settledWord = (id: string) =>
  topicBlockers(S.state.topicThreads ?? [], id).length ? "Marked reviewed" : "Topic settled";

// Settle the open topic and open the next one still to do; with none left, the Overview, which
// says so.
export function settleOpenTopic() {
  const id = S.topicAt;
  if (id === null || topicSettled(S.state, id) || !settle(id)) return;
  const next = nextTodo(stages(), S.state, id);
  if (next) {
    toast(settledWord(id));
    openTopic(next);
  } else {
    openTopic(null);
    toast("Every topic is settled. Send Review when you are ready.");
  }
}

// Reset a settled topic: it is to do again.
function reset(id: string) {
  S.state.settledTopics = Object.fromEntries(
    Object.entries(S.state.settledTopics ?? {}).filter(([key]) => key !== id),
  );
  persist();
  toast("Reset to do");
}

// A topic's mark in the sidebar settles it or resets it, and the page stays where it is.
function toggleTopic(id: string) {
  if (topicSettled(S.state, id)) reset(id);
  else if (settle(id)) toast(settledWord(id));
  renderTopics();
}

// Rows, the bar's buttons and the Overview's way in act through delegation, since every draw
// replaces them.
export function installTopics() {
  $("topicsNav").addEventListener("click", (e) => {
    const target = e.target as Element;
    const mark = target.closest<HTMLElement>("[data-mark]");
    if (mark?.dataset.mark) return toggleTopic(mark.dataset.mark);
    const row = target.closest<HTMLElement>("[data-topic], [data-group], [data-earlier]");
    if (row?.dataset.topic) openTopic(row.dataset.topic);
    else if (row?.dataset.group) openGroup(row.dataset.group);
    else if (row?.dataset.earlier) {
      const id = row.dataset.earlier;
      if (!earlierOpen.delete(id)) earlierOpen.add(id);
      renderTopics();
    }
  });
  const page = $("topics");
  page.addEventListener("click", (e) => {
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
    const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "start") startTopics();
    else if (act === "settle") settleOpenTopic();
    else if (act === "reset" && S.topicAt !== null) {
      reset(S.topicAt);
      renderTopics();
    }
    // A box on the Overview's map opens its group; ⇧ click and its comment button comment on it
    // (topicthreads.ts).
    const box = target.closest<HTMLElement>(".topics-map [data-group]");
    if (box?.dataset.group && !e.shiftKey && !target.closest("[data-gut]"))
      openGroup(box.dataset.group);
  });
  // ↵ or space on a focused box opens it, ahead of the Overview's own ↵ (Start Review). On its
  // comment button they press the button.
  page.addEventListener("keydown", (e) => {
    const target = e.target as Element;
    const box = target.closest<HTMLElement>(".topics-map [data-group]");
    if (!box?.dataset.group || (e.key !== "Enter" && e.key !== " ")) return;
    if (target.closest("[data-gut]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    openGroup(box.dataset.group);
  });
  // Pointing at a box lights its links; at a link, or a thread under the map (its chip), lights
  // the box or the link it names.
  page.addEventListener("mouseover", (e) => {
    const target = e.target as Element;
    const group = target.closest<HTMLElement>(".map-box")?.dataset.group;
    const named =
      target.closest<HTMLElement>("[data-map-part]")?.dataset.mapPart ??
      target.closest<HTMLElement>('.topics-map [data-gut^="link:"]')?.dataset.gut;
    const part = group !== undefined ? groupPart(group) : (named ?? null);
    if (part === lit) return;
    lit = part;
    lightMap(page, lit);
  });
  page.addEventListener("mouseleave", () => {
    lit = null;
    lightMap(page, null);
  });
  // The map measures its text, so it is laid out again when the room or the font changes.
  const overviewShowing = () => hasTopics() && S.view === "topics" && S.topicAt === null;
  let pending = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      if (overviewShowing()) renderTopics();
    });
  });
  document.fonts?.addEventListener("loadingdone", () => {
    if (overviewShowing()) renderTopics();
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
