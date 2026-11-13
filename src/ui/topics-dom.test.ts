import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { estimateMeasure } from "./map-check";
import { layoutMap } from "./map-derive";
import { renderTopicPage, renderTopicsNav, renderTopicsOverview } from "./topics-dom";
import { topicPlaces, topicsNavRows } from "./topics-derive";
import type { GuideStage } from "../types";

const STAGES: GuideStage[] = [
  {
    id: "edge",
    label: "Edge",
    groups: [
      {
        id: "limits",
        title: "Limits",
        topics: [
          { id: "t1", title: "Limit per key", recorded: "r", body: "b", covers: [{ path: "a" }] },
          {
            id: "t2",
            title: "A <long> title that wraps",
            recorded: "r",
            body: "b",
            flag: "Shared keys",
            covers: [{ path: "a" }],
          },
        ],
      },
      {
        id: "store",
        title: "Store",
        topics: [{ id: "t3", title: "Redis", recorded: "r", body: "b", covers: [{ path: "a" }] }],
      },
    ],
  },
  {
    id: "rollout",
    label: "Rollout",
    groups: [
      {
        id: "flags",
        title: "Flags",
        topics: [{ id: "t4", title: "Switch", recorded: "r", body: "b", covers: [{ path: "a" }] }],
      },
    ],
  },
];

const host = () => new Window().document.createElement("div") as unknown as HTMLElement;

test("the sidebar renders stage headers, group rows and only the current group's topic rows", () => {
  const nav = host();
  renderTopicsNav(nav, topicsNavRows(STAGES, "t2"));
  const text = (sel: string) => [...nav.querySelectorAll(sel)].map((el) => el.textContent?.trim());
  assert.deepEqual(text(".walk-cat"), ["Edge", "Rollout"]);
  assert.deepEqual(
    [...nav.querySelectorAll("[data-group]")].map((el) => (el as HTMLElement).dataset.group),
    ["limits", "store", "flags"],
  );
  assert.deepEqual(text("[data-group] .topics-n"), ["2", "1", "1"]);
  assert.ok(nav.querySelector('[data-group="limits"]')?.classList.contains("current"));
  const topics = [...nav.querySelectorAll<HTMLElement>("[data-topic]")];
  assert.deepEqual(
    topics.map((el) => el.dataset.topic),
    ["t1", "t2"],
  );
  // The full title rides the row for hover; the open topic is marked active.
  assert.equal(topics[1]!.title, "A <long> title that wraps");
  assert.equal(topics[1]!.querySelector(".topics-tt")?.textContent, "A <long> title that wraps");
  assert.ok(topics[1]!.classList.contains("active"));
  assert.ok(!topics[0]!.classList.contains("active"));
});

test("a flagged topic's row carries the flag, and an unflagged one doesn't", () => {
  const nav = host();
  renderTopicsNav(nav, topicsNavRows(STAGES, "t1"));
  assert.ok(nav.querySelector('[data-topic="t2"] .crit'));
  assert.equal(nav.querySelector('[data-topic="t1"] .crit'), null);
});

test("the Overview unfolds no group", () => {
  const nav = host();
  renderTopicsNav(nav, topicsNavRows(STAGES, null));
  assert.equal(nav.querySelectorAll("[data-topic]").length, 0);
  assert.equal(nav.querySelectorAll("[data-group].current").length, 0);
});

test("the topic page shows its bar, concern, title, Recorded, body and the Flagged card below the body", () => {
  const page = host();
  const place = topicPlaces(STAGES)[1]!;
  place.topic.concern = "Behaviour";
  renderTopicPage(page, place, (s) => `<p>${s}</p>`);
  assert.equal(page.querySelector(".file-bar .fb-dir")?.textContent?.trim(), "Edge /");
  assert.equal(page.querySelector(".file-bar .fb-name")?.textContent, "Limits");
  assert.equal(page.querySelector(".topic-concern")?.textContent, "Behaviour");
  assert.equal(page.querySelector("h1")?.textContent, "A <long> title that wraps");
  assert.equal(page.querySelector(".topic-recorded")?.textContent, "Recorded: r");
  const parts = [...page.querySelectorAll(".topic-page > *")].map((el) => el.className);
  assert.deepEqual(parts, [
    "topic-meta",
    "topic-title",
    "topic-recorded",
    "topic-body md",
    "topic-flag",
  ]);
  assert.match(page.querySelector(".topic-flag")?.textContent ?? "", /Flagged\s*Shared keys/);
});

test("a topic without a concern or a flag shows neither", () => {
  const page = host();
  renderTopicPage(page, topicPlaces(STAGES)[0]!, (s) => s);
  assert.equal(page.querySelector(".topic-meta"), null);
  assert.equal(page.querySelector(".topic-flag"), null);
});

const OVERVIEW = {
  title: "Rate limiting",
  facts: ["working", "main"],
  added: 3,
  removed: 1,
  summary: "Adds limits.",
  stale: false,
};

test("the Overview shows the map, and its narrow list, between the summary and Start Review", () => {
  const page = host();
  const links = [{ from: "limits", to: "flags", label: "limits" }];
  const layout = layoutMap(STAGES, links, estimateMeasure())!;
  renderTopicsOverview(page, { ...OVERVIEW, map: { layout, stages: STAGES, links } }, (s) => s);
  const sections = [...page.querySelectorAll(".topics-overview > *")].map((el) => el.className);
  assert.deepEqual(sections, ["go-card", "topics-map", "go-card topics-end"]);
  const map = page.querySelector(".topics-map")!;
  assert.deepEqual(
    [...map.querySelectorAll<HTMLElement>(".map-box")].map((b) => b.dataset.group),
    ["limits", "store", "flags"],
  );
  assert.equal(map.querySelectorAll(".map-link").length, 1);
  assert.equal(map.querySelectorAll(".map-list-row").length, 3);
});

test("the Overview has no map without one", () => {
  const page = host();
  renderTopicsOverview(page, OVERVIEW, (s) => s);
  assert.equal(page.querySelector(".topics-map"), null);
});
