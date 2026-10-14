import { keycapsNode } from "./keycaps";

// Fast custom tooltips (the native title waits ~1.5s). An element opts in with data-tip, its
// label, and data-tip-keys, its shortcut (drawn as keycaps). One floating element serves every
// tip, shown after a short delay: below its element (end-aligned with data-tip-align="end"),
// above it when there's no room below, and beside an element too tall for either (the annotation
// rail). A tip with no shortcut that would only repeat the element's visible text stays hidden —
// which is how a narrow thread's glyph-only "Turn into…" button gets its tip and the labelled
// one doesn't. A re-render can replace the target under a resting pointer (the poll rebuilds the
// diff header), so a showing tip checks that its target is still on the page.
const DELAY_MS = 180;
const WATCH_MS = 250;
const GAP = 6;
const EDGE = 6;

export function installTooltips() {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  let target: HTMLElement | null = null;
  let timer = 0;
  let watch = 0;

  const hide = () => {
    clearTimeout(timer);
    clearInterval(watch);
    target = null;
    tip.classList.remove("show");
  };

  const show = (el: HTMLElement) => {
    const label = el.dataset.tip ?? "";
    const keys = el.dataset.tipKeys;
    if (!el.isConnected || (!keys && el.innerText.trim() === label)) return;
    const text = document.createElement("span");
    text.textContent = label;
    tip.replaceChildren(text, ...(keys ? [keycapsNode(document, keys)] : []));
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let top = r.bottom + GAP;
    let left = el.dataset.tipAlign === "end" ? r.right - w : r.left + (r.width - w) / 2;
    if (top + h > innerHeight - EDGE) top = r.top - GAP - h;
    if (top < EDGE) {
      top = r.top + GAP;
      left = r.left - GAP - w;
    }
    tip.style.left = `${Math.max(EDGE, Math.min(left, innerWidth - w - EDGE))}px`;
    tip.style.top = `${top}px`;
    tip.classList.add("show");
    watch = window.setInterval(() => {
      if (!el.isConnected) hide();
    }, WATCH_MS);
  };

  document.addEventListener("pointerover", (e) => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-tip]") : null;
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    timer = window.setTimeout(() => show(el), DELAY_MS);
  });
  document.documentElement.addEventListener("pointerleave", hide);
  for (const type of ["pointerdown", "keydown", "scroll"]) addEventListener(type, hide, true);
}
