import { test } from "node:test";
import assert from "node:assert/strict";

import { cropFrame } from "./crop";

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
