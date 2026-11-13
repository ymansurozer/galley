import { renderTopicBody } from "./topics-body-dom";
import { esc } from "./html";
import { keycapsHtml } from "./keycaps";
import type { TopicPlace, TopicsNavRow } from "./topics-derive";
import { signOffStand, topicMark, type TopicSignOffStand } from "./topicthreads-derive";

// Decisions mode's markup: the sidebar's stage, group and topic rows, the topic page and the
// Overview. Markdown is rendered by the caller (`md`), which sanitises it.

const glyph = (name: string, cls: string) =>
  `<svg class="ic ${cls}" aria-hidden="true"><use href="#gly-${name}"></use></svg>`;

// A topic's or a group's mark: to do, done, or change requested while an open change request is on
// it (topicthreads-derive topicMark).
const MARKS = {
  change: glyph("circle-alert", "st changes"),
  done: glyph("check", "st approved"),
  todo: glyph("circle", "st pending"),
};
const mark = (settled: boolean, requested = false) => MARKS[topicMark(settled, requested)];

// A row of the sidebar. A group shows what is done of this round's topics, and its mark. A topic
// shows at most two lines, its full title on hover, and the open one whole (topics.css); its mark,
// a button that settles or resets it, sits under the first letter of its group's name.
function navRow(r: TopicsNavRow) {
  if (r.kind === "stage")
    return `<div class="node walk-cat" title="${esc(r.label)}"><span class="nm walk-cat-name">${esc(r.label)}</span></div>`;
  if (r.kind === "group") {
    const word = r.settled ? "Nothing to do" : `${r.total - r.done} to do`;
    const count = r.total ? `<i class="topics-n">${r.done}/${r.total}</i>` : "";
    return `<div class="node topics-group${r.current ? " current" : ""}" data-group="${esc(r.id)}" title="${esc(r.title)} · ${word}"><span class="nm">${esc(r.title)}</span><span class="status-pack" aria-label="${word}">${count}${mark(r.settled, r.requested)}</span></div>`;
  }
  if (r.kind === "earlier")
    return `<div class="node topics-earlier" data-earlier="${esc(r.group)}" role="button" aria-expanded="${r.open}">${glyph("chevron", `chev${r.open ? " open" : ""}`)}<span class="nm">${esc(r.label)}</span></div>`;
  const flag = r.flagged
    ? `<svg class="ic crit" role="img" aria-label="Flagged"><title>Flagged</title><use href="#gly-flag"></use></svg>`
    : "";
  const tip = r.settled ? "Reset to do" : "Settle topic";
  return `<div class="node topics-topic${r.open ? " active" : ""}${r.settled ? " settled" : ""}" data-topic="${esc(r.id)}" title="${esc(r.title)}"><button type="button" class="topics-mk" data-mark="${esc(r.id)}" title="${tip}" aria-label="${tip}">${mark(r.settled, r.requested)}</button><span class="topics-tt">${esc(r.title)}</span>${flag}</div>`;
}

export function renderTopicsNav(host: HTMLElement, rows: TopicsNavRow[]) {
  host.innerHTML = rows.map(navRow).join("");
}

// Where the open topic stands: settled (its sign-off is current), or to do with its lines changed
// since the reviewer's last round; and how many open change requests it holds.
export type TopicStand = { settled: boolean; changed: boolean; requests?: number };

// The bar's end: Settle Topic (Mark Reviewed while it holds open change requests), or once settled
// its state (Settled, or Reviewed with requests) and Reset.
function barActions(stand: TopicSignOffStand) {
  const reset = `<button class="btn quiet sm" data-act="reset">Reset</button>`;
  if (stand === "settled")
    return `<span class="fb-state ok">${glyph("check", "")}Settled</span>${reset}`;
  if (stand === "reviewed")
    return `<span class="fb-state warn">${glyph("circle-alert", "")}Reviewed with requests</span>${reset}`;
  const label = stand === "mark" ? "Mark Reviewed" : "Settle Topic";
  return `<button class="signoff fill${stand === "mark" ? " warn" : ""}" data-act="settle">${label} ${keycapsHtml("⇧A")}</button>`;
}

// A topic's page: the bar naming its stage and group with its sign-off, then the topic as a reading
// column — its concern and whether it changed since the last round, title, where the call is
// recorded, the body, and the Flagged card under the body.
export function renderTopicPage(
  host: HTMLElement,
  place: TopicPlace,
  md: (s: string) => string,
  stand: TopicStand = { settled: false, changed: false },
) {
  const { topic, group, stage } = place;
  const where = `${stage.label} / ${group.title}`;
  const bar = `<div class="file-bar topics-bar"><span class="fb-path" title="${esc(where)}"><span class="fb-dir"><bdi>${esc(stage.label)} /&nbsp;</bdi></span><span class="fb-name">${esc(group.title)}</span></span><span class="fb-grow"></span><span class="fb-actions">${barActions(signOffStand(stand.settled, stand.requests ?? 0))}</span></div>`;
  const tags = [
    topic.concern ? `<span class="topic-concern">${esc(topic.concern)}</span>` : "",
    stand.changed ? `<span class="topic-changed">Changed since your last round</span>` : "",
  ].join("");
  const meta = tags ? `<div class="topic-meta">${tags}</div>` : "";
  const flag = topic.flag
    ? `<div class="topic-flag"><div class="topic-lab">${glyph("flag", "")}Flagged</div><div class="md">${md(topic.flag)}</div></div>`
    : "";
  host.innerHTML = `${bar}<article class="topic-page">${meta}<h1 class="topic-title">${esc(topic.title)}</h1><p class="topic-recorded"><b>Recorded:</b> ${esc(topic.recorded)}</p><div class="topic-body md"></div>${flag}</article>`;
  void renderTopicBody(host.querySelector<HTMLElement>(".topic-body")!, topic.body, md);
}

export type TopicsOverview = {
  title: string;
  // The review's facts, one line: what is under review and how big it is.
  facts: string[];
  added: number;
  removed: number;
  summary: string;
  stale: boolean;
  // The way in at the end: Start Review, Continue Review, or Send Review once every topic is
  // settled.
  way: "start" | "continue" | "send";
};

function wayIn(way: TopicsOverview["way"]) {
  const label = { start: "Start Review", continue: "Continue Review", send: "Send Review" }[way];
  const all = way === "send" ? `<p class="topics-all">Every topic is settled.</p>` : "";
  return `${all}<button class="btn primary" data-act="start">${label} ${keycapsHtml("↵")}</button>`;
}

// The Overview: title and facts, the guide's summary, and the way in at the end.
export function renderTopicsOverview(
  host: HTMLElement,
  o: TopicsOverview,
  md: (s: string) => string,
) {
  const stale = o.stale
    ? `<div class="go-stale">${glyph("warn", "")} This guide was generated for an earlier version of the diff. Regenerate it and attach it with <code>galley reload --guide &lt;file&gt;</code> to refresh.</div>`
    : "";
  host.innerHTML = `<div class="guide-overview topics-overview"><div class="go-card">
    <h1>${esc(o.title)}</h1>
    <div class="go-sub">${o.facts.map(esc).join(" · ")} · <span class="add">+${o.added}</span> <span class="del">−${o.removed}</span></div>
    ${stale}
    <div class="go-overview md">${md(o.summary)}</div>
  </div><div class="go-card topics-end"><div class="go-actions">${wayIn(o.way)}</div></div></div>`;
}
