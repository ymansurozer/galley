import type { GuideLink } from "../types";
import { esc } from "./html";
import {
  arrowHead,
  MAP_TEXT,
  roundedPath,
  type MapFont,
  type MapLayout,
  type MapStage,
  type Measure,
} from "./map-derive";

// The Overview's map, drawn from its layout (map-derive.ts): HTML boxes over one SVG of lines, so a
// link crossing a box is hidden by it, and that stretch drawn on top as light dots. Every box, line,
// label and note carries the group id or the link's ends, so the Overview can light and open them.
// Narrow windows get the list instead (styles/map.css swaps them).

// Link ends as data attributes.
const ends = (from: string, to: string) => `data-from="${esc(from)}" data-to="${esc(to)}"`;

export function mapHtml(layout: MapLayout) {
  const { width: W, height: H, boxW, boxH } = layout;
  const svg = (cls: string, body: string) =>
    `<svg class="${cls}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${body}</svg>`;
  const lines = layout.links
    .filter((l) => l.points)
    .map(
      (l) =>
        `<g class="map-link" ${ends(l.from, l.to)}><path d="${roundedPath(l.points!)}"/><path class="map-arrow" d="${arrowHead(l.points!)}"/></g>`,
    )
    .join("");
  const labels = layout.links
    .filter((l) => l.caption)
    .map((l) => {
      const c = l.caption!;
      const spans = c.lines
        .map((s, i) => `<tspan x="${c.x}" dy="${i ? MAP_TEXT.labelLine : 0}">${esc(s)}</tspan>`)
        .join("");
      return `<text class="map-label" ${ends(l.from, l.to)} data-links="${esc(c.links.join(" "))}" x="${c.x}" y="${c.y}" text-anchor="${c.anchor}">${spans}</text>`;
    })
    .join("");
  const heads = layout.heads
    .map(
      (h) =>
        `<div class="map-head" style="left:${h.x}px;top:${h.y}px;width:${h.w}px" title="${esc(h.label)}">${esc(h.label)}</div>`,
    )
    .join("");
  const boxes = layout.boxes
    .map((b) => {
      const text = (cls: string, ls: string[]) =>
        ls.length
          ? `<span class="${cls}">${ls.map((s) => `<span>${esc(s)}</span>`).join("")}</span>`
          : "";
      const name = b.title.join(" ");
      return `<div class="map-box" role="button" tabindex="0" data-group="${esc(b.id)}" style="left:${b.x}px;top:${b.y}px;width:${boxW}px;height:${boxH}px" title="${esc(name)}" aria-label="Open ${esc(name)}">${text("map-title", b.title)}${text("map-sum", b.summary)}</div>`;
    })
    .join("");
  const dots = layout.links
    .flatMap((l) =>
      l.crossings.map(
        (c) =>
          `<path class="map-cross" ${ends(l.from, l.to)} data-box="${esc(c.box)}" d="M${c.x1} ${c.y} L${c.x2} ${c.y}"/>`,
      ),
    )
    .join("");
  const notes = layout.links
    .filter((l) => l.note)
    .map(
      (l) =>
        `<div class="map-note" ${ends(l.from, l.to)} style="left:${l.note!.x}px;top:${l.note!.y}px">${l.note!.lines.map(esc).join("<br>")}</div>`,
    )
    .join("");
  return `<div class="map${layout.cards ? " map-cards" : ""}" style="width:${W}px;height:${H}px">${svg("map-lines", lines + labels)}${heads}${boxes}${dots ? svg("map-lines map-dots", dots) : ""}${notes}</div>`;
}

// The narrow window's map: each stage's groups under it, each with what it feeds. Links leaving a
// group with one label are one line, naming every group they reach.
export function mapListHtml(stages: MapStage[], links: GuideLink[]) {
  const title = new Map(stages.flatMap((s) => s.groups.map((g) => [g.id, g.title] as const)));
  return `<div class="map-list">${stages
    .map(
      (s) =>
        `<div class="map-list-stage">${esc(s.label)}</div>` +
        s.groups
          .map((g) => {
            const by = new Map<string, GuideLink[]>();
            for (const l of links)
              if (l.from === g.id && title.has(l.to))
                (by.get(l.label) ?? by.set(l.label, []).get(l.label)!).push(l);
            const feeds = [...by.values()]
              .map(
                (ls) =>
                  `<span class="map-list-feed" ${ends(ls[0]!.from, ls[0]!.to)} data-links="${esc(ls.map((l) => `${l.from}>${l.to}`).join(" "))}"><span class="map-list-arrow" aria-hidden="true">→</span> ${ls.map((l) => esc(title.get(l.to)!)).join(", ")} <i>${esc(ls[0]!.label)}</i></span>`,
              )
              .join("");
            return `<div class="map-list-row" role="button" tabindex="0" data-group="${esc(g.id)}"><span class="map-list-title">${esc(g.title)}</span><span class="map-list-feeds">${feeds}</span></div>`;
          })
          .join(""),
    )
    .join("")}</div>`;
}

// Light the links into and out of a group (null puts every link back), dimming the rest.
export function lightMapLinks(host: ParentNode, group: string | null) {
  const map = host.querySelector(".map");
  if (!map) return;
  const touches = (el: Element) => {
    if (!group) return false;
    const e = el as HTMLElement | SVGElement;
    const keys = e.dataset.links?.split(" ") ?? [`${e.dataset.from}>${e.dataset.to}`];
    return keys.some((k) => k.split(">").includes(group));
  };
  const parts = map.querySelectorAll(".map-link, .map-label, .map-cross, .map-note");
  const any = [...parts].some(touches);
  map.classList.toggle("map-focus", any);
  for (const el of parts) el.classList.toggle("map-hot", any && touches(el));
  for (const el of map.querySelectorAll<HTMLElement>(".map-box"))
    el.classList.toggle("map-hot", any && el.dataset.group === group);
}

// The browser's measurer: canvas text widths in the map's own faces, read from the page's sans font.
export function canvasMeasure(doc: Document = document): Measure {
  const ctx = doc.createElement("canvas").getContext("2d");
  const sans =
    getComputedStyle(doc.documentElement).getPropertyValue("--sans").trim() ||
    "system-ui, sans-serif";
  const face: Record<MapFont, string> = {
    label: `400 10px ${sans}`,
    title: `500 13px ${sans}`,
    summary: `400 11.5px ${sans}`,
  };
  // No canvas (a test DOM): a rough width keeps the layout going.
  if (!ctx) return (text, font) => text.length * (font === "label" ? 5.5 : 7);
  return (text, font) => {
    ctx.font = face[font];
    return ctx.measureText(text).width;
  };
}
