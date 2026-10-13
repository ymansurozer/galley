import { test } from "node:test";
import assert from "node:assert/strict";

import { atRenderScroll, cropFrame, markShape, unionRect } from "./crop";

const VIEW = { width: 1440, height: 900 };

test("cropFrame grows the box by the padding and scales it to device pixels", () => {
  // (100-32)·2 = 136, (50-32)·2 = 36, (100+200+32)·2 = 664, (50+100+32)·2 = 364.
  assert.deepEqual(cropFrame({ x: 100, y: 50, width: 200, height: 100 }, VIEW, 2, 32), {
    x: 136,
    y: 36,
    width: 528,
    height: 328,
  });
});

test("cropFrame clamps the padding at the viewport's edges", () => {
  assert.deepEqual(cropFrame({ x: 10, y: 5, width: 50, height: 20 }, VIEW, 1, 32), {
    x: 0,
    y: 0,
    width: 92,
    height: 57,
  });
  // Right/bottom: the frame stops at 1440×900 CSS px, i.e. 2880×1800 device px.
  assert.deepEqual(cropFrame({ x: 1400, y: 880, width: 100, height: 50 }, VIEW, 2, 32), {
    x: 2736,
    y: 1696,
    width: 144,
    height: 104,
  });
});

test("cropFrame snaps a fractional frame outward to whole device pixels", () => {
  // 10.3·1.5 = 15.45 → 15; 20.3·1.5 = 30.45 → 31.
  assert.deepEqual(cropFrame({ x: 10.3, y: 10.3, width: 10, height: 10 }, VIEW, 1.5, 0), {
    x: 15,
    y: 15,
    width: 16,
    height: 16,
  });
});

test("cropFrame keeps the frame inside a canvas of a fractional-DPR viewport", () => {
  // The rendered canvas is floor(1366·1.25) = 1707 px wide, not 1707.5.
  const frame = cropFrame(
    { x: 1300, y: 0, width: 66, height: 10 },
    { width: 1366, height: 768 },
    1.25,
    32,
  );
  assert.ok(frame);
  assert.equal(frame.x + frame.width, 1707);
});

test("cropFrame is the whole viewport when the box covers it", () => {
  assert.deepEqual(cropFrame({ x: -50, y: -400, width: 2000, height: 3000 }, VIEW, 2, 32), {
    x: 0,
    y: 0,
    width: 2880,
    height: 1800,
  });
});

test("cropFrame is null for a box with no part on screen, even if its padding reaches in", () => {
  assert.equal(cropFrame({ x: 0, y: 940, width: 100, height: 100 }, VIEW, 2, 32), null);
  assert.equal(cropFrame({ x: 0, y: -120, width: 100, height: 100 }, VIEW, 1, 32), null);
  assert.equal(cropFrame({ x: -110, y: 0, width: 100, height: 100 }, VIEW, 2, 32), null);
  assert.equal(cropFrame({ x: 10, y: 10, width: 0, height: 0 }, VIEW, 2, 32), null);
});

test("cropFrame frames only the on-screen part of a partly visible box", () => {
  // Rows 0–50 of the box are on screen; the frame runs to 50 + 32.
  assert.deepEqual(cropFrame({ x: 0, y: -50, width: 100, height: 100 }, VIEW, 1, 32), {
    x: 0,
    y: 0,
    width: 132,
    height: 82,
  });
});

test("atRenderScroll moves a rect measured at one window scroll into a render taken at another", () => {
  // Measured with the window at y = 600: the element sits at document y = 700. The render offset
  // the document by 560, so the element is at 700 − 560 = 140 in the image.
  assert.deepEqual(
    atRenderScroll({ x: 10, y: 100, width: 50, height: 20 }, { x: 0, y: 600 }, { x: 0, y: 560 }),
    { x: 10, y: 140, width: 50, height: 20 },
  );
  assert.deepEqual(
    atRenderScroll({ x: 10, y: 100, width: 50, height: 20 }, { x: 30, y: 0 }, { x: 0, y: 0 }),
    { x: 40, y: 100, width: 50, height: 20 },
  );
});

test("unionRect is the smallest box holding them all", () => {
  assert.deepEqual(
    unionRect([
      { x: 100, y: 50, width: 200, height: 40 },
      { x: 20, y: 300, width: 50, height: 10 },
    ]),
    { x: 20, y: 50, width: 280, height: 260 },
  );
});

test("markShape outlines each element 2 px outside its box and pins the first one's corner", () => {
  // The stroke runs 1 px either side of the outline, so it covers 1–3 px outside the box.
  assert.deepEqual(
    markShape(
      "element",
      [
        { x: 100, y: 50, width: 200, height: 40 },
        { x: 400, y: 50, width: 60, height: 20 },
      ],
      VIEW,
    ),
    {
      shapes: [
        { style: "outline", rect: { x: 98, y: 48, width: 204, height: 44 } },
        { style: "outline", rect: { x: 398, y: 48, width: 64, height: 24 } },
      ],
      pin: { x: 100, y: 50 },
    },
  );
});

test("markShape draws a region as its dashed box and text as its highlighted lines", () => {
  const box = { x: 100, y: 50, width: 200, height: 40 };
  assert.deepEqual(markShape("region", [box], VIEW), {
    shapes: [{ style: "dashed", rect: box }],
    pin: { x: 100, y: 50 },
  });
  const lines = [
    { x: 300, y: 50, width: 120, height: 18 },
    { x: 100, y: 68, width: 80, height: 18 },
  ] as const;
  assert.deepEqual(markShape("text", [...lines], VIEW), {
    shapes: lines.map((rect) => ({ style: "highlight", rect })),
    pin: { x: 300, y: 50 },
  });
});

test("markShape keeps the pin on screen at the viewport's edges, as the page's pins are", () => {
  // A 20 px pin centred on a corner needs 11 px (its radius and a pixel) to stay whole.
  assert.deepEqual(markShape("element", [{ x: 0, y: 4, width: 50, height: 20 }], VIEW).pin, {
    x: 11,
    y: 11,
  });
  assert.deepEqual(markShape("region", [{ x: 1438, y: 300, width: 50, height: 20 }], VIEW).pin, {
    x: 1429,
    y: 300,
  });
});
