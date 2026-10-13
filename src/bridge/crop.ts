import type { Rect } from "../types";

// Context around a cropped target, in CSS px: enough to show its neighbours and where it sits.
export const CROP_PADDING = 32;

// A viewport rect measured while the window was scrolled to `measured`, moved to where the element
// sits in a render that offset the document by `rendered`. The window can scroll during a render.
export function atRenderScroll(
  rect: Rect,
  measured: { x: number; y: number },
  rendered: { x: number; y: number },
): Rect {
  return {
    x: rect.x + measured.x - rendered.x,
    y: rect.y + measured.y - rendered.y,
    width: rect.width,
    height: rect.height,
  };
}

// The crop's frame in device pixels on a viewport image rendered at `dpr`: the on-screen part of
// `box` grown by `pad` CSS px, clamped to the viewport, snapped outward to whole pixels and kept
// inside the canvas (floor(view × dpr), as the renderer sizes it). Null when no part of the box is
// on screen: a frame of padding alone would show the reviewer's surroundings, not their target.
export function cropFrame(
  box: Rect,
  view: { width: number; height: number },
  dpr: number,
  pad = CROP_PADDING,
): Rect | null {
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(view.width, box.x + box.width);
  const bottom = Math.min(view.height, box.y + box.height);
  if (right <= left || bottom <= top) return null;
  const x = Math.floor(Math.max(0, left - pad) * dpr);
  const y = Math.floor(Math.max(0, top - pad) * dpr);
  const x2 = Math.min(Math.ceil((right + pad) * dpr), Math.floor(view.width * dpr));
  const y2 = Math.min(Math.ceil((bottom + pad) * dpr), Math.floor(view.height * dpr));
  return { x, y, width: x2 - x, height: y2 - y };
}

// A pin's half-height plus a pixel: how far its centre stays from the viewport's edges.
const PIN_INSET = 11;

// Where an annotation's mark goes on a viewport image, in CSS px: an outline just outside the
// target's box, so the stroke doesn't cover the element's own edge, and the numbered pin on the
// box's top-left corner, kept on screen the way the page's pins are (annotate.ts).
export function markShape(box: Rect, view: { width: number; height: number }) {
  return {
    outline: { x: box.x - 2, y: box.y - 2, width: box.width + 4, height: box.height + 4 },
    pin: {
      x: Math.max(PIN_INSET, Math.min(view.width - PIN_INSET, box.x)),
      y: Math.max(PIN_INSET, box.y),
    },
  };
}
