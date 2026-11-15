import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

// The real annotation builder over the real store, bundled as the tab bundles it.
async function harness() {
  const bundle = await build({
    stdin: {
      contents:
        'import {S} from "./store"; import {annotations} from "./annotations"; import {renderMarkdown} from "./markdown"; window.h={S,annotations,renderMarkdown};',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
  });
  const win = new Window({ url: "http://localhost:41000/" });
  win.eval(bundle.outputFiles[0]!.text);
  const h = (win as any).h;
  // The markdown highlighter redraws the desk once it is ready; let that happen before there is a
  // review for it to draw.
  const deadline = Date.now() + 5000;
  while (!h.renderMarkdown("**ready**").includes("<strong>")) {
    assert.ok(Date.now() < deadline, "the highlighter gets ready");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { h, close: () => win.happyDOM.close() };
}

const at = (side: string, lineNumber: number, path = "src/a.ts") => ({
  id: `${path}:${side}:${lineNumber}`,
  path,
  side,
  lineNumber,
  status: "open",
  role: "user",
  body: "why?",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
});
const file = (path: string) => ({ path, status: "modified", hunks: [], added: 3, removed: 2 });
// Each annotation as `side:line`, in the order the builder returns them (an array of this realm,
// not the page's, so deepEqual compares it by value).
const where = (anns: Array<{ side: string; lineNumber: number }>) =>
  Array.from(anns, (a) => `${a.side}:${a.lineNumber}`);

test("a path and a range give the threads on lines inside the range, either side", async () => {
  const { h, close } = await harness();
  try {
    h.S.state = {
      files: [file("src/a.ts"), file("src/b.ts")],
      changes: [],
      comments: [
        at("additions", 5),
        at("additions", 12),
        at("additions", 30),
        at("deletions", 7),
        at("deletions", 20),
        at("additions", 12, "src/b.ts"),
      ],
    };
    // b.ts is on screen in Code mode; the block is on a.ts.
    h.S.fileIndex = 1;
    const block = h.annotations("src/a.ts", { additions: [10, 20], deletions: [18, 22] });
    assert.deepEqual(where(block), ["additions:12", "deletions:20"]);
    assert.ok(
      block.every((a: any) => a.metadata.type === "thread" && a.metadata.path === "src/a.ts"),
    );
    // A removed line's thread keeps its old-side line.
    assert.equal(block[1].metadata.comments[0].id, "src/a.ts:deletions:20");
    assert.deepEqual(
      where(h.annotations("src/a.ts", { additions: [40, 50], deletions: [1, 2] })),
      [],
    );
  } finally {
    await close();
  }
});

test("the current file with no range gives what the main diff always had", async () => {
  const { h, close } = await harness();
  try {
    h.S.state = {
      files: [file("src/a.ts"), file("src/b.ts")],
      changes: [],
      comments: [at("additions", 5), at("deletions", 7), at("additions", 3, "src/b.ts")],
    };
    h.S.fileIndex = 0;
    assert.deepEqual(where(h.annotations()), ["additions:5", "deletions:7"]);
    // A composer open on the code lane is the main diff's, at the selected line.
    h.S.composerOpen = true;
    h.S.selected = { side: "additions", lineNumber: 9 };
    assert.deepEqual(where(h.annotations()), ["additions:5", "deletions:7", "additions:9"]);
    assert.equal(h.annotations().at(-1).metadata.type, "composer");
    // A block's range never carries it.
    assert.deepEqual(where(h.annotations("src/a.ts", { additions: [1, 10], deletions: [1, 10] })), [
      "additions:5",
      "deletions:7",
    ]);
  } finally {
    await close();
  }
});
