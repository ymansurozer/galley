import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { optionsList } from "./topics-options-dom";
import { markParts, underPart } from "./topicthreads-dom";
test("options render safe labels, tags, selection, notes and commentable parts", () => {
  const doc = new Window().document as unknown as Document;
  const picked: number[] = [];
  const host = doc.createElement("div");
  host.append(
    optionsList(
      doc,
      [
        { label: "What exists", ships: true },
        { label: "<img src=x onerror=alert(1)>", recommended: true, note: "A note" },
      ],
      1,
      true,
      (i) => picked.push(i),
    ),
  );
  assert.equal(host.querySelectorAll('[role="radio"]').length, 2);
  assert.equal(host.querySelectorAll("img").length, 0);
  assert.match(host.textContent!, /What ships/);
  assert.match(host.textContent!, /Agent recommends/);
  assert.match(host.textContent!, /Change requested/);
  assert.match(host.textContent!, /A note/);
  assert.equal(host.querySelector('[aria-checked="true"]')?.textContent?.startsWith("<img"), true);
  const marked = markParts(host, ["option:1", "option:2"], "option:2", new Set());
  assert.equal(marked.size, 2);
  underPart(marked.get("option:2")!).textContent = "Thread here";
  (host.querySelector('[role="radio"]') as HTMLButtonElement).click();
  assert.deepEqual(picked, [0]);
});
