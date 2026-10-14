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

// The page's pins (annotate.ts) and the screenshots' (capture.ts) are one speech bubble: 24 px high,
// rounded but for its bottom-left corner, the tail, which sits 2 px off the target's top-left
// corner. It carries the kind's glyph (lucide's flag or message-circle, on a 24-unit grid) in white,
// then the number, on the kind's colour.
export const PIN = {
  height: 24,
  radii: [12, 12, 12, 3],
  change: {
    color: "#b05400",
    glyph:
      "M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.33 2q2 0 3.07-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.53",
  },
  question: { color: "#0a72e8", glyph: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z" },
};

// About how wide the bubble is for `number`: 8 px in, the 12 px glyph, 4 px, about 8 px a digit of
// the 12 px bold number, 8 px out.
export const pinWidth = (number: number) => 31 + 8 * String(number).length;

// Where a pin's tail goes for a target's first box: its top-left corner, kept so the bubble stays on
// screen (26 px of room above it, and `width` to its right; 44 px suits a two-digit number).
export const pinCorner = (r: Rect, viewWidth: number, width = 44) => ({
  x: Math.max(2, Math.min(viewWidth - width, r.x)),
  y: Math.max(26, r.y),
});

// The bubble's own box for a pin whose tail sits at `pin`, so a crop can hold it whole.
export const pinBox = (pin: { x: number; y: number }, number: number): Rect => ({
  x: pin.x - 2,
  y: pin.y - 2 - PIN.height,
  width: pinWidth(number),
  height: PIN.height,
});

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
// refind.ts locates them), the way the page draws its marks (annotate.ts): an outline just outside
// each element's box, so the stroke doesn't cover the element's own edge; the region's dashed box;
// or the quote's highlighted lines. The numbered pin's tail sits on the first box's top-left
// corner, kept on screen as the page's pins are.
export function markShape(
  kind: UiMarkTarget["kind"],
  boxes: readonly [Rect, ...Rect[]],
  view: { width: number; height: number },
  number?: number,
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
    pin: pinCorner(first, view.width, number === undefined ? undefined : pinWidth(number)),
  };
}
