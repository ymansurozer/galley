import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { UiMark } from "../types";
import { marksPlacer, SETTLE, type Clock, type Placement } from "./placement";

// Time run by hand: `tick` moves it on, running each timer that comes due in order.
function manualClock() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  const clock: Clock = {
    now: () => now,
    after(ms, fn) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => (timers = timers.filter((t) => t !== timer));
    },
  };
  const tick = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      timers = timers.filter((t) => t !== next);
      now = next.at;
      next.fn();
    }
    now = end;
  };
  return { clock, tick };
}

function setup(html: string) {
  const { document } = new Window();
  document.body.innerHTML = html;
  const doc = document as unknown as Document;
  const { clock, tick } = manualClock();
  const reports: Placement[][] = [];
  const placer = marksPlacer(
    doc,
    clock,
    (p) => reports.push(p),
    () => {},
  );
  return { doc, placer, tick, reports };
}

const mark = (id: string, selector: string, text: string): UiMark => ({
  id,
  number: 1,
  resolved: false,
  question: false,
  target: {
    kind: "element",
    elements: [{ selector, tag: "button", text, rect: { x: 0, y: 0, width: 0, height: 0 } }],
  },
});

test("marks are looked for once the page settles, and what's found is placed", () => {
  const { doc, placer, tick, reports } = setup(`<button id="save">Save</button>`);
  placer.set([mark("a", "#save", "Save")]);
  tick(SETTLE.grace - 1);
  assert.deepEqual(reports, [], "not inside the grace period");
  assert.equal(placer.found("a"), null);
  // The page keeps changing: the look waits for a quiet spell.
  for (let i = 0; i < 3; i++) {
    placer.changed();
    tick(SETTLE.quiet - 50);
  }
  assert.deepEqual(reports, []);
  tick(SETTLE.quiet);
  assert.deepEqual(reports, [[{ id: "a", placement: "placed" }]]);
  assert.equal(placer.found("a")?.kind, "element");
  // A page that never stops changing is looked at anyway, after a bounded wait.
  doc.querySelector("#save")!.remove();
  placer.changed();
  for (let t = 0; t < SETTLE.maxWait; t += 100) {
    tick(100);
    placer.changed();
  }
  assert.equal(placer.placement("a"), "pending", "lost, so looked for anew");
});

test("a target not found is unplaced only once the cap has passed since the page's scripts ran", () => {
  const { doc, placer, tick, reports } = setup(``);
  placer.set([mark("a", "#save", "Save")]);
  tick(SETTLE.cap * 2);
  assert.deepEqual(reports, [], "the page's scripts haven't run: it may still render it");
  placer.ready();
  tick(SETTLE.cap - 1);
  assert.deepEqual(reports, []);
  // It rendered late: found, without ever being unplaced.
  doc.body.innerHTML = `<button id="save">Save</button>`;
  placer.changed();
  tick(SETTLE.quiet);
  assert.deepEqual(reports, [[{ id: "a", placement: "placed" }]]);

  placer.set([mark("a", "#save", "Save"), mark("b", "#help", "Help")]);
  tick(SETTLE.cap);
  assert.deepEqual(reports.at(-1), [{ id: "b", placement: "unplaced" }], "a isn't told again");
  placer.changed();
  tick(SETTLE.quiet);
  assert.equal(reports.length, 2, "looked for again, b is still unplaced: nothing to tell");
});

test("a mark whose element leaves the page is looked for again, and comes back when it does", () => {
  const { doc, placer, tick, reports } = setup(`<button id="save">Save</button>`);
  placer.ready();
  placer.set([mark("a", "#save", "Save")]);
  tick(SETTLE.grace);
  // A dialog closes: the element is gone.
  doc.querySelector("#save")!.remove();
  placer.changed();
  tick(SETTLE.quiet);
  assert.equal(placer.found("a"), null, "not drawn while it's looked for");
  tick(SETTLE.cap);
  // It opens again.
  doc.body.innerHTML = `<button id="save">Save</button>`;
  placer.changed();
  tick(SETTLE.quiet);
  assert.deepEqual(reports, [
    [{ id: "a", placement: "placed" }],
    [{ id: "a", placement: "unplaced" }],
    [{ id: "a", placement: "placed" }],
  ]);
});

test("a mark sent again keeps what was found for it, and an in-page route change settles anew", () => {
  const { placer, tick, reports } = setup(`<button id="save">Save</button>`);
  placer.ready();
  placer.set([mark("a", "#save", "Save")]);
  tick(SETTLE.grace);
  const found = placer.found("a");
  placer.set([{ ...mark("a", "#save", "Save"), resolved: true }]);
  assert.equal(placer.found("a"), found);
  placer.navigated();
  placer.set([mark("b", "#save", "Save")]);
  assert.equal(placer.found("a"), null, "a mark no longer sent is dropped");
  tick(SETTLE.grace - 1);
  assert.equal(reports.length, 1, "the new route's mark waits out the grace period, quiet or not");
  tick(1);
  assert.deepEqual(reports.at(-1), [{ id: "b", placement: "placed" }]);
});
