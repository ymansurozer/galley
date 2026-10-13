import type { AppMode, BridgeMessage, Rect, UiMark } from "../types";
import { OVERLAY_ATTR } from "./capture";
import { describeElement, labelOf, targetOf } from "./describe";

// Annotate mode and the marks on the page. Everything the bridge draws (the hover outline and its
// label, the picked element's highlight, the numbered pins) lives in one host element with a closed
// shadow root, carrying OVERLAY_ATTR so screenshots leave it out. The app's own elements are only
// ever read, never written: no attributes, classes or styles.
//
// In Annotate mode a transparent veil in that root takes the pointer, so the app sees no hovers or
// clicks; hit-testing looks under the veil. The app gets no keys either, except the ones that
// scroll. ⌥A reaches the desk in both modes, and in Annotate mode so do Esc and the UI view's ⇧
// chords.

const STYLE = `
  :host { all: initial }
  * { box-sizing: border-box }
  #veil { position: fixed; inset: 0; display: none; pointer-events: auto; cursor: crosshair }
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
  .pick { border: 2px solid #00a8ff; background: rgba(0, 168, 255, .05) }
  .outline { border: 2px solid #e0af68 }
  .pin {
    position: fixed; pointer-events: none; transform: translate(-50%, -50%); min-width: 20px; height: 20px;
    padding: 0 5px; border-radius: 999px; display: grid; place-items: center; background: #e0af68; color: #050608;
    font: 700 11px/1 Geist, ui-sans-serif, system-ui, sans-serif; box-shadow: 0 0 0 2px #fff, 0 2px 8px rgba(0, 0, 0, .35);
    transition: transform .12s
  }
  .annotate .pin { pointer-events: auto; cursor: pointer }
  .annotate .pin:hover { transform: translate(-50%, -50%) scale(1.12) }
  .pin.sel { transform: translate(-50%, -50%) scale(1.2); box-shadow: 0 0 0 2px #fff, 0 0 0 5px rgba(0, 168, 255, .45), 0 2px 8px rgba(0, 0, 0, .35) }
  .pin.q { background: #00a8ff }
  .outline.q { border-color: #00a8ff }
  .pin.resolved { background: #e5e5e5; color: #737373 }
`;

// Keys that scroll the page: they still reach it in Annotate mode.
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
// The UI view's ⇧ chords passed up while annotating: sidebar, next / previous, Code / UI.
const FORWARDED_SHIFT = new Set(["L", "U", "ArrowDown", "ArrowUp"]);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

const query = (selector: string) => {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
};

export function installAnnotate(post: (msg: BridgeMessage) => void, token: string) {
  let mode: AppMode = "interact";
  let marks: UiMark[] = [];
  let selected: string | null = null;
  // The element the reviewer last picked, highlighted while the desk's composer is open on it.
  let picked: Element | null = null;
  let pressed: Element | null = null;
  let lastAnchor = "";

  // Created on first use, so a page that is never annotated never gets the host.
  let overlay: ReturnType<typeof buildOverlay> | null = null;
  const ui = () => (overlay ??= buildOverlay());

  function buildOverlay() {
    const host = document.createElement("galley-overlay");
    host.setAttribute(OVERLAY_ATTR, "");
    host.style.cssText =
      "all:initial;display:block;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${STYLE}</style><div id="layer"><div id="veil"></div><div id="marks"></div><div id="pick"></div><div class="box" id="hover"><span id="label"></span></div></div>`;
    document.documentElement.append(host);
    const part = (id: string) => root.getElementById(id) as HTMLElement;
    const parts = {
      host,
      layer: part("layer"),
      veil: part("veil"),
      marks: part("marks"),
      pick: part("pick"),
      hover: part("hover"),
      label: part("label"),
    };
    wire(parts);
    return parts;
  }

  // The app's element under a point, looking through the overlay.
  const under = (x: number, y: number) =>
    document.elementsFromPoint(x, y).find((el) => el !== overlay?.host) ?? null;

  const place = (node: HTMLElement, r: Rect) =>
    Object.assign(node.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });

  function hover(x: number, y: number) {
    const { hover: box, label } = ui();
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

  function pick(el: Element) {
    picked = el;
    lastAnchor = "";
    post({
      type: "picked",
      token,
      page: {
        route: location.pathname + location.search,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
      },
      target: { kind: "element", elements: [describeElement(el)] },
    });
    layout();
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
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"] as const)
      parts.layer.addEventListener(type, (e) => e.stopPropagation());
    let frame = 0;
    parts.veil.addEventListener("pointermove", (e) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => hover(e.clientX, e.clientY));
    });
    parts.veil.addEventListener("pointerleave", () => (ui().hover.style.display = "none"));
    parts.veil.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      window.focus();
      const hit = under(e.clientX, e.clientY);
      pressed = hit && targetOf(hit);
    });
    parts.veil.addEventListener("pointerup", (e) => {
      const el = pressed;
      pressed = null;
      if (el && e.button === 0) pick(el);
    });
    parts.veil.addEventListener("wheel", wheel, { passive: false });
    parts.marks.addEventListener("click", (e) => {
      const pin = e.target instanceof Element ? e.target.closest<HTMLElement>(".pin") : null;
      if (pin?.dataset.id) post({ type: "select", token, id: pin.dataset.id });
    });
  }

  const inView = (r: DOMRect) =>
    r.width + r.height > 0 &&
    r.bottom > 0 &&
    r.top < innerHeight &&
    r.right > 0 &&
    r.left < innerWidth;

  // Redraw the pins, the selected outline and the pick highlight where their elements are now.
  function layout() {
    if (!overlay) return;
    let html = "";
    for (const m of marks) {
      const el = query(m.selector);
      const r = el?.getBoundingClientRect();
      if (!r || !inView(r)) continue;
      const sel = m.id === selected;
      const q = m.question ? " q" : "";
      if (sel) html += box(r, `outline${q}`);
      const x = Math.max(11, Math.min(innerWidth - 11, r.left));
      const y = Math.max(11, r.top);
      html += `<div class="pin${q}${sel ? " sel" : ""}${m.resolved ? " resolved" : ""}" data-id="${escapeHtml(m.id)}" title="#${m.number}" style="left:${x}px;top:${y}px">${m.number}</div>`;
    }
    if (overlay.marks.innerHTML !== html) overlay.marks.innerHTML = html;
    const pr = picked?.isConnected ? picked.getBoundingClientRect() : null;
    const pickHtml = pr ? box(pr, "pick") : "";
    if (overlay.pick.innerHTML !== pickHtml) overlay.pick.innerHTML = pickHtml;
    if (pr) {
      const anchor = JSON.stringify([pr.x, pr.y, pr.width, pr.height].map(Math.round));
      if (anchor !== lastAnchor) {
        lastAnchor = anchor;
        post({
          type: "anchor",
          token,
          rect: { x: pr.x, y: pr.y, width: pr.width, height: pr.height },
        });
      }
    }
  }
  const box = (r: DOMRect, cls: string) =>
    `<div class="box ${cls}" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px"></div>`;

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
    if (marks.length || picked) layout();
  }, 500);

  // Keys, in the capture phase so they're settled before the app's own listeners run.
  const keyGuard = (e: KeyboardEvent) => {
    const chord = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyA";
    if (!chord && mode !== "annotate") return;
    if (!chord && SCROLL_KEYS.has(e.key) && !e.shiftKey && !e.altKey) return;
    e.stopImmediatePropagation();
    // ⌘/Ctrl combinations keep their browser meaning (copy, reload); only the app misses them.
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (e.type !== "keydown") return;
    // The desk accepts only these, and only in this form (appnav.ts); others aren't sent at all.
    const escape = e.key === "Escape" && !e.shiftKey && !e.altKey;
    const shiftChord = e.shiftKey && !e.altKey && FORWARDED_SHIFT.has(e.key);
    if (chord || escape || shiftChord)
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

  return {
    setMode(next: AppMode) {
      mode = next;
      if (next === "annotate" || overlay)
        ui().layer.classList.toggle("annotate", next === "annotate");
      if (next !== "annotate" && overlay) overlay.hover.style.display = "none";
    },
    setMarks(next: UiMark[], nextSelected: string | null, picking: boolean) {
      if (!picking) picked = null;
      if (nextSelected && nextSelected !== selected) {
        const el = query(next.find((m) => m.id === nextSelected)?.selector ?? "");
        const r = el?.getBoundingClientRect();
        if (el && r && (r.top < 0 || r.bottom > innerHeight))
          el.scrollIntoView({ block: "center" });
      }
      marks = next;
      selected = nextSelected;
      if (marks.length || picked || overlay) ui();
      layout();
    },
  };
}
