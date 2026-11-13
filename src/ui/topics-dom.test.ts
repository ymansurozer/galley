import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  renderTopicPage,
  renderTopicsNav,
  renderTopicsOverview,
  type TopicsOverview,
} from "./topics-dom";
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
  assert.deepEqual(text("[data-group] .topics-n"), ["0/2", "0/1", "0/1"]);
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

// t1 settled in round 2 (the current one), t3 and t4 in round 1.
const SETTLED = {
  round: 2,
  topics: Object.fromEntries(
    ["t1", "t2", "t3", "t4"].map((id) => [id, { blocks: [], lines: 1, coverHash: `H${id}` }]),
  ),
  settledTopics: {
    t1: { hash: "Ht1", round: 2 },
    t3: { hash: "Ht3", round: 1 },
    t4: { hash: "Ht4", round: 1 },
  },
};

test("each group shows done out of this round's topics and its mark; a topic's mark is a button", () => {
  const nav = host();
  renderTopicsNav(nav, topicsNavRows(STAGES, "t2", SETTLED));
  const text = (sel: string) => [...nav.querySelectorAll(sel)].map((el) => el.textContent?.trim());
  // Store's and Flags' one topic each was settled in round 1: nothing is left in this round's count.
  assert.deepEqual(text("[data-group] .topics-n"), ["1/2"]);
  assert.ok(nav.querySelector('[data-group="limits"] .st.pending'));
  assert.ok(nav.querySelector('[data-group="store"] .st.approved'));
  const t1 = nav.querySelector('[data-topic="t1"] button[data-mark="t1"]');
  assert.equal(t1?.getAttribute("aria-label"), "Reset to do");
  assert.ok(t1?.querySelector(".st.approved"));
  const t2 = nav.querySelector('[data-topic="t2"] button[data-mark="t2"]');
  assert.equal(t2?.getAttribute("aria-label"), "Settle topic");
  assert.ok(t2?.querySelector(".st.pending"));
});

test("topics settled in an earlier round fold into one closed row under the group", () => {
  const nav = host();
  renderTopicsNav(nav, topicsNavRows(STAGES, "t3", SETTLED));
  const fold = nav.querySelector<HTMLElement>("[data-earlier]");
  assert.equal(fold?.dataset.earlier, "store");
  assert.equal(fold?.textContent?.trim(), "1 settled in round 1");
  assert.equal(fold?.getAttribute("aria-expanded"), "true", "the open topic is in it");
  const closed = host();
  renderTopicsNav(closed, topicsNavRows(STAGES, "t2", { ...SETTLED, round: 3 }));
  assert.equal(closed.querySelector("[data-earlier]")?.getAttribute("aria-expanded"), "false");
  assert.deepEqual(
    [...closed.querySelectorAll<HTMLElement>("[data-topic]")].map((el) => el.dataset.topic),
    ["t2"],
    "t1, from round 2, is folded away in round 3",
  );
});

test("the bar offers Settle Topic on a topic to do, and Settled with Reset once settled", () => {
  const page = host();
  const place = topicPlaces(STAGES)[0]!;
  renderTopicPage(page, place, (s) => s, { settled: false, changed: false });
  const settle = page.querySelector('.file-bar [data-act="settle"]');
  assert.match(settle?.textContent ?? "", /Settle Topic/);
  assert.equal(page.querySelector('.file-bar [data-act="reset"]'), null);
  renderTopicPage(page, place, (s) => s, { settled: true, changed: false });
  assert.equal(page.querySelector('.file-bar [data-act="settle"]'), null);
  assert.equal(page.querySelector(".file-bar .fb-state")?.textContent, "Settled");
  assert.equal(page.querySelector('.file-bar [data-act="reset"]')?.textContent, "Reset");
});

test("a topic whose lines changed since the last round says so above its title", () => {
  const page = host();
  renderTopicPage(page, topicPlaces(STAGES)[0]!, (s) => s, { settled: false, changed: true });
  assert.equal(
    page.querySelector(".topic-meta .topic-changed")?.textContent,
    "Changed since your last round",
  );
});

test("the Overview's way in reads Start, Continue, or Send once every topic is settled", () => {
  const overview = (way: TopicsOverview["way"]) => {
    const page = host();
    renderTopicsOverview(
      page,
      {
        title: "T",
        facts: ["repo", "round 2"],
        added: 1,
        removed: 0,
        summary: "s",
        stale: false,
        way,
      },
      (s) => s,
    );
    return page;
  };
  assert.match(
    overview("start").querySelector('[data-act="start"]')?.textContent ?? "",
    /Start Review/,
  );
  assert.match(
    overview("continue").querySelector('[data-act="start"]')?.textContent ?? "",
    /Continue Review/,
  );
  const done = overview("send");
  assert.equal(done.querySelector(".topics-all")?.textContent, "Every topic is settled.");
  assert.match(done.querySelector('[data-act="start"]')?.textContent ?? "", /Send Review/);
  assert.match(done.querySelector(".go-sub")?.textContent ?? "", /round 2/);
});
