import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { renderCoverage, renderPoints, renderTopicShare } from "./topics-coverage-dom";

test("coverage exposes reasons, rules and exclusive counts; stale gaps are explicit", () => {
  const host = new Window().document.createElement("div");
  host.innerHTML = renderCoverage({
    topicLines: 3,
    skimmedLines: 5,
    totalLines: 9,
    uncoveredLines: 1,
    skims: [{ reason: "<generated>", rule: "Churn", lines: 5 }],
  });
  assert.equal(host.querySelector("details")?.open, false);
  assert.match(host.textContent, /<generated>Rule: Churn/);
  assert.match(host.textContent, /1 lines not in the guide yet/);
  assert.equal(host.querySelector("generated"), null);
  host.innerHTML = renderTopicShare(3, 8);
  assert.equal(host.querySelector("span")?.title, "3 of 8 unskimmed lines");
});

test("Points to starts folded, lists pages without app controls when unavailable and targets code lines", () => {
  const host = new Window().document.createElement("div");
  const items = [
    { kind: "page" as const, path: "/settings" },
    { kind: "code" as const, path: "src/a.ts", line: 42, lines: 3 },
  ];
  host.innerHTML = renderPoints(items, 3, false);
  assert.equal(host.querySelector("details")?.open, false);
  assert.match(host.textContent, /1 page, 1 place in the code/);
  assert.equal(host.querySelector("[data-topic-app]"), null);
  assert.match(host.textContent, /a.ts:42/);
  assert.equal(host.querySelector("[data-topic-code]")?.getAttribute("data-line"), "42");
  host.innerHTML = renderPoints(items, 3, true);
  assert.equal(host.querySelector("[data-topic-app]")?.getAttribute("data-topic-app"), "/settings");
});
