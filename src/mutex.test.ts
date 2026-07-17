import { test } from "node:test";
import assert from "node:assert/strict";
import { createSerializer } from "./mutex.js";

test("serialize runs tasks in enqueue order — a later task waits for an earlier slow one", async () => {
  const serialize = createSerializer();
  const order: string[] = [];
  // Enqueued synchronously, so enqueue order is guaranteed. The first task is deliberately slow;
  // the second resolves immediately. Without serialization the fast one would finish first — the
  // mutex forces completion order to match enqueue order regardless of duration.
  const slow = serialize(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push("slow");
    return "slow";
  });
  const fast = serialize(async () => {
    order.push("fast");
    return "fast";
  });
  const results = await Promise.all([slow, fast]);
  assert.deepEqual(order, ["slow", "fast"]);
  assert.deepEqual(results, ["slow", "fast"]);
});

test("a rejecting task does not poison the chain, and its rejection reaches the caller", async () => {
  const serialize = createSerializer();
  const order: string[] = [];
  const boom = serialize(async () => {
    order.push("boom");
    throw new Error("boom");
  });
  const after = serialize(async () => {
    order.push("after");
    return "ok";
  });
  // The failing task's own promise rejects (the caller sees its error)…
  await assert.rejects(boom, /boom/);
  // …but the chain keeps flowing — the next task still runs to completion, in order.
  assert.equal(await after, "ok");
  assert.deepEqual(order, ["boom", "after"]);
});
