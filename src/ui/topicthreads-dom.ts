import { esc } from "./html";
import { bodyLine } from "./topicthreads-derive";

// The markup that makes a rendered topic page commentable: each part found on the page, marked
// with a gutter button, and the place under it where its threads and the composer go. Store-free:
// topicthreads.ts decides what to place, and the cards come built.

// A part's element on a page drawn by renderTopicPage: the title, the Recorded line, the Flagged
// card, or a block of the body by its source line. A body block is a direct child of the body
// carrying that line, or an item of a top-level list: a list and its first item share their line,
// and only the item is a part (topicthreads.ts bodyBlocks, the desk's list).
export function partElement(page: ParentNode, part: string): HTMLElement | null {
  if (part === "title") return page.querySelector(".topic-title");
  if (part === "recorded") return page.querySelector(".topic-recorded");
  if (part === "flag") return page.querySelector(".topic-flag");
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
