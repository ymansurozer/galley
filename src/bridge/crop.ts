import type { Rect, UiMarkTarget } from "../types";

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

// The smallest box holding all of `rects`.
export function unionRect([first, ...rest]: readonly [Rect, ...Rect[]]): Rect {
  let { x, y } = first;
  let right = first.x + first.width;
  let bottom = first.y + first.height;
  for (const r of rest) {
    x = Math.min(x, r.x);
    y = Math.min(y, r.y);
    right = Math.max(right, r.x + r.width);
    bottom = Math.max(bottom, r.y + r.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

// Where an annotation's mark goes on a viewport image, in CSS px, from its target's boxes (as
// targets.ts locates them), the way the page draws its marks (annotate.ts): an outline just outside
// each element's box, so the stroke doesn't cover the element's own edge; the region's dashed box;
// or the quote's highlighted lines. The numbered pin sits on the first box's top-left corner, kept
// on screen as the page's pins are.
export function markShape(
  kind: UiMarkTarget["kind"],
  boxes: readonly [Rect, ...Rect[]],
  view: { width: number; height: number },
) {
  const style = kind === "element" ? "outline" : kind === "region" ? "dashed" : "highlight";
  const [first] = boxes;
  return {
    shapes: boxes.map((b) => ({
      style,
      rect:
        style === "outline"
          ? { x: b.x - 2, y: b.y - 2, width: b.width + 4, height: b.height + 4 }
          : b,
    })),
    pin: {
      x: Math.max(PIN_INSET, Math.min(view.width - PIN_INSET, first.x)),
      y: Math.max(PIN_INSET, first.y),
    },
  };
}
