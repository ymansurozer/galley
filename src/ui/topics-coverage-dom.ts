import type { TopicCoverage } from "../types";
import { esc } from "./html";
import { formatTopicShare, pointsPage, type TopicPoint } from "./topics-coverage-derive";

// Display the server-owned exclusive split; the tab never recomputes coverage from guide spans.
// Reasons remain inspectable even when another claim leaves a skim with zero exclusive lines.
export function renderCoverage(c?: TopicCoverage) {
  if (!c) return "";
  const width = (n: number) => (c.totalLines ? (n / c.totalLines) * 100 : 0);
  return `<section class="go-card topic-coverage"><div class="topic-coverage-head"><b>Coverage</b><span>${c.totalLines} lines</span></div>
    <div class="topic-coverage-bar" aria-label="${c.topicLines} lines under a topic, ${c.skimmedLines} skimmed, ${c.uncoveredLines} not in the guide yet"><i style="width:${width(c.topicLines)}%"></i><i style="width:${width(c.skimmedLines)}%"></i></div>
    <div class="topic-coverage-head"><span>Under a topic <b>${c.topicLines}</b></span><details><summary>Skimmed by rule <b>${c.skimmedLines}</b></summary><div class="topic-skims">${c.skims.map((s) => `<div><span><b>${esc(s.reason)}</b>${s.rule ? `<small>Rule: ${esc(s.rule)}</small>` : ""}</span><span>${s.lines} lines</span></div>`).join("")}</div></details></div>
    ${c.uncoveredLines ? `<p class="topic-coverage-gap">${c.uncoveredLines} lines not in the guide yet</p>` : ""}</section>`;
}

// Keep the raw numerator and unskimmed denominator available behind the rounded share.
export function renderTopicShare(lines: number, unskimmed: number) {
  return `<span class="topic-share" title="${lines} of ${unskimmed} unskimmed lines">${formatTopicShare(lines, unskimmed)} of unskimmed lines</span>`;
}

// Evidence starts folded so long file lists do not interrupt reading. Pages remain visible
// without an app, but navigation is offered only where the desk can open the target.
export function renderPoints(items: TopicPoint[], lines: number, hasApp: boolean, count = 10) {
  const pages = items.filter((p) => p.kind === "page").length;
  const code = items.length - pages;
  const what = [
    pages ? `${pages} page${pages === 1 ? "" : "s"}` : "",
    code ? `${code} place${code === 1 ? "" : "s"} in the code` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const page = pointsPage(items, count);
  return `<details class="topic-points"><summary>Points to <span>${what}</span><span>${lines} lines</span></summary><div class="topic-points-list">${page.items
    .map((p) => {
      const code = p.kind === "code";
      const attrs = code
        ? `data-topic-code="${esc(p.path)}" data-line="${p.line}"`
        : hasApp
          ? `data-topic-app="${esc(p.path)}"`
          : "";
      const name = code ? p.path.split("/").pop()! : p.path;
      const dir = code ? p.path.slice(0, -name.length) : "";
      const tag = attrs ? "button" : "div";
      return `<${tag} class="topic-point" ${attrs} title="${esc(p.path)}"><b>${esc(name)}${code ? `:${p.line}` : ""}</b><span>${esc(dir)}${code ? ` · ${p.lines} lines` : ""}</span><span>${code ? "Open in Code" : hasApp ? "Open in App" : ""}</span></${tag}>`;
    })
    .join(
      "",
    )}${page.more ? `<button class="topic-more" data-topic-more>Show ${page.more} more <span>${items.length - count} left</span></button>` : ""}</div></details>`;
}
