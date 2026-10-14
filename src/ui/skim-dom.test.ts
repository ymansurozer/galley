import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { diffColumns, hideBetween, misalignedColumns, type DiffColumn } from "./skim-dom";

// @pierre's split-view shape for a file whose changes are pure additions: the deletions column
// pads each block with filler rows, and each column's annotation (the skim strip) is two rows —
// a [data-line-annotation] row in the content track and a [data-gutter-buffer="annotation"]
// spacer in the gutter. Each fixture row carries a data-t label so the tests read as row lists.
const ctx = (n: number) =>
  `<div data-t="ctx${n}" data-line-type="context" data-line-index="${n},${n}"></div>`;
const add = (n: number) =>
  `<div data-t="add${n}" data-line-type="change-addition" data-line-index="${n},${n}" data-line="${n + 1}"></div>`;
const gutterAnnotation = `<div data-t="gAnn" data-gutter-buffer="annotation" data-buffer-size="1"></div>`;
const contentAnnotation = `<div data-t="ann" data-line-annotation="0,5"></div>`;

// Both tracks of both columns for `blocks` four-row addition blocks. Block k sits at line indexes
// 6k+2..6k+5 between context lines 6k+1 and 6k+6; context 0-1 opens the file.
function diff(blocks: number): DiffColumn[] {
  const tracks = { delGutter: "", delContent: "", addGutter: "", addContent: "" };
  const lead = ctx(0) + ctx(1);
  for (const key of Object.keys(tracks) as Array<keyof typeof tracks>) tracks[key] = lead;
  for (let k = 0; k < blocks; k++) {
    const rows = [0, 1, 2, 3].map((i) => add(6 * k + 2 + i)).join("");
    const tail = ctx(6 * k + 6) + ctx(6 * k + 7);
    tracks.delGutter += `<div data-t="buf" data-gutter-buffer="buffer" data-buffer-size="4"></div>${gutterAnnotation}${tail}`;
    tracks.delContent += `<div data-t="buf" data-content-buffer data-buffer-size="4"></div>${contentAnnotation}${tail}`;
    tracks.addGutter += rows + gutterAnnotation + tail;
    tracks.addContent += rows + contentAnnotation + tail;
  }
  const doc = new Window().document as unknown as Document;
  const column = (gutter: string, content: string): DiffColumn => {
    const el = doc.createElement("div");
    el.innerHTML = `<div data-gutter>${gutter}</div><div data-content>${content}</div>`;
    return {
      gutter: el.querySelector<HTMLElement>("[data-gutter]"),
      content: el.querySelector<HTMLElement>("[data-content]"),
    };
  };
  return [column(tracks.delGutter, tracks.delContent), column(tracks.addGutter, tracks.addContent)];
}

const visible = (track: HTMLElement | null) =>
  Array.from(track!.children)
    .filter((k) => (k as HTMLElement).style.display !== "none")
    .map((k) => k.getAttribute("data-t"));

test("collapsing a block hides its change rows and filler but keeps the annotation row in both tracks", () => {
  const columns = diff(1);
  const hidden = hideBetween(columns, "1,1", "6,6");
  const [del, add] = columns;
  assert.deepEqual(visible(del!.content), ["ctx0", "ctx1", "ann", "ctx6", "ctx7"]);
  assert.deepEqual(visible(add!.content), ["ctx0", "ctx1", "ann", "ctx6", "ctx7"]);
  assert.deepEqual(visible(del!.gutter), ["ctx0", "ctx1", "gAnn", "ctx6", "ctx7"]);
  assert.deepEqual(visible(add!.gutter), ["ctx0", "ctx1", "gAnn", "ctx6", "ctx7"]);
  assert.equal(hidden, 10, "a filler pair in deletions, four change rows per track in additions");
});

test("after collapsing one block every column's gutter and content show the same number of rows", () => {
  const columns = diff(1);
  hideBetween(columns, "1,1", "6,6");
  assert.deepEqual(misalignedColumns(columns), []);
});

test("after collapsing two blocks in one file every column's gutter and content still match", () => {
  const columns = diff(2);
  hideBetween(columns, "1,1", "6,6");
  hideBetween(columns, "7,7", "12,12");
  for (const col of columns) {
    assert.deepEqual(visible(col.gutter), [
      "ctx0",
      "ctx1",
      "gAnn",
      "ctx6",
      "ctx7",
      "gAnn",
      "ctx12",
      "ctx13",
    ]);
    assert.deepEqual(visible(col.content), [
      "ctx0",
      "ctx1",
      "ann",
      "ctx6",
      "ctx7",
      "ann",
      "ctx12",
      "ctx13",
    ]);
  }
  assert.deepEqual(misalignedColumns(columns), []);
});

// On a cold mount render() can resolve while @pierre's shadow root exists but is still empty;
// the collapse reads "no columns" as not-ready rather than as a block it failed to find.
test("diffColumns finds no columns in a shadow root @pierre hasn't filled yet", () => {
  const doc = new Window().document as unknown as Document;
  const shadow = doc.createElement("div").attachShadow({ mode: "open" });
  assert.deepEqual(diffColumns(shadow), []);
});

test("diffColumns returns each rendered column's gutter and content tracks", () => {
  const doc = new Window().document as unknown as Document;
  const shadow = doc.createElement("div").attachShadow({ mode: "open" });
  const column = (side: string) =>
    `<code data-code data-${side}><div data-gutter data-t="${side}-g"></div><div data-content data-t="${side}-c"></div></code>`;
  shadow.innerHTML = `<pre data-diff>${column("deletions")}${column("additions")}</pre>`;
  assert.deepEqual(
    diffColumns(shadow).map((c) => [c.gutter?.dataset.t, c.content?.dataset.t]),
    [
      ["deletions-g", "deletions-c"],
      ["additions-g", "additions-c"],
    ],
  );
});

test("misalignedColumns names a column whose gutter lost a row", () => {
  const columns = diff(1);
  columns[1]!.gutter!.querySelector<HTMLElement>("[data-t=gAnn]")!.style.display = "none";
  assert.deepEqual(misalignedColumns(columns), [1]);
});
