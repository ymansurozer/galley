import { renderTopicBody } from "./topics-body-dom";
import { esc } from "./html";
import { keycapsHtml } from "./keycaps";
import type { TopicPlace, TopicsNavRow } from "./topics-derive";

// Decisions mode's markup: the sidebar's stage, group and topic rows, the topic page and the
// Overview. Markdown is rendered by the caller (`md`), which sanitises it.

const glyph = (name: string, cls: string) =>
  `<svg class="ic ${cls}" aria-hidden="true"><use href="#gly-${name}"></use></svg>`;

// A row of the sidebar. A topic shows at most two lines, its full title on hover, and the open one
// whole (topics.css); its circle sits under the first letter of its group's name.
function navRow(r: TopicsNavRow) {
  if (r.kind === "stage")
    return `<div class="node walk-cat" title="${esc(r.label)}"><span class="nm walk-cat-name">${esc(r.label)}</span></div>`;
  if (r.kind === "group") {
    const topics = `${r.count} topic${r.count === 1 ? "" : "s"}`;
    return `<div class="node topics-group${r.current ? " current" : ""}" data-group="${esc(r.id)}" title="${esc(r.title)} · ${topics}"><span class="nm">${esc(r.title)}</span><span class="status-pack"><i class="topics-n" aria-label="${topics}">${r.count}</i></span></div>`;
  }
  const flag = r.flagged
    ? `<svg class="ic crit" role="img" aria-label="Flagged"><title>Flagged</title><use href="#gly-flag"></use></svg>`
    : "";
  return `<div class="node topics-topic${r.open ? " active" : ""}" data-topic="${esc(r.id)}" title="${esc(r.title)}">${glyph("circle", "st pending")}<span class="topics-tt">${esc(r.title)}</span>${flag}</div>`;
}

export function renderTopicsNav(host: HTMLElement, rows: TopicsNavRow[]) {
  host.innerHTML = rows.map(navRow).join("");
}

// A topic's page: the bar naming its stage and group, then the topic as a reading column — its
// concern, title, where the call is recorded, the body, and the Flagged card under the body.
export function renderTopicPage(host: HTMLElement, place: TopicPlace, md: (s: string) => string) {
  const { topic, group, stage } = place;
  const where = `${stage.label} / ${group.title}`;
  const bar = `<div class="file-bar topics-bar"><span class="fb-path" title="${esc(where)}"><span class="fb-dir"><bdi>${esc(stage.label)} /&nbsp;</bdi></span><span class="fb-name">${esc(group.title)}</span></span><span class="fb-grow"></span></div>`;
  const meta = topic.concern
    ? `<div class="topic-meta"><span class="topic-concern">${esc(topic.concern)}</span></div>`
    : "";
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
};

// The Overview: title and facts, the guide's summary, and Start Review at the end.
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
  </div><div class="go-card topics-end"><div class="go-actions"><button class="btn primary" data-act="start">Start Review ${keycapsHtml("↵")}</button></div></div></div>`;
}
