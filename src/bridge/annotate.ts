import type { AppMode, BridgeMessage, PickedTarget, PinRect, Rect, UiMark } from "../types";
import { OVERLAY_ATTR } from "./capture";
import { PIN, pinCorner, unionRect } from "./crop";
import { CAPS, describeElement, labelOf, targetOf } from "./describe";
import { marksPlacer } from "./placement";
import { located } from "./refind";
import { quoteFinder, regionElements, textRects, textTarget, togglePick } from "./targets";

// Annotate mode and the marks on the page. Everything the bridge draws (the hover outline and its
// label, the pick being composed on, ⇧-picks waiting for ⇧'s release, the drag in progress, and
// the annotations' marks and numbered pins) lives in one host element with a closed shadow root,
// carrying OVERLAY_ATTR so screenshots leave it out. The app's own elements are only ever read,
// never written: no attributes, classes or styles, and not its selection either. A mark is drawn
// once its target is found again on the page (placement.ts), and not while it's looked for or when
// it isn't there.
//
// In Annotate mode a transparent veil in that root takes the pointer, so the app sees no hovers or
// clicks; hit-testing looks under the veil. A click picks an element, ⇧-clicks gather up to 16 for
// one pick when ⇧ is released, a drag that starts on text picks the text it runs over, and any
// other drag (or one with ⌥ held) picks a box. The app gets no keys either, except the ones that
// scroll. ⌥A reaches the desk in both modes, and in Annotate mode so do ⌥P, Esc and the UI view's ⇧
// chords.

const STYLE = `
  :host { all: initial }
  * { box-sizing: border-box }
  #veil { position: fixed; inset: 0; display: none; pointer-events: auto; cursor: crosshair }
  #veil.text { cursor: text }
  .annotate #veil { display: block }
  .box { position: fixed; pointer-events: none; border-radius: 3px }
  #hover { display: none; border: 1.5px solid #00a8ff; background: rgba(0, 168, 255, .07) }
  #label {
    position: absolute; left: -1.5px; bottom: calc(100% + 5px); max-width: 380px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; padding: 4px 7px; border-radius: 4px;
    background: #101415; border: 1px solid #354146; color: #d9d9d4;
    font: 500 11px/1.25 Geist, ui-sans-serif, system-ui, sans-serif; box-shadow: 0 6px 18px rgba(0, 0, 0, .28)
  }
  #label b { color: #8fc4d4; font-weight: 600 }
  #hover.below #label { bottom: auto; top: calc(100% + 5px) }
  #hover.end #label { left: auto; right: -1.5px }
  #drag { display: none; border: 1.5px dashed #00a8ff; background: rgba(0, 168, 255, .08); border-radius: 2px }
  .pick { border: 2px solid #00a8ff; background: rgba(0, 168, 255, .05) }
  .pick.pending { border-width: 1.5px; background: rgba(0, 168, 255, .1) }
  .pick i {
    position: absolute; top: -9px; right: -9px; min-width: 17px; height: 17px; padding: 0 4px;
    border-radius: 999px; background: #00a8ff; color: #050608; text-align: center; font-style: normal;
    font: 700 10px/17px Geist, ui-sans-serif, system-ui, sans-serif
  }
  .outline { border: 2px solid #e0af68 }
  .region { border: 1.5px dashed #e0af68; background: rgba(224, 175, 104, .09); border-radius: 2px }
  .hl { background: rgba(224, 175, 104, .34); border-radius: 2px }
  .region.resolved, .hl.resolved { opacity: .35 }
  .pin {
    position: fixed; pointer-events: auto; cursor: pointer; transform: translate(-2px, calc(-100% - 2px));
    display: inline-flex; align-items: center; gap: 4px; height: 24px; min-width: 30px; padding: 0 8px;
    border-radius: ${PIN.radii.map((r) => `${r}px`).join(" ")}; background: ${PIN.change.color}; color: #fff;
    font: 700 12px/1 Geist, ui-sans-serif, system-ui, sans-serif; box-shadow: 0 2px 5px rgba(0, 0, 0, .25);
    transition: background .2s ease-out
  }
  .pin svg { width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round }
  .pin:hover { background: #8f4400; transition-duration: 0s }
  .pin.q { background: ${PIN.question.color} }
  .pin.q:hover { background: #0b5bc0 }
  .pin.sel, .pin.sel:hover { background: #1c1c1e }
  .pin.waiting::after {
    content: ""; position: absolute; inset: -5px; border-radius: inherit; border: 2px solid #0a72e8; opacity: 0;
    animation: ping 1.6s ease-out infinite; pointer-events: none
  }
  @keyframes ping { 0% { opacity: .55; transform: scale(.85) } 100% { opacity: 0; transform: scale(1.35) } }
  @media (prefers-reduced-motion: reduce) { .pin.waiting::after { animation: none } }
  .outline.q { border-color: #00a8ff }
  .region.q, .region.picked { border-color: #00a8ff; background: rgba(0, 168, 255, .09) }
  .hl.q, .hl.picked { background: rgba(0, 168, 255, .3) }
  .pin.resolved { filter: grayscale(1); opacity: .55 }
  .pin.draft { background: #00a8ff; pointer-events: none }
  #chip {
    position: fixed; left: 50%; bottom: 56px; transform: translateX(-50%); display: none; padding: 7px 12px;
    border-radius: 999px; background: #101415; border: 1px solid #354146; color: #d9d9d4; white-space: nowrap;
    font: 12px/1.3 Geist, ui-sans-serif, system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0, 0, 0, .3)
  }
  #chip b { color: #fafafa }
  #chip kbd {
    font: 10px/1 ui-sans-serif, system-ui, sans-serif; padding: 2px 5px; border: 1px solid #354146;
    border-radius: 3px; background: #0b0e0f; color: #8a9396
  }
`;

// The pins' glyphs: a change request's flag, a question's message.
const glyph = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const FLAG = glyph(PIN.change.glyph);
const MESSAGE = glyph(PIN.question.glyph);

// Keys that scroll the page: they still reach it in Annotate mode.
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
// The UI view's ⇧ chords passed up while annotating: next / previous annotation, Code / App.
const FORWARDED_SHIFT = new Set(["U", "ArrowDown", "ArrowUp"]);
// How far the pointer moves before a press becomes a drag, and the smallest box a drag picks.
const DRAG_START = 5;
const MIN_REGION = 8;
// Text a drag doesn't select from: a native control's label. A drag that starts there draws a box.
// An element that only carries a button or link role (a clickable table row or card) keeps its
// text quotable.
const LABELLED = "button, a[href], summary, [role=tab], [role=menuitem], [role=option]";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};
const rounded = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  width: Math.round(r.width),
  height: Math.round(r.height),
});

type Caret = { node: Node; offset: number };
// What the reviewer picked, kept live so its highlight follows the page while the desk's composer is
// open on it: the elements, the box (moving with its first element), or the selected text.
type Pick =
  | { kind: "element"; els: Element[] }
  | { kind: "region"; rect: Rect; anchor: { el: Element; rect: Rect } | null }
  | { kind: "text"; range: Range };
// A press in progress: where it started, the element a click there picks, the text caret a drag
// from there selects from (none off text, or with ⌥), and the text it has run over so far.
type Gesture = {
  x: number;
  y: number;
  el: Element | null;
  from: Caret | null;
  range: Range | null;
  moved: boolean;
};

export function installAnnotate(post: (msg: BridgeMessage) => void, token: string) {
  let mode: AppMode = "interact";
  let marks: UiMark[] = [];
  let selected: string | null = null;
  let picked: Pick | null = null;
  let pending: Element[] = [];
  let sentPending = 0;
  let gesture: Gesture | null = null;
  let lastAnchor = "";
  // The selected mark, until it's found and scrolled into view (or found missing).
  let revealing: string | null = null;
  // The number the pick the composer is open on will get, for its draft pin; null without one.
  let draftNumber: number | null = null;
  // The pins as last drawn, as last posted, and the frame a post waits for.
  let pins: PinRect[] = [];
  let sentPins = "";
  let pinsFrame = 0;

  // Created on first use, so a page that is never annotated never gets the host.
  let overlay: ReturnType<typeof buildOverlay> | null = null;
  // What layout last wrote into the marks and the pick layers. Compared as written, not against
  // innerHTML: the browser serializes a pin's <path/> glyph back as <path></path>, so that check never
  // matched and every pass rebuilt the pins, the hovered one under the pointer.
  let marksHtml = "";
  let pickHtml = "";
  const ui = () => (overlay ??= buildOverlay());

  const placer = marksPlacer(
    document,
    {
      now: () => performance.now(),
      after: (ms, fn) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    },
    (placements) => post({ type: "placements", token, placements }),
    () => {
      reveal();
      layout();
    },
  );
  new MutationObserver(() => placer.changed()).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  // Resource timing reports each script, stylesheet and fetch the page finishes loading.
  try {
    new PerformanceObserver(() => placer.fetched()).observe({ type: "resource" });
  } catch {
    // No resource timing here: the page counts as idle once its DOM stops changing.
  }
  if (document.readyState === "loading")
    addEventListener("DOMContentLoaded", () => placer.ready(), { once: true });
  else placer.ready();

  // Scroll the selected mark's target into view once it's found, when it's off screen.
  function reveal() {
    const id = revealing;
    if (!id || placer.placement(id) === "pending") return;
    revealing = null;
    const mark = marks.find((m) => m.id === id);
    const at = mark && locateMark(mark);
    const r = at?.boxes[0];
    if (at?.anchor && r && (r.y < 0 || r.y + r.height > innerHeight))
      at.anchor.scrollIntoView({ block: "center" });
  }

  function buildOverlay() {
    const host = document.createElement("galley-overlay");
    host.setAttribute(OVERLAY_ATTR, "");
    host.style.cssText =
      "all:initial;display:block;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${STYLE}</style><div id="layer"><div id="veil"></div><div id="marks"></div><div id="pick"></div><div class="box" id="drag"></div><div class="box" id="hover"><span id="label"></span></div><div id="chip"></div></div>`;
    document.documentElement.append(host);
    const part = (id: string) => root.getElementById(id) as HTMLElement;
    const parts = {
      host,
      layer: part("layer"),
      veil: part("veil"),
      marks: part("marks"),
      pick: part("pick"),
      drag: part("drag"),
      hover: part("hover"),
      label: part("label"),
      chip: part("chip"),
    };
    wire(parts);
    return parts;
  }

  // The app's element under a point, looking through the overlay.
  const under = (x: number, y: number) =>
    document.elementsFromPoint(x, y).find((el) => el !== overlay?.host) ?? null;

  // The text position under a point, looking through the overlay: hidden for the hit test, which
  // has nothing to paint in between.
  function caretAt(x: number, y: number): Caret | null {
    const host = overlay?.host;
    if (host) host.style.visibility = "hidden";
    try {
      if (typeof document.caretPositionFromPoint === "function") {
        const p = document.caretPositionFromPoint(x, y);
        return p && { node: p.offsetNode, offset: p.offset };
      }
      const r = document.caretRangeFromPoint(x, y);
      return r && { node: r.startContainer, offset: r.startOffset };
    } finally {
      if (host) host.style.visibility = "";
    }
  }

  // The caret a drag from this point selects from: on a text's own glyphs (the caret lands on the
  // nearest text even beside it), and not on a control's label.
  function textAt(x: number, y: number): Caret | null {
    const caret = caretAt(x, y);
    const node = caret?.node;
    if (!caret || !node || node.nodeType !== 3 || !/\S/.test(node.textContent ?? "")) return null;
    if (node.parentElement?.closest(LABELLED)) return null;
    const glyphs = document.createRange();
    glyphs.selectNodeContents(node);
    const on = [...glyphs.getClientRects()].some(
      (b) => x >= b.left - 1 && x <= b.right + 1 && y >= b.top && y <= b.bottom,
    );
    return on ? caret : null;
  }

  // The text between two carets, whichever comes first.
  function between(a: Caret, b: Caret): Range {
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    if (range.comparePoint(b.node, b.offset) < 0) range.setStart(b.node, b.offset);
    else range.setEnd(b.node, b.offset);
    return range;
  }

  const boxFrom = (g: Gesture, x: number, y: number): Rect => ({
    x: Math.min(g.x, x),
    y: Math.min(g.y, y),
    width: Math.abs(x - g.x),
    height: Math.abs(y - g.y),
  });

  const place = (node: HTMLElement, r: Rect) =>
    Object.assign(node.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });

  function hover(x: number, y: number, alt: boolean) {
    const { hover: box, label, veil } = ui();
    veil.classList.toggle("text", !alt && !!textAt(x, y));
    const hit = under(x, y);
    const target = hit && targetOf(hit);
    if (!target) {
      box.style.display = "none";
      return;
    }
    const r = target.getBoundingClientRect();
    place(box, r);
    box.style.display = "block";
    box.classList.toggle("below", r.top < 26);
    const { role, name } = labelOf(target);
    label.innerHTML = `<b>${escapeHtml(role)}</b>${name ? ` · "${escapeHtml(name)}"` : ""}`;
    box.classList.toggle("end", r.left + label.offsetWidth > innerWidth - 4);
  }

  // Tell the desk about a pick, and keep it highlighted while the desk's composer is open on it.
  function pick(p: Pick, target: PickedTarget) {
    picked = p;
    lastAnchor = "";
    post({
      type: "picked",
      token,
      page: {
        route: location.pathname + location.search,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
      },
      target,
    });
    layout();
  }

  function pickElements(els: Element[]) {
    pick({ kind: "element", els }, { kind: "element", elements: els.map(describeElement) });
  }

  // A dragged box: the meaningful elements under it, the first of which it moves with.
  function pickRegion(rect: Rect) {
    const els = regionElements(document, rect, under);
    const first = els[0];
    pick(
      { kind: "region", rect, anchor: first ? { el: first, rect: rectOf(first) } : null },
      { kind: "region", rect: rounded(rect), elements: els.map(describeElement) },
    );
  }

  function pickText(range: Range) {
    const target = textTarget(range);
    if (target) pick({ kind: "text", range }, target);
    else layout();
  }

  // Tell the desk how many ⇧-picks are waiting (the Esc cascade has a level for them).
  function pendingChanged() {
    if (pending.length !== sentPending) {
      sentPending = pending.length;
      post({ type: "pending", token, count: sentPending });
    }
    layout();
  }

  // ⇧ released: the ⇧-picked elements become one pick.
  function commitPending() {
    const els = pending.filter((el) => el.isConnected);
    pending = [];
    pendingChanged();
    if (els.length) pickElements(els);
  }

  function click(el: Element, shift: boolean) {
    if (shift) {
      // ⇧-clicking while the composer is open on picked elements adds to them. ⇧-clicking its only
      // element does nothing: taking it out would leave nothing to annotate.
      if (!pending.length && picked?.kind === "element") {
        const els = picked.els.filter((p) => p.isConnected);
        if (els.length === 1 && els[0] === el) return;
        pending = els;
      }
      togglePick(pending, el);
      pendingChanged();
      return;
    }
    // A plain click with ⇧-picks waiting adds itself (if there's room) and picks them all.
    if (pending.length) {
      if (!pending.includes(el)) togglePick(pending, el);
      commitPending();
      return;
    }
    pickElements([el]);
  }

  function drag(x: number, y: number) {
    const g = gesture;
    if (!g || (!g.moved && Math.hypot(x - g.x, y - g.y) < DRAG_START)) return;
    g.moved = true;
    const { hover: hoverBox, drag: dragBox } = ui();
    hoverBox.style.display = "none";
    if (g.from) {
      const to = caretAt(x, y);
      if (to) g.range = between(g.from, to);
      layout();
      return;
    }
    place(dragBox, boxFrom(g, x, y));
    dragBox.style.display = "block";
  }

  function endGesture() {
    gesture = null;
    if (overlay) overlay.drag.style.display = "none";
  }

  // An inner scroller under the pointer (a table in a scrolled panel) gets the wheel the veil took;
  // the page itself scrolls on its own, since the veil is fixed to the viewport.
  function wheel(e: WheelEvent) {
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * scale;
    const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * scale;
    for (let n = under(e.clientX, e.clientY); n; n = n.parentElement) {
      if (n === document.body || n === document.documentElement) return;
      const style = getComputedStyle(n);
      const scrolls = (overflow: string) => /auto|scroll|overlay/.test(overflow);
      const canX =
        dx !== 0 &&
        scrolls(style.overflowX) &&
        (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0);
      const canY =
        dy !== 0 &&
        scrolls(style.overflowY) &&
        (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0);
      if (canX || canY) {
        e.preventDefault();
        n.scrollBy(canX ? dx : 0, canY ? dy : 0);
        return;
      }
    }
  }

  function wire(parts: { layer: HTMLElement; veil: HTMLElement; marks: HTMLElement }) {
    // A press on the veil or a pin would otherwise bubble out of the shadow root to the app's
    // document listeners (as a press on the host), and a dialog that closes on a press outside
    // it would close under the reviewer's pick. The bridge's own listeners sit below the layer.
    for (const type of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "touchstart",
      "touchend",
    ] as const)
      parts.layer.addEventListener(type, (e) => e.stopPropagation());
    let frame = 0;
    parts.veil.addEventListener("pointermove", (e) => {
      cancelAnimationFrame(frame);
      const { clientX: x, clientY: y, altKey } = e;
      frame = requestAnimationFrame(() => (gesture ? drag(x, y) : hover(x, y, altKey)));
    });
    parts.veil.addEventListener("pointerleave", () => {
      if (!gesture) ui().hover.style.display = "none";
    });
    parts.veil.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Picking is a press on the page too: the selected pin's card gives way.
      if (selected) postPins(null);
      window.focus();
      const hit = under(e.clientX, e.clientY);
      gesture = {
        x: e.clientX,
        y: e.clientY,
        el: hit && targetOf(hit),
        from: e.altKey ? null : textAt(e.clientX, e.clientY),
        range: null,
        moved: false,
      };
      // The drag keeps reporting when the pointer leaves the frame.
      parts.veil.setPointerCapture(e.pointerId);
    });
    parts.veil.addEventListener("pointerup", (e) => {
      cancelAnimationFrame(frame);
      const g = gesture;
      endGesture();
      if (!g || e.button !== 0) return;
      if (!g.moved) {
        if (g.el) click(g.el, e.shiftKey);
        return;
      }
      if (g.from) {
        const to = caretAt(e.clientX, e.clientY);
        const range = to ? between(g.from, to) : g.range;
        if (range && !range.collapsed) pickText(range);
        else layout();
        return;
      }
      const box = boxFrom(g, e.clientX, e.clientY);
      if (box.width >= MIN_REGION && box.height >= MIN_REGION) pickRegion(box);
    });
    parts.veil.addEventListener("pointercancel", () => {
      endGesture();
      layout();
    });
    parts.veil.addEventListener("wheel", wheel, { passive: false });
    // A pin takes its press in either mode (the layer keeps it from the app): no focus or selection
    // moves under it, and its click opens or closes its card in the desk.
    parts.marks.addEventListener("pointerdown", (e) => e.preventDefault());
    parts.marks.addEventListener("click", (e) => {
      const pin = e.target instanceof Element ? e.target.closest<HTMLElement>(".pin") : null;
      if (pin?.dataset.id) postPins(pin.dataset.id);
    });
  }

  // The pins as drawn, for the desk to anchor the open pin's card to. Posted at most once a frame,
  // and only when one moved, appeared or went, or with a click.
  function pinsKey() {
    const round = (r: Rect) => [r.x, r.y, r.width, r.height].map(Math.round);
    return JSON.stringify(pins.map((p) => [p.id, ...round(p.rect)]));
  }
  function postPins(clicked?: string | null) {
    sentPins = pinsKey();
    post({ type: "pins", token, pins, ...(clicked !== undefined && { clicked }) });
  }
  function pinsMoved() {
    if (pinsFrame || pinsKey() === sentPins) return;
    pinsFrame = requestAnimationFrame(() => {
      pinsFrame = 0;
      if (pinsKey() !== sentPins) postPins();
    });
  }
  // A primary press on the page off the pins closes the selected pin's card. A press inside the
  // overlay (a pin, or the veil while annotating) is the overlay's own, and one on the root element
  // is on the page's scrollbar.
  addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target;
      if (selected && e.button === 0 && t !== overlay?.host && t !== document.documentElement)
        postPins(null);
    },
    true,
  );

  const inView = (r: Rect) =>
    r.width + r.height > 0 &&
    r.y + r.height > 0 &&
    r.y < innerHeight &&
    r.x + r.width > 0 &&
    r.x < innerWidth;

  const box = (r: Rect, cls: string, inner = "") =>
    `<div class="box ${cls}" style="left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px">${inner}</div>`;

  // A numbered pin on a target's top-left corner: a speech bubble whose tail (its tight bottom-left
  // corner) sits on the corner, kept on screen. A kind's glyph leads the number.
  const pinAt = (r: Rect, number: number, cls: string, icon = "", id?: string) => {
    const { x, y } = pinCorner(r, innerWidth);
    const data = id ? ` data-id="${escapeHtml(id)}"` : "";
    return `<div class="${cls}"${data} title="#${number}" style="left:${x}px;top:${y}px">${icon}${number}</div>`;
  };

  // Where the pick is now: its elements, its box (moved with its first element), or its text.
  function pickBoxes(p: Pick): Rect[] {
    if (p.kind === "element") return p.els.filter((el) => el.isConnected).map(rectOf);
    if (p.kind === "text") return p.range.startContainer.isConnected ? textRects(p.range) : [];
    const a = p.anchor;
    if (!a?.el.isConnected) return [p.rect];
    const now = rectOf(a.el);
    return [{ ...p.rect, x: p.rect.x + now.x - a.rect.x, y: p.rect.y + now.y - a.rect.y }];
  }

  // A mark's target where it is now, if it was found. Its quote, for a text mark, is searched for
  // once and reused while it stands: layout runs on every scroll frame.
  const quotes = quoteFinder();
  const locateMark = (m: UiMark) => {
    const found = placer.found(m.id);
    return found && located(found, (holder, quote) => quotes.find(m.id, holder, quote));
  };

  // Redraw the marks, the pick and the ⇧-picks where their targets are now, and tell the desk where
  // the pick went, so its composer follows.
  function layout() {
    if (!overlay) return;
    let html = "";
    for (const m of marks) {
      const at = locateMark(m);
      if (!at || !inView(at.boxes[0])) continue;
      const sel = m.id === selected;
      const q = m.question ? " q" : "";
      const tone = `${q}${m.resolved ? " resolved" : ""}`;
      if (m.target.kind === "region") html += box(at.boxes[0], `region${tone}`);
      else if (m.target.kind === "text") for (const r of at.boxes) html += box(r, `hl${tone}`);
      else if (sel) for (const r of at.boxes) html += box(r, `outline${q}`);
      const cls = `pin${q}${sel ? " sel" : ""}${m.resolved ? " resolved" : ""}${m.waiting ? " waiting" : ""}`;
      html += pinAt(at.boxes[0], m.number, cls, m.question ? MESSAGE : FLAG, m.id);
    }
    if (html !== marksHtml) overlay.marks.innerHTML = marksHtml = html;
    pins = [...overlay.marks.querySelectorAll<HTMLElement>(".pin")].map((el) => ({
      id: el.dataset.id ?? "",
      rect: rectOf(el),
    }));
    pinsMoved();

    const boxes = picked ? pickBoxes(picked) : [];
    let nextPick = "";
    if (picked?.kind === "element")
      boxes.forEach(
        (r, i) => (nextPick += box(r, "pick", boxes.length > 1 ? `<i>${i + 1}</i>` : "")),
      );
    else if (picked?.kind === "region")
      nextPick += boxes.map((r) => box(r, "region picked")).join("");
    else if (picked?.kind === "text") nextPick += boxes.map((r) => box(r, "hl picked")).join("");
    // The pick's new pin, numbered as the annotation will be, where its mark's pin will sit.
    if (boxes[0] && draftNumber !== null) nextPick += pinAt(boxes[0], draftNumber, "pin draft");
    pending.forEach((el, i) => {
      if (el.isConnected) nextPick += box(rectOf(el), "pick pending", `<i>${i + 1}</i>`);
    });
    if (gesture?.range)
      nextPick += textRects(gesture.range)
        .map((r) => box(r, "hl picked"))
        .join("");
    if (nextPick !== pickHtml) overlay.pick.innerHTML = pickHtml = nextPick;

    const n = pending.length;
    const chip = n
      ? `<b>${n}</b> element${n === 1 ? "" : "s"}${n >= CAPS.elements ? " (max)" : ""} · release <kbd>⇧</kbd> to annotate · <kbd>Esc</kbd> clears`
      : "";
    if (overlay.chip.innerHTML !== chip) overlay.chip.innerHTML = chip;
    overlay.chip.style.display = chip ? "block" : "none";

    // The composer sits on the draft pin when there is one, else beside the whole pick.
    const [first, ...rest] = boxes;
    if (first) {
      const draftPin = overlay.pick.querySelector(".pin");
      const at = draftPin ? rectOf(draftPin) : unionRect([first, ...rest]);
      const anchor = JSON.stringify([at.x, at.y, at.width, at.height].map(Math.round));
      if (anchor !== lastAnchor) {
        lastAnchor = anchor;
        post({ type: "anchor", token, rect: at });
      }
    }
  }

  let queued = 0;
  const relayout = () => {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      layout();
    });
  };
  addEventListener("scroll", relayout, { capture: true, passive: true });
  addEventListener("resize", relayout);
  // Layout moves without scrolling too (data loading, an accordion opening): follow it.
  setInterval(() => {
    if (marks.length || picked || pending.length) layout();
  }, 500);

  // Keys, in the capture phase so they're settled before the app's own listeners run.
  const keyGuard = (e: KeyboardEvent) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.shiftKey;
    const altA = e.altKey && plain && e.code === "KeyA";
    if (!altA && mode !== "annotate") return;
    if (e.type === "keyup" && e.key === "Shift" && pending.length) commitPending();
    // Esc while ⇧-picks wait drops them here. ⇧ is still down (releasing it would pick them), and
    // the desk takes no ⇧Esc from the page.
    if (e.key === "Escape" && pending.length) {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.type === "keydown") {
        pending = [];
        pendingChanged();
      }
      return;
    }
    if (!altA && SCROLL_KEYS.has(e.key) && !e.shiftKey && !e.altKey) return;
    e.stopImmediatePropagation();
    // ⌘/Ctrl combinations keep their browser meaning (copy, reload); only the app misses them.
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (e.type !== "keydown") return;
    // The desk accepts only these, and only in this form (appnav.ts); others aren't sent at all.
    // ⌥P and ⌥A by their code: on a Mac layout ⌥ turns their keys into other characters.
    const altP = e.altKey && plain && e.code === "KeyP";
    const escape = e.key === "Escape" && !e.shiftKey && !e.altKey;
    const shiftChord = e.shiftKey && !e.altKey && FORWARDED_SHIFT.has(e.key);
    if (altA || altP || escape || shiftChord)
      post({
        type: "key",
        token,
        key: e.key,
        code: e.code,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      });
  };
  for (const type of ["keydown", "keyup", "keypress"] as const)
    addEventListener(type, keyGuard, true);
  // ⇧ released while the page doesn't have focus (a click in the desk, another window) sends the
  // page no keyup: losing focus picks the ⇧-picks as their release would.
  addEventListener("blur", () => {
    if (pending.length) commitPending();
  });

  return {
    setMode(next: AppMode) {
      mode = next;
      if (next === "annotate" || overlay)
        ui().layer.classList.toggle("annotate", next === "annotate");
      if (next === "annotate") return;
      endGesture();
      pending = [];
      if (overlay) overlay.hover.style.display = "none";
      pendingChanged();
    },
    setMarks(next: UiMark[], nextSelected: string | null, picking: number | null) {
      if (picking === null) picked = null;
      draftNumber = picking;
      quotes.keep(new Set(next.map((m) => m.id)));
      placer.set(next);
      if (nextSelected !== selected) revealing = nextSelected;
      marks = next;
      selected = nextSelected;
      if (marks.length || picked || overlay) ui();
      reveal();
      layout();
    },
    // The route changed in-page.
    navigated() {
      placer.navigated();
    },
    relook() {
      placer.relook();
    },
    clearPicks() {
      pending = [];
      pendingChanged();
    },
  };
}
