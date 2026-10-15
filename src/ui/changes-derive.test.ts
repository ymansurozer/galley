import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseDiffFromFile, processFile, type FileDiffMetadata } from "@pierre/diffs";
import { changeBlocks, changeStableKeyFromBlock, git, parseUnifiedDiff } from "../git.js";
import { buildReviewState, readFileContents, resolveGuide } from "../state.js";
import type { ChangeState, DiffHunk, Guide } from "../types.js";
import { deriveChanges, gitPatch, parseRawDiff } from "./changes-derive.js";
import { changeStableKey } from "./decisions-derive.js";
import { stepPlan } from "./steps.js";

const lib = { processFile, parseDiffFromFile };
const PATH = "invoice.js";

// A file jsdiff and git align differently: git's diff keeps the late-fee functions one block
// after `subtotal`, where @pierre's own re-diff (jsdiff) pairs the old `}` with a new one and
// splits it in two. The guide splits the file into "Late fees" (the constant and the new
// functions) and "Currency formatting".
const OLD = `export const lineTotal = (item) => item.qty * item.price;

export function subtotal(invoice) {
  return invoice.items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function total(invoice) {
  return subtotal(invoice);
}

export function formatMoney(amount) {
  return "$" + amount.toFixed(2);
}
`;
const NEW = `const LATE_FEE_RATE = 0.015;

export const lineTotal = (item) => item.qty * item.price;

export function subtotal(invoice) {
  return invoice.items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function isOverdue(invoice, today = new Date()) {
  return !invoice.paid && new Date(invoice.dueDate) < today;
}

export function lateFee(invoice, today) {
  if (!isOverdue(invoice, today)) return 0;
  return Math.round(subtotal(invoice) * LATE_FEE_RATE * 100) / 100;
}

export function total(invoice, today) {
  return subtotal(invoice) + lateFee(invoice, today);
}

export function formatMoney(amount) {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
`;
const GIT_KEYS = ["additions:1:0:2", "additions:9:2:11", "additions:23:1:1"];
const GUIDE: Guide = {
  overview: "Late fees",
  files: [
    {
      path: PATH,
      order: 0,
      category: "Billing",
      orientation: "Late fees",
      part: {
        title: "Late fees",
        lines: [
          [1, 1],
          [9, 20],
        ],
      },
    },
    {
      path: PATH,
      order: 1,
      category: "Billing",
      orientation: "Currency",
      part: { title: "Currency formatting", lines: [23] },
    },
  ],
};

// A throwaway repo holding `files` committed, then rewritten to `edits`; runs `fn` in it with HOME
// pointed inside, so a built review persists there.
async function withRepo<T>(
  files: Record<string, string>,
  edits: Record<string, string>,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "galley-rawdiff-")));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const g = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    g("init", "-q");
    g("config", "user.email", "t@t.co");
    g("config", "user.name", "tester");
    for (const [p, text] of Object.entries(files)) await fs.writeFile(path.join(root, p), text);
    g("add", ".");
    g("commit", "-qm", "init");
    for (const [p, text] of Object.entries(edits)) await fs.writeFile(path.join(root, p), text);
    return await fn(root);
  } finally {
    process.env.HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

// git's hunks for one file rewritten from `before` to `after`, read as the server reads them (the
// git() wrapper, then parseUnifiedDiff).
const gitHunks = (before: string, after: string): Promise<DiffHunk[]> =>
  withRepo({ "f.txt": before }, { "f.txt": after }, async (root) => {
    const [file] = parseUnifiedDiff(await git(["diff", "--no-ext-diff", "-M"], root));
    return file?.hunks ?? [];
  });

const keysOf = (fd: FileDiffMetadata) =>
  fd.hunks.flatMap((h) =>
    h.hunkContent.flatMap((part) => (part.type === "change" ? [changeStableKey(part)] : [])),
  );
const side = (name: string, contents: string, cacheKey = name) => ({ name, contents, cacheKey });

test("a file's blocks derive from git's hunks, so they carry the server's part, skim and hashes", async () => {
  const hunks = await gitHunks(OLD, NEW);
  // The fixture must be one jsdiff aligns differently from git, or this test proves nothing.
  const rediff = keysOf(parseDiffFromFile(side(PATH, OLD), side(PATH, NEW)));
  assert.notDeepEqual(rediff, GIT_KEYS, "@pierre's re-diff splits git's second block");

  // The server's blocks (state.ts assembleDiff), stamped as resolveParts stamps the guide above.
  const parts = [0, 0, 1];
  const server: ChangeState[] = hunks
    .flatMap((h) => changeBlocks(h))
    .map((block, i) => {
      const stableKey = changeStableKeyFromBlock(block);
      return {
        id: `${PATH}:${stableKey}`,
        path: PATH,
        hunkIndex: 0,
        stableKey,
        side: "additions",
        lineNumber: Number(stableKey.split(":")[1]),
        title: "",
        status: "pending",
        stageable: true,
        contentHash: `h${i}`,
        part: parts[i],
        ...(i === 1 ? { skim: { reason: "churn" } } : {}),
      };
    });
  assert.deepEqual(
    server.map((c) => c.stableKey),
    GIT_KEYS,
  );

  const fd = parseRawDiff(lib, hunks, side(PATH, OLD), side(PATH, NEW));
  assert.equal(fd.cacheKey, `${PATH}:${PATH}:git`, "parsed from git's patch, not re-diffed");
  const decisions = [
    { key: `${PATH}:additions:23:1:1`, status: "rejected" as const, path: PATH, lineNumber: 23 },
  ].map((d) => ({ ...d, side: "additions" as const, title: "" }));
  const derived = deriveChanges(fd, PATH, new Map(server.map((c) => [c.id, c])), decisions);
  assert.deepEqual(
    derived.map((c) => [c.stableKey, c.part, c.contentHash, c.stageable, c.skim, c.status]),
    [
      ["additions:1:0:2", 0, "h0", true, undefined, "pending"],
      ["additions:9:2:11", 0, "h1", true, { reason: "churn" }, "pending"],
      ["additions:23:1:1", 1, "h2", true, undefined, "rejected"],
    ],
  );
  // The full sides ride along, so the view can still expand the unchanged lines.
  assert.equal(fd.isPartial, false);
  assert.equal(fd.additionLines.length, NEW.split("\n").length - 1);
});

test("a guide part keeps every block it claims once the file opens", async () => {
  await withRepo({ [PATH]: OLD }, { [PATH]: NEW }, async (root) => {
    const state = await buildReviewState(root, { session: "s" });
    assert.ok(state, "built a review state for the working diff");
    assert.ok(resolveGuide(state, GUIDE).ok, "the guide's parts resolve");
    state.guide = GUIDE;
    const own = () => state.changes.filter((c) => c.path === PATH);
    assert.deepEqual(
      own().map((c) => [c.stableKey, c.part]),
      [
        ["additions:1:0:2", 0],
        ["additions:9:2:11", 0],
        ["additions:23:1:1", 1],
      ],
    );

    // What opening the file does (render.ts → changes.ts ensureChangesFromFileDiff).
    const file = state.files.find((f) => f.path === PATH)!;
    const { oldContents, newContents } = await readFileContents(state, file);
    const fd = parseRawDiff(lib, file.hunks, side(PATH, oldContents), side(PATH, newContents));
    const previous = new Map(own().map((c) => [c.id, c]));
    const derived = deriveChanges(fd, PATH, previous, state.decisions ?? []);
    assert.deepEqual(
      derived.map((c) => [c.id, c.part, c.contentHash]),
      own().map((c) => [c.id, c.part, c.contentHash]),
    );
    // The sidebar's steps: the two parts, and no "Rest of invoice.js".
    const plan = stepPlan(GUIDE.files, state.files, () => derived);
    assert.deepEqual(
      plan.listed.map((s) => [s.step.part, s.blocks?.map((c) => c.stableKey)]),
      [
        [0, ["additions:1:0:2", "additions:9:2:11"]],
        [1, ["additions:23:1:1"]],
      ],
    );
    assert.deepEqual(plan.other, [], "no Rest step");
  });
});

test("git's patch is rebuilt only while its hunks describe the two sides", async () => {
  const hunks = await gitHunks(OLD, NEW);
  assert.ok(gitPatch(PATH, PATH, hunks, OLD, NEW));
  // The working tree moved on since the diff (an edit not yet reloaded): a line added above a hunk,
  // one past the last hunk, a hunk line rewritten.
  const moved = [
    `// header\n${NEW}`,
    `${NEW}// footer\n`,
    NEW.replace("LATE_FEE_RATE = 0.015", "LATE_FEE_RATE = 0.02"),
  ];
  for (const after of moved) {
    assert.equal(gitPatch(PATH, PATH, hunks, OLD, after), null);
    // …so the tab re-diffs what it fetched, as before.
    const fd = parseRawDiff(lib, hunks, side(PATH, OLD), side(PATH, after));
    assert.deepEqual(keysOf(fd), keysOf(parseDiffFromFile(side(PATH, OLD), side(PATH, after))));
    assert.notEqual(fd.cacheKey, `${PATH}:${PATH}:git`);
  }
  // A block staged before the file was first opened: the old side now holds it.
  assert.equal(gitPatch(PATH, PATH, hunks, NEW, NEW), null, "identical sides");
  assert.equal(gitPatch(PATH, PATH, [], OLD, NEW), null, "no server hunks (an untracked add)");
});

test("git's patch marks a missing final newline as git does, on either side", async () => {
  const cases: Array<[string, string]> = [
    ["a\nb\nc", "a\nb\nC"], // neither side ends in a newline
    ["a\nb\nc\n", "a\nb\nc"], // the newline removed: the last line is a change
    ["a\nb\nc", "a\nb\nc\n"], // and added
    ["a\nb\nc\nd\ne\nf\ng\nh", "A\nb\nc\nd\ne\nf\ng\nh"], // a shared tail without one
    ["", "x\ny"], // a new file without one
  ];
  for (const [before, after] of cases) {
    const hunks = await gitHunks(before, after);
    const fd = parseRawDiff(lib, hunks, side("f.txt", before), side("f.txt", after));
    const rediff = parseDiffFromFile(side("f.txt", before), side("f.txt", after));
    const label = JSON.stringify([before, after]);
    assert.equal(fd.cacheKey, "f.txt:f.txt:git", `${label}: parsed from git's patch`);
    assert.deepEqual(keysOf(fd), keysOf(rediff), `${label}: blocks`);
    const eof = (d: FileDiffMetadata) =>
      d.hunks.map((h) => [h.noEOFCRDeletions, h.noEOFCRAdditions]);
    assert.deepEqual(eof(fd), eof(rediff), `${label}: no-newline markers`);
  }
});

test("a hunk whose trailing blank context the diff's trim dropped is completed from the sides", async () => {
  // The diff ends in blank context lines, which git()'s trimEnd strips from the parsed hunk.
  const before = "a\nb\nc\n\n\n";
  const after = "a\nB\nc\n\n\n";
  const hunks = await gitHunks(before, after);
  const lines = hunks[0]!.lines.length;
  assert.ok(lines < hunks[0]!.oldCount, "the parsed hunk is short of its header's count");
  const fd = parseRawDiff(lib, hunks, side("f.txt", before), side("f.txt", after));
  assert.equal(fd.cacheKey, "f.txt:f.txt:git");
  assert.deepEqual(keysOf(fd), ["additions:2:1:1"]);
  assert.equal(fd.hunks[0]!.additionCount, hunks[0]!.newCount);
});
