import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  KeyboardEvent: window.KeyboardEvent,
  ResizeObserver: window.ResizeObserver,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  CSS: window.CSS,
  matchMedia: window.matchMedia.bind(window),
});
window.document.body.innerHTML = '<div id="topicsNav"></div><div id="topics"></div>';
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const alpinePath = require.resolve("alpinejs");
const alpine = require(alpinePath);
Object.assign(alpine, alpine.default);
const { S, saver } = await import("./store");
const { installTopics, renderTopics } = await import("./topics");
const { installKeys } = await import("./keys");
const { sendCancel } = await import("./send");
const { topicsDone } = await import("./topics-derive");

const stages = [
  {
    id: "s",
    label: "Stage",
    groups: [
      {
        id: "g1",
        title: "First",
        topics: [{ id: "a", title: "A", recorded: "r", body: "Body", covers: [] }],
      },
      {
        id: "g2",
        title: "Second",
        topics: [{ id: "b", title: "B", recorded: "r", body: "Body", covers: [] }],
      },
    ],
  },
];
const state = () =>
  ({
    guide: { title: "Review", overview: "Overview", stages },
    files: [],
    mode: "working",
    session: "test",
    round: 2,
    topics: {
      a: { blocks: [], lines: 0, coverHash: "ha" },
      b: { blocks: [], lines: 0, coverHash: "hb" },
    },
    settledTopics: { a: { hash: "ha", round: 1 } },
    topicThreads: [],
  }) as unknown as typeof S.state;
const press = (key: string, shiftKey = false) =>
  window.document.dispatchEvent(
    new window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true }),
  );
installTopics();
installKeys();

test("Shift+A advances settled topics without saving, and preserves pending settlement and sidebar toggle", () => {
  const saves = mock.method(saver, "trigger", () => {});
  S.state = state();
  S.view = "topics";
  S.topicAt = "a";
  S.promptTopicsFinish = () => {
    S.sendOpen = true;
  };
  S.sendCancel = sendCancel;
  renderTopics();
  press("A", true);
  assert.equal(S.topicAt, "b");
  assert.deepEqual(S.state.settledTopics!.a, { hash: "ha", round: 1 });
  assert.deepEqual(topicsDone(stages, S.state), { done: 1, total: 2 });
  assert.equal(S.state.round, 2);
  assert.equal(saves.mock.callCount(), 0);

  press("A", true);
  assert.deepEqual(S.state.settledTopics!.b, { hash: "hb", round: 2 });
  assert.equal(saves.mock.callCount(), 1);
  assert.equal(S.topicAt, null);
  assert.equal(S.sendOpen, true);
  press("Escape");
  assert.equal(S.sendOpen, false);
  assert.equal(S.state.round, 2);

  S.topicAt = "a";
  renderTopics();
  press("A", true);
  assert.equal(S.topicAt, null);
  assert.equal(S.sendOpen, true);
  assert.equal(saves.mock.callCount(), 1);
  press("Escape");
  assert.equal(S.state.round, 2);
  assert.deepEqual(S.state.settledTopics!.a, { hash: "ha", round: 1 });

  S.topicAt = "b";
  renderTopics();
  (window.document.querySelector('[data-mark="b"]') as unknown as HTMLButtonElement).click();
  assert.equal(S.state.settledTopics!.b, undefined);
  assert.equal(S.topicAt, "b");
  (window.document.querySelector('[data-mark="b"]') as unknown as HTMLButtonElement).click();
  assert.deepEqual(S.state.settledTopics!.b, { hash: "hb", round: 2 });
  assert.equal(S.topicAt, "b");
  assert.equal(saves.mock.callCount(), 3);
  saves.mock.restore();
});
