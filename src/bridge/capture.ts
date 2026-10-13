import { domToCanvas } from "modern-screenshot";
import type { BridgeShot, Rect } from "../types";
import { atRenderScroll, cropFrame, markShape } from "./crop";

// Marks the bridge's own overlay host (outline, markers, labels). A capture never includes it: an
// annotation's mark is drawn onto the image, not rendered from the page.
export const OVERLAY_ATTR = "data-galley-overlay";

// An image or font still loading after this long renders blank rather than stall the capture.
const ASSET_TIMEOUT = 10_000;

// Screenshots by re-rendering the live DOM (modern-screenshot clones the page with its computed
// styles, input values and embedded fonts/images into an SVG and draws that), not by reading the
// screen's pixels: tab capture needs a secure origin, which the devbox desk isn't. One render makes
// the viewport image, and the crop is cut from it so both show the same instant. With `mark`, the
// annotation's mark is drawn around the target before the crop is cut, so both images carry it.
export async function capturePage(
  target: Element | Rect | null,
  mark?: { number: number; question: boolean },
): Promise<BridgeShot> {
  const start = performance.now();
  const dpr = window.devicePixelRatio || 1;
  const root = document.documentElement;
  // The layout viewport (scrollbars excluded), the frame element rects are measured in.
  const view = { width: root.clientWidth, height: root.clientHeight };
  const scroll = { x: scrollX, y: scrollY };
  // The crop's box. A target element is measured again when the renderer reaches it, the moment
  // its clone samples it, so one that moves during a long render is cut where the image shows it.
  // Measuring after the render would be later than what the image shows.
  let box = target instanceof Element ? target.getBoundingClientRect() : target;
  const fields = formFields();
  const canvas = await domToCanvas(root, {
    ...view,
    scale: dpr,
    timeout: ASSET_TIMEOUT,
    filter: (node) => {
      if (node instanceof Element && node.hasAttribute(OVERLAY_ATTR)) return false;
      if (target instanceof Element && node === target)
        box = atRenderScroll(target.getBoundingClientRect(), { x: scrollX, y: scrollY }, scroll);
      fields.seen(node);
      return true;
    },
    onCloneEachNode: (clone) => fields.cloned(clone),
    // Scrolled containers render at their scroll offset, by translating their children. A sticky
    // element inside one therefore moves with the content instead of staying stuck. The document's
    // own scroll is redone in onCloneNode, since a transform on <body> would drag fixed layers
    // (modals, toasts) along with the content.
    features: { restoreScrollPosition: true },
    onCloneNode: (clone) => {
      unscrollBody(clone, scroll.x, scroll.y);
      fields.finish(clone);
    },
  });
  const frame = box && cropFrame(box, view, dpr);
  if (mark && frame && box) drawMark(canvas, markShape(box, view), dpr, mark);
  const [viewport, crop] = await Promise.all([
    toPng(canvas),
    frame ? toPng(cut(canvas, frame)) : null,
  ]);
  return { viewport, crop, ms: Math.round(performance.now() - start) };
}

// The document's scroll offset, re-applied to the cloned <body> as a relative offset instead of a
// transform: in-flow and absolutely positioned content moves up with it, while fixed layers stay
// put in the viewport and sticky ones stay stuck, as they do on screen.
function unscrollBody(clone: Node, dx: number, dy: number) {
  if (!dx && !dy) return;
  const body = clone instanceof Element ? clone.querySelector(":scope > body") : null;
  if (!(body instanceof HTMLElement)) return;
  const live = getComputedStyle(document.body);
  body.style.transform = live.transform;
  if (live.position === "static") body.style.position = "relative";
  body.style.left = `${(parseFloat(live.left) || 0) - dx}px`;
  body.style.top = `${(parseFloat(live.top) || 0) - dy}px`;
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const isField = (node: unknown): node is Field =>
  node instanceof HTMLInputElement ||
  node instanceof HTMLTextAreaElement ||
  node instanceof HTMLSelectElement;

// Form state the clone loses. modern-screenshot copies an input's value, but not a textarea's (its
// typed text isn't its content), a checkbox's checked state, a select's chosen options, or the
// page's ::placeholder style, so an empty field would show its placeholder in the browser's default
// colour, which reads like typed text. The library has no hook that sees a node and its clone
// together, but it calls `filter` on each node just before cloning it and `onCloneEachNode` on the
// clone once its subtree is done. Fields never contain fields, so a queue pairs them up; a pair
// whose tags disagree is left alone.
function formFields() {
  const queue: Field[] = [];
  const rules: string[] = [];
  return {
    seen(node: Node) {
      if (isField(node)) queue.push(node);
    },
    cloned(clone: Node) {
      if (!isField(clone)) return;
      const live = queue.shift();
      if (live?.tagName !== clone.tagName) return;
      if (live instanceof HTMLTextAreaElement) clone.textContent = live.value;
      if (live instanceof HTMLInputElement && (live.type === "checkbox" || live.type === "radio"))
        clone.toggleAttribute("checked", live.checked);
      if (live instanceof HTMLSelectElement && clone instanceof HTMLSelectElement)
        for (const [i, option] of [...clone.options].entries())
          option.toggleAttribute("selected", live.options[i]?.selected ?? false);
      if (!(live instanceof HTMLSelectElement) && live.placeholder && !live.value) {
        const ph = getComputedStyle(live, "::placeholder");
        const cls = `galley-ph-${rules.length}`;
        clone.classList.add(cls);
        // The clone's inline -webkit-text-fill-color is the field's resolved text colour, and the
        // placeholder inherits it, so it needs overriding along with color.
        const fill = ph.getPropertyValue("-webkit-text-fill-color");
        rules.push(
          `.${cls}::placeholder{color:${ph.color};-webkit-text-fill-color:${fill};opacity:${ph.opacity}}`,
        );
      }
    },
    // The placeholder rules ride in a <style> inside the cloned root.
    finish(root: Node) {
      if (!rules.length || !(root instanceof Element)) return;
      const style = document.createElement("style");
      style.textContent = rules.join("\n");
      root.append(style);
    },
  };
}

// The annotation's mark as the page's selected pin looks (annotate.ts): an outline around the
// target, and the numbered pin in a white ring with a soft shadow, amber for a change request and
// cyan for a question.
const MARK = { change: "#e0af68", question: "#00a8ff" };

function drawMark(
  canvas: HTMLCanvasElement,
  { outline, pin }: ReturnType<typeof markShape>,
  dpr: number,
  { number, question }: { number: number; question: boolean },
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas context for the mark");
  const color = question ? MARK.question : MARK.change;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(outline.x, outline.y, outline.width, outline.height, 4);
  ctx.stroke();
  const label = String(number);
  ctx.font = "700 11px Geist, ui-sans-serif, system-ui, sans-serif";
  const width = Math.max(20, ctx.measureText(label).width + 10);
  const pill = (grow: number) => {
    ctx.beginPath();
    ctx.roundRect(
      pin.x - width / 2 - grow,
      pin.y - 10 - grow,
      width + 2 * grow,
      20 + 2 * grow,
      10 + grow,
    );
    ctx.fill();
  };
  ctx.shadowColor = "rgba(0, 0, 0, .35)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "#fff";
  pill(2);
  ctx.shadowColor = "transparent";
  ctx.fillStyle = color;
  pill(0);
  ctx.fillStyle = "#050608";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, pin.x, pin.y + 0.5);
  ctx.restore();
}

function cut(source: HTMLCanvasElement, frame: Rect) {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas context for the crop");
  ctx.drawImage(
    source,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    0,
    0,
    frame.width,
    frame.height,
  );
  return canvas;
}

function toPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"),
  );
}
