import { test } from "node:test";
import assert from "node:assert/strict";
import { uuid, uuidFallback } from "./uuid";

// Standard v4 shape: 8-4-4-4-12 hex groups, version nibble "4", variant nibble in [89ab].
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uuidFallback returns v4-format ids", () => {
  assert.match(uuidFallback(), V4);
});

test("uuidFallback: successive calls differ", () => {
  assert.notEqual(uuidFallback(), uuidFallback());
});

test("uuid: falls back to v4 format when crypto.randomUUID is absent", () => {
  const original = crypto.randomUUID;
  // @ts-expect-error — simulating an insecure context, where randomUUID is undefined.
  crypto.randomUUID = undefined;
  try {
    assert.match(uuid(), V4);
  } finally {
    crypto.randomUUID = original;
  }
});

test("uuid: uses the native implementation when available", () => {
  const original = crypto.randomUUID;
  const sentinel =
    "11111111-1111-4111-8111-111111111111" as `${string}-${string}-${string}-${string}-${string}`;
  crypto.randomUUID = () => sentinel;
  try {
    assert.equal(uuid(), sentinel);
  } finally {
    crypto.randomUUID = original;
  }
});
