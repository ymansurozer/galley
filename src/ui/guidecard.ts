import { S, $ } from "./store";
import { currentFile } from "./changes";
import { currentGuideEntry, guideStale } from "./guide";
import { renderMarkdown } from "./markdown";
import { syncFileBarHeight } from "./filebar";
import type { GuideFile } from "./types";

// ── The guide card ───────────────────────────────────────────────────────────
// The guide's note on the open file: one card under the file bar, in the flow, for any view of a
// file the guide has an entry for. Once it scrolls up under the bar it comes back pinned as one
// line inside the bar (category · clamped orientation · inline flag · chevron), and the chevron
// opens the full note over the code. A stale guide says so inside the card.

const STALE =
  "Guide generated for an earlier diff — regenerate and restart with --guide to refresh";

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function bookIcon(): HTMLElement {
  const tile = el("span", "gc-icon");
  tile.innerHTML = `<svg class="ic"><use href="#gly-book"></use></svg>`;
  return tile;
}

// "Guide · <category>", the category amber when the file is flagged, then a skim mark when the
// guide skims the whole file.
function heading(entry: GuideFile): HTMLElement {
  const h = el("span", "gc-head", "Guide · ");
  h.appendChild(el("span", "gc-cat" + (entry.flag ? " crit" : ""), entry.category));
  if (entry.skim) {
    const mark = el("span", "gc-skim-mark");
    mark.innerHTML = `<svg class="ic"><use href="#gly-collapse-all"></use></svg>`;
    mark.append("skimmed");
    h.appendChild(mark);
  }
  return h;
}

// A skimmed entry's reason, in the orientation's place when the guide gives none. The heading's
// mark already says "skimmed" when it shows.
function skimText(entry: GuideFile): string {
  const reason = entry.skimReason ?? "";
  return entry.skim ? reason : `skimmed · ${reason}`;
}

// The full note: orientation (or the skim reason a whole-file skim may give instead), the flag,
// and the stale line. The prose renders as markdown (renderMarkdown sanitizes): it's the main
// reading of a guided review, so the identifiers and lists the agent writes survive.
function fullBody(entry: GuideFile): HTMLElement {
  const body = el("div", "gc-body");
  body.appendChild(heading(entry));
  if (entry.orientation) {
    const o = el("div", "gc-orient md");
    o.innerHTML = renderMarkdown(entry.orientation);
    body.appendChild(o);
  } else if (entry.skimReason) body.appendChild(el("div", "gc-skim", skimText(entry)));
  if (entry.flag) {
    const f = el("div", "gc-flag");
    f.innerHTML = `<svg class="ic"><use href="#gly-flag"></use></svg><div class="md">${renderMarkdown(entry.flag)}</div>`;
    body.appendChild(f);
  }
  if (guideStale()) {
    const s = el("div", "gc-stale");
    s.append(el("span", "gc-stale-dot"), STALE);
    body.appendChild(s);
  }
  return body;
}

// The card in the flow, for render() to mount under the bar. Null for a file without an entry, and
// for a preview: an unchanged file isn't in the guide.
export function guideCard(): HTMLElement | null {
  const entry = S.preview ? null : currentGuideEntry();
  if (!entry) return null;
  const card = el("section", "guide-card");
  // Chrome with the file bar it pins under, so the appearance's (tokens.css), not the code's.
  card.dataset.scheme = "chrome";
  card.append(bookIcon(), fullBody(entry));
  return card;
}

// ── Pinned ──
// The one-line card lives inside the file bar (absolutely placed under it, so the bar's own layout
// never moves) and shows while it carries .pinned. An IntersectionObserver on the in-flow card
// sets that: no scroll listener, no layout reads per scroll. While pinned, the line's height
// counts in --file-bar-h (filebar.ts), so jumps land below everything pinned.

let mini: HTMLElement | null = null;
let pinned = false;
let open = false;
let shownFor = "";
// What the pinned line was last built from: a render that changes none of it (a poll, a decision,
// a comment) keeps the line as it is, an open note's scroll and focus included.
let builtFrom = "";
let io: IntersectionObserver | null = null;
let tracked: HTMLElement | null = null;

const fileBar = () => $("diff").querySelector<HTMLElement>(":scope > .file-bar");

// The pinned line's element, persistent so the bar's ResizeObserver can watch its height.
export function guideMiniElement(): HTMLElement {
  if (!mini) mini = el("div", "guide-mini");
  return mini;
}

// Fill the pinned line for the open file and return it for the bar to carry, or null when the file
// has no card. A different file starts closed and unpinned; the observer re-reports the new card.
export function guideMini(): HTMLElement | null {
  const entry = S.preview ? null : currentGuideEntry();
  const path = currentFile()?.path ?? "";
  if (path !== shownFor) {
    shownFor = path;
    setOpen(false);
    setPinned(false);
  }
  if (!entry) return null;
  const m = guideMiniElement();
  const stale = guideStale();
  const from = JSON.stringify([path, entry, stale]);
  if (from === builtFrom && m.firstChild) return m;
  builtFrom = from;
  const line = el("div", "gm-line");
  line.appendChild(bookIcon());
  line.appendChild(heading(entry));
  const orient = el("span", "gm-orient" + (entry.orientation ? " md" : " skim"));
  if (entry.orientation) orient.innerHTML = renderMarkdown(entry.orientation);
  else if (entry.skimReason) orient.textContent = skimText(entry);
  line.appendChild(orient);
  if (entry.flag) {
    const f = el("span", "gm-flag");
    f.innerHTML = `<svg class="ic"><use href="#gly-flag"></use></svg><span class="md">${renderMarkdown(entry.flag)}</span>`;
    line.appendChild(f);
  }
  if (stale) {
    const s = el("span", "gm-stale");
    s.title = STALE;
    s.append(el("span", "gc-stale-dot"), "stale");
    line.appendChild(s);
  }
  const chev = document.createElement("button");
  chev.className = "btn icon sm gm-toggle";
  chev.setAttribute("aria-label", "Show the full guide note");
  chev.setAttribute("aria-expanded", String(open));
  chev.dataset.tip = "Guide note";
  chev.innerHTML = `<svg class="ic"><use href="#gly-chevron"></use></svg>`;
  chev.onclick = (e) => {
    e.stopPropagation();
    setOpen(!open);
  };
  line.appendChild(chev);
  const full = el("div", "gm-full");
  full.appendChild(fullBody(entry));
  m.replaceChildren(line, full);
  return m;
}

// Replay the entrance on `target`: only on a pin or an open, never on a render.
function enter(target: Element | null | undefined) {
  if (!target) return;
  target.classList.remove("entering");
  void (target as HTMLElement).offsetWidth; // restart the animation
  target.classList.add("entering");
  target.addEventListener("animationend", () => target.classList.remove("entering"), {
    once: true,
  });
}

function setPinned(p: boolean) {
  if (p === pinned) return;
  pinned = p;
  mini?.classList.toggle("pinned", p);
  if (p) enter(mini);
  // Back at the top the card is in view again, so an expanded copy has nothing to add.
  if (!p) setOpen(false);
  syncFileBarHeight();
}

// A click anywhere but the expanded card (or its chevron) closes it.
function outside(e: MouseEvent) {
  if (!mini?.contains(e.target as Node)) setOpen(false);
}

function setOpen(o: boolean) {
  if (o === open) return;
  open = o;
  mini?.classList.toggle("open", o);
  if (o) enter(mini?.querySelector(".gm-full"));
  mini?.querySelector(".gm-toggle")?.setAttribute("aria-expanded", String(o));
  if (o) document.addEventListener("click", outside, true);
  else document.removeEventListener("click", outside, true);
}

// Esc's layer for the expanded card (keys.ts). False when it isn't open.
export function closeGuideCard(): boolean {
  // The App view hides it: Esc there belongs to the app's own layers.
  if (!open || S.view !== "code") return false;
  setOpen(false);
  return true;
}

// Watch the mounted card (null: none on screen). The root margin trims the bar's height off the
// top of #diff, so the card counts as gone once it has slid entirely under the bar; a card below
// the view (never, at the top of a file) or one that left the page doesn't pin.
export function trackGuideCard(card: HTMLElement | null) {
  io?.disconnect();
  io = null;
  tracked = card;
  if (!card) {
    setPinned(false);
    return;
  }
  const barH = fileBar()?.offsetHeight ?? 0;
  io = new IntersectionObserver(
    (entries) => {
      const e = entries.at(-1);
      if (!e?.rootBounds || !e.target.isConnected) return;
      setPinned(!e.isIntersecting && e.boundingClientRect.bottom <= e.rootBounds.top + 0.5);
    },
    { root: $("diff"), rootMargin: `-${barH}px 0px 0px 0px` },
  );
  io.observe(card);
}

// The bar changed height (a wrap at narrow widths, a font change): re-watch with the new margin.
export function retrackGuideCard() {
  if (tracked?.isConnected) trackGuideCard(tracked);
}
