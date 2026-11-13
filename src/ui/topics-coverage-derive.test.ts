import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTopicShare, pointsPage } from "./topics-coverage-derive";

test("topic share uses the specified precision", () => {
  assert.equal(formatTopicShare(4, 10000), "<0.1%");
  assert.equal(formatTopicShare(606, 10000), "6.1%");
  assert.equal(formatTopicShare(2340, 10000), "23%");
  assert.equal(formatTopicShare(0, 0), "0%");
});

test("Points to keeps pages first and reveals ten at a time", () => {
  const items = [
    { kind: "page" as const, path: "/app" },
    ...Array.from({ length: 26 }, (_, i) => ({
      kind: "code" as const,
      path: `f${i}`,
      line: 3,
      lines: 2,
    })),
  ];
  const first = pointsPage(items);
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0]?.path, "/app");
  assert.equal(first.more, 10);
  const second = pointsPage(items, 20);
  assert.equal(second.items.length, 20);
  assert.equal(second.more, 7);
  assert.equal(pointsPage(items, 30).items.length, 27);
  assert.equal(pointsPage(items, 30).more, 0);
});
