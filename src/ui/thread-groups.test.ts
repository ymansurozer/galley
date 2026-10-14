import { test } from "node:test";
import assert from "node:assert/strict";
import type { Side } from "./types";
import { threadGroups, type ChangeBlock } from "./thread-groups.js";

type T = { key: string; side: Side; line: number; status?: "open" | "resolved" };
const t = (line: number, over: Partial<T> = {}): T => ({
  key: `${over.side ?? "additions"}:${line}`,
  side: "additions",
  line,
  ...over,
});
const same = (_side: Side, line: number) => line;
// A change block: its additions-side lines [from, from+count), and its deletions-side ones.
const block = (id: string, add: [number, number], del: [number, number] = [add[0], 0]) =>
  ({
    id,
    additions: { from: add[0], count: add[1] },
    deletions: { from: del[0], count: del[1] },
  }) satisfies ChangeBlock;
const shape = (groups: ReturnType<typeof threadGroups<T>>) =>
  groups.map((g) => `${g.line}:[${g.threads.map((x) => x.line).join(",")}]`);

test("threads within 2 lines of each other in one change gather under the last", () => {
  const blocks = [block("c1", [8, 12])];
  assert.deepEqual(shape(threadGroups([t(15), t(10), t(12)], same, blocks, null)), [
    "12:[10,12]",
    "15:[15]",
  ]);
  // Each step counts from the previous anchor, so a run of close anchors stays one group.
  assert.deepEqual(shape(threadGroups([t(10), t(12), t(14)], same, blocks, null)), [
    "14:[10,12,14]",
  ]);
});

test("nothing gathers across changes, or between a change and the code around it", () => {
  const blocks = [block("c1", [8, 4]), block("c2", [12, 3])];
  assert.deepEqual(shape(threadGroups([t(11), t(12)], same, blocks, null)), ["11:[11]", "12:[12]"]);
  // Line 7 is context just above c1; line 8 is c1's first line.
  assert.deepEqual(shape(threadGroups([t(7), t(8)], same, blocks, null)), ["7:[7]", "8:[8]"]);
});

test("context lines gather within one unchanged run; a deletion between them splits it", () => {
  // A pure deletion sits before new line 21: no additions-side lines, but it splits the run.
  const blocks = [block("del", [21, 0], [20, 3])];
  assert.deepEqual(shape(threadGroups([t(3), t(5)], same, blocks, null)), ["5:[3,5]"]);
  assert.deepEqual(shape(threadGroups([t(20), t(22)], same, blocks, null)), ["20:[20]", "22:[22]"]);
});

test("the two sides never gather: their numbers count different files", () => {
  const groups = threadGroups(
    [t(10, { side: "deletions" }), t(11, { side: "additions" })],
    same,
    [],
    null,
  );
  assert.deepEqual(
    groups.map((g) => `${g.side}:${g.line}`),
    ["deletions:10", "additions:11"],
  );
});

test("resolved threads rest in their groups like open ones; only the open key is open", () => {
  const groups = threadGroups(
    [t(10, { status: "resolved" }), t(11), t(30)],
    same,
    [],
    "additions:11",
  );
  assert.deepEqual(shape(groups), ["11:[10,11]", "30:[30]"]);
  assert.deepEqual(
    groups.flatMap((g) =>
      g.threads.map((x) => `${x.line}${x.status === "resolved" ? "✓" : ""}:${x.open}`),
    ),
    ["10✓:false", "11:true", "30:false"],
  );
});

test("anchors gather by where they render after Keep / Undo renumbered the lines", () => {
  // Undoing an 8-line addition above line 32 pulls every later new-side line up by 8: raw 40
  // renders at 32, two lines under raw 30. By raw numbers they'd be 10 apart.
  const undone = (_side: Side, line: number) => (line > 31 ? line - 8 : line);
  const groups = threadGroups([t(30), t(40)], undone, [], null);
  assert.deepEqual(shape(groups), ["32:[30,40]"]);
  assert.deepEqual(
    groups[0]!.threads.map((x) => x.display),
    [30, 32],
  );
});

test("a range thread anchors at its first line, where it mounts", () => {
  const range = { ...t(10), endLine: 14 };
  assert.deepEqual(shape(threadGroups([range, t(12)], same, [], null)), ["12:[10,12]"]);
  assert.deepEqual(shape(threadGroups([range, t(15)], same, [], null)), ["10:[10]", "15:[15]"]);
});
