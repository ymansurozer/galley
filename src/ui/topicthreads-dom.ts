import { esc } from "./html";
import { bodyLine, groupPart, linkPart, type MapTint } from "./topicthreads-derive";
import type { TopicThread } from "../types";

// The markup that makes a rendered topic page commentable: each part found on the page, marked
// with a gutter button, and the place under it where its threads and the composer go. Store-free:
// topicthreads.ts decides what to place, and the cards come built.

// A part's element on a page drawn by renderTopicPage: the title, the Recorded line, the Flagged
// card, or a block of the body by its source line. A body block is a direct child of the body
// carrying that line, or an item of a top-level list: a list and its first item share their line,
// and only the item is a part (topicthreads.ts bodyBlocks, the desk's list). On the Overview
// (renderTopicsOverview): the summary, the map and the coverage card.
const OWN_ELEMENT: Record<string, string> = {
  title: ".topic-title",
  recorded: ".topic-recorded",
  flag: ".topic-flag",
  summary: ".go-overview",
  map: ".topics-map",
  coverage: ".topic-coverage",
};
export function partElement(page: ParentNode, part: string): HTMLElement | null {
  const own = OWN_ELEMENT[part];
  if (own) return page.querySelector(own);
  const line = String(bodyLine(part));
  const body = page.querySelector(".topic-body");
  for (const child of body?.children ?? []) {
    if (child.tagName !== "UL" && child.tagName !== "OL") {
      if ((child as HTMLElement).dataset.line === line) return child as HTMLElement;
      continue;
    }
    for (const item of child.children)
      if ((item as HTMLElement).dataset.line === line) return item as HTMLElement;
  }
  return null;
}

// Make each of `parts` that is on the page a part: a list item takes its gutter button inside it;
// any other element is wrapped, so the button sits beside a table or a code block without
// entering it. `cursor`: the part the keyboard's cursor is on; `has`: parts with an open thread,
// whose button stays in view. Answers each part's element, by part.
export function markParts(
  page: HTMLElement,
  parts: readonly string[],
  cursor: string | null,
  has: ReadonlySet<string>,
): Map<string, HTMLElement> {
  const doc = page.ownerDocument;
  const marked = new Map<string, HTMLElement>();
  // Found before any is wrapped: a wrapped block is no longer a child of the body.
  const found = parts.flatMap((part) => {
    const el = partElement(page, part);
    return el ? [{ part, el }] : [];
  });
  for (const { part, el } of found) {
    let holder = el;
    if (el.tagName !== "LI") {
      holder = doc.createElement("div");
      el.replaceWith(holder);
      holder.append(el);
    }
    holder.classList.add("topic-part");
    holder.classList.toggle("topic-cur", part === cursor);
    holder.classList.toggle("topic-has", has.has(part));
    holder.dataset.part = part;
    const gut = doc.createElement("button");
    gut.type = "button";
    gut.className = "topic-gut";
    gut.dataset.gut = part;
    gut.setAttribute("aria-label", "Comment on this part");
    gut.dataset.tip = "Comment, or ⇧ click the part";
    gut.dataset.tipKeys = "c";
    gut.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#gly-message"></use></svg>`;
    holder.prepend(gut);
    marked.set(part, holder);
  }
  return marked;
}

// Where what sits under a part goes: inside a list item, at its end, so it reads as the item's;
// else just after the part. One holder per part, made on first use.
export function underPart(part: HTMLElement): HTMLElement {
  const own = part.tagName === "LI" ? part.lastElementChild : part.nextElementSibling;
  if (own?.classList.contains("topic-threads")) return own as HTMLElement;
  const slot = part.ownerDocument.createElement("div");
  slot.className = "topic-threads";
  if (part.tagName === "LI") part.append(slot);
  else part.after(slot);
  return slot;
}

// The blockers chip on a topic's bar: how many open change requests it holds, opening a list of
// them, each a button carrying its thread's id. Null with none.
export function topicBlockersChip(
  doc: Document,
  items: ReadonlyArray<{ id: string; where: string; text: string }>,
): HTMLElement | null {
  if (!items.length) return null;
  const wrap = doc.createElement("span");
  wrap.className = "blockers";
  const n = items.length;
  const rows = items
    .map(
      (b) =>
        `<button class="blockers-item change" data-thread="${esc(b.id)}"><span class="bk-kind"><svg class="ic"><use href="#gly-flag"></use></svg>Change request</span><span class="bk-where">${esc(b.where)}</span><span class="bk-text">${esc(b.text)}</span></button>`,
    )
    .join("");
  wrap.innerHTML = `<button class="blockers-chip" aria-expanded="false" data-tip="Open change requests on this topic">${n} blocker${n === 1 ? "" : "s"}</button><div class="blockers-pop" role="menu"><div class="blockers-head">Change requests on this topic</div>${rows}</div>`;
  return wrap;
}

// The threads on topics a new guide dropped, as a section at the end of the Overview (`overview`),
// before its way in: grouped under the title each thread kept, each drawn by `card`. No section
// without such threads.
export function placeDroppedThreads(
  overview: HTMLElement,
  threads: readonly TopicThread[],
  card: (t: TopicThread) => HTMLElement,
) {
  if (!threads.length) return;
  const doc = overview.ownerDocument;
  const section = doc.createElement("section");
  section.className = "go-card topics-dropped";
  section.innerHTML = `<h2 class="topics-dropped-head">Requests on topics no longer in the guide</h2>`;
  const byTitle = new Map<string, TopicThread[]>();
  for (const t of threads) byTitle.set(t.title, [...(byTitle.get(t.title) ?? []), t]);
  for (const [title, list] of byTitle) {
    const topic = doc.createElement("div");
    topic.className = "topics-dropped-topic";
    topic.innerHTML = `<h3>${esc(title || "Untitled topic")}</h3><div class="topic-threads"></div>`;
    topic.querySelector(".topic-threads")!.append(...list.map(card)); // written just above
    section.append(topic);
  }
  const end = overview.querySelector(".topics-end");
  if (end) end.before(section);
  else overview.append(section);
}

// ── The Overview's map ───────────────────────────────────────────────────────────────────────────

const COMMENT_GLYPH = `<svg class="ic" aria-hidden="true"><use href="#gly-message"></use></svg>`;

// The parts a map element speaks for: its own link, or every link a shared label or list line
// says (map-dom.ts writes their ends as JSON, so any group id survives).
function linkParts(el: HTMLElement | SVGElement): string[] {
  const { links, from, to } = el.dataset;
  const ends: unknown = links ? JSON.parse(links) : [[from, to]];
  if (!Array.isArray(ends)) return [];
  return ends.flatMap((e) =>
    Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string"
      ? [linkPart(e[0], e[1])]
      : [],
  );
}

// Make the Overview's map (map-dom.ts's markup, the drawing and the narrow list) commentable: each
// box and each list row gets a comment button; each drawn link a wide invisible line to point at;
// and a link's label, note and list line open the composer on it, as its button does (`data-gut`,
// topicthreads.ts). A box or a link with an open thread is tinted by `tints` (by part); a label or
// a list line that speaks for several links takes the strongest of theirs.
export function markMap(host: ParentNode, tints: ReadonlyMap<string, MapTint>) {
  const doc = (host as Node).ownerDocument!; // a node in a document: the Overview's page
  const tint = (el: Element, parts: string[]) => {
    const has = parts.map((p) => tints.get(p));
    const kind = has.includes("change") ? "change" : has.includes("question") ? "question" : null;
    el.classList.toggle("map-ask", kind === "question");
    el.classList.toggle("map-change", kind === "change");
  };
  for (const box of host.querySelectorAll<HTMLElement>(".map-box, .map-list-row")) {
    const part = groupPart(box.dataset.group ?? "");
    const title = box.title || box.querySelector(".map-list-title")?.textContent || "this group";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "map-cm";
    button.dataset.gut = part;
    button.setAttribute("aria-label", `Comment on ${title}`);
    button.dataset.tip = "Comment, or ⇧ click the box";
    button.innerHTML = COMMENT_GLYPH;
    box.append(button);
    tint(box, [part]);
  }
  for (const link of host.querySelectorAll<SVGGElement>(".map-link")) {
    const [part] = linkParts(link);
    const line = link.querySelector("path");
    if (!part || !line) continue;
    const hit = line.cloneNode() as SVGPathElement;
    hit.setAttribute("class", "map-hit");
    hit.dataset.gut = part;
    link.append(hit);
    tint(link, [part]);
  }
  for (const el of host.querySelectorAll<HTMLElement | SVGElement>(
    ".map-label, .map-note, .map-list-feed",
  )) {
    const parts = linkParts(el);
    // The label's own link: the one whose line carries it.
    const own = el.dataset.from !== undefined && linkPart(el.dataset.from, el.dataset.to ?? "");
    if (own || parts[0]) el.dataset.gut = own || parts[0];
    tint(el, parts);
  }
  for (const el of host.querySelectorAll<SVGElement>(".map-cross")) tint(el, linkParts(el));
}

// A thread under the map: a chip after its kind naming the box or the link it is about, and its
// part on the card, so pointing at it lights that box or link (topics.ts).
export function chipThread(card: HTMLElement, part: string, label: string) {
  card.dataset.mapPart = part;
  const head = card.querySelector(".tc-head, .thread-summary");
  if (!head) return;
  const chip = card.ownerDocument.createElement("span");
  chip.className = "topic-anchor";
  chip.textContent = label;
  const kind = head.querySelector(":scope > .tc-kind, :scope > b");
  if (kind) kind.after(chip);
  else head.prepend(chip);
}
