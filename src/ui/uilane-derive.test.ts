import { test } from "node:test";
import assert from "node:assert/strict";
import type { UiAnnotationRecord } from "./types";
import {
  annotationSource,
  firstLine,
  marksFor,
  mergeAgentReplies,
  nextNumber,
  openChangeCount,
  pageGroups,
  pageName,
  placeComposer,
  rowTitle,
  sourcePlace,
  stepFrom,
  stepOrder,
  waitingCount,
} from "./uilane-derive.js";

function ann(
  id: string,
  number: number,
  route: string,
  over: Partial<UiAnnotationRecord> = {},
): UiAnnotationRecord {
  return {
    id,
    number,
    intent: "change",
    status: "open",
    placement: "placed",
    page: {
      url: `http://localhost:3000${route}`,
      route,
      title: `${route} · App`,
      viewport: { width: 1280, height: 800, dpr: 1 },
    },
    target: {
      kind: "element",
      elements: [
        { selector: `#el-${id}`, tag: "button", rect: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    },
    comments: [
      {
        id: `${id}-m`,
        role: "user",
        intent: "action",
        body: `Body ${id}`,
        createdAt: "t",
        updatedAt: "t",
      },
    ],
    ...over,
  };
}

test("pages group on path + query, ordered by their lowest number; rows in number order", () => {
  const groups = pageGroups([
    ann("c", 3, "/files?tab=all"),
    ann("a", 1, "/files?tab=docs"),
    ann("b", 2, "/files?tab=all"),
    ann("d", 4, "/files?tab=docs", { status: "resolved" }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.route, g.open.map((a) => a.number), g.resolved.map((a) => a.number)]),
    [
      ["/files?tab=docs", [1], [4]],
      ["/files?tab=all", [2, 3], []],
    ],
  );
});

test("a page group whose annotations are all resolved still lists them, behind the toggle", () => {
  const [g] = pageGroups([ann("a", 1, "/x", { status: "resolved" })]);
  assert.deepEqual(g!.open, []);
  assert.equal(g!.resolved.length, 1);
});

test("a page is named by its title's first part, else its route", () => {
  assert.equal(pageName("File Management · Okafor — I-485", "/m"), "File Management");
  assert.equal(pageName("Matters | GrapeCase", "/m"), "Matters");
  assert.equal(pageName("Settings", "/s"), "Settings");
  assert.equal(pageName(undefined, "/app/matters?tab=files"), "/app/matters?tab=files");
  assert.equal(pageName("  ", "/s"), "/s");
});

test("counts, numbering, the row's first line and its tooltip", () => {
  const list = [ann("a", 1, "/"), ann("b", 7, "/", { status: "resolved" }), ann("c", 2, "/")];
  assert.equal(openChangeCount(list), 2);
  assert.equal(nextNumber(list, 7), 8);
  assert.equal(nextNumber([], 0), 1);
  // #9 was the newest and was deleted: the next is #10, not a second #9.
  assert.equal(nextNumber(list, 9), 10, "a deleted number is never reused");
  assert.equal(
    firstLine("\n\n**Make** `Upload` the _primary_ button\nsecond line"),
    "Make Upload the primary button",
  );
  assert.equal(firstLine("# Heading\nbody"), "Heading");
  assert.equal(firstLine("> quoted"), "quoted");
  assert.equal(rowTitle(list[0]!), "#1 · Change request");
  assert.equal(rowTitle(list[1]!), "#7 · Change request · Resolved");
});

test("⇧↓/⇧↑ step through the visible rows in list order and wrap", () => {
  const groups = pageGroups([
    ann("a", 1, "/p"),
    ann("b", 2, "/q"),
    ann("c", 3, "/p", { status: "resolved" }),
    ann("d", 4, "/q"),
  ]);
  assert.deepEqual(stepOrder(groups, new Set()), ["a", "b", "d"]);
  const order = stepOrder(groups, new Set(["/p"]));
  assert.deepEqual(order, ["a", "c", "b", "d"]);
  assert.equal(stepFrom(order, null, 1), "a");
  assert.equal(stepFrom(order, null, -1), "d");
  assert.equal(stepFrom(order, "c", 1), "b");
  assert.equal(stepFrom(order, "d", 1), "a");
  assert.equal(stepFrom(order, "a", -1), "d");
  assert.equal(stepFrom([], null, 1), null);
});

test("the page gets pins for its open annotations, and for a resolved one only while selected", () => {
  const list = [ann("a", 1, "/p"), ann("b", 2, "/q"), ann("c", 3, "/p", { status: "resolved" })];
  assert.deepEqual(marksFor(list, "/p", null), [
    { id: "a", number: 1, selector: "#el-a", resolved: false, question: false },
  ]);
  assert.equal(
    marksFor([ann("q", 4, "/p", { intent: "question" })], "/p", null)[0]!.question,
    true,
    "a question's pin is drawn as one",
  );
  assert.deepEqual(
    marksFor(list, "/p", "c").map((m) => [m.id, m.resolved]),
    [
      ["a", false],
      ["c", true],
    ],
  );
  assert.deepEqual(marksFor(list, "/elsewhere", "a"), []);
});

test("the composer sits right of its target, else left, else below or above, inside the stage", () => {
  const stage = { x: 0, y: 40, width: 1000, height: 700 };
  const card = { width: 300, height: 200 };
  // Room on the right.
  assert.deepEqual(placeComposer({ x: 100, y: 100, width: 50, height: 20 }, card, stage), {
    left: 162,
    top: 100,
  });
  // No room right: left of it.
  assert.deepEqual(placeComposer({ x: 800, y: 100, width: 150, height: 20 }, card, stage), {
    left: 488,
    top: 100,
  });
  // A wide target: below it.
  assert.deepEqual(placeComposer({ x: 10, y: 100, width: 980, height: 50 }, card, stage), {
    left: 10,
    top: 162,
  });
  // Wide and near the bottom: above it.
  assert.deepEqual(placeComposer({ x: 10, y: 600, width: 980, height: 50 }, card, stage), {
    left: 10,
    top: 388,
  });
  // Clamped inside the stage.
  assert.deepEqual(placeComposer({ x: 100, y: 690, width: 50, height: 20 }, card, stage), {
    left: 162,
    top: 532,
  });
});

test("a source shows its last two path segments and line, and opens repo-relative", () => {
  const root = "/home/dev/shop";
  const file = `${root}/apps/web/app/components/Files/Toolbar.vue`;
  assert.deepEqual(
    sourcePlace(
      { file, line: 41, column: 7, component: "Toolbar", vendor: true, via: "vue-tracer" },
      `${root}/`,
    ),
    {
      label: "Files/Toolbar.vue:41",
      path: "apps/web/app/components/Files/Toolbar.vue",
      line: 41,
      title:
        "Toolbar\napps/web/app/components/Files/Toolbar.vue:41:7\nA library component renders it; this is where the app uses it",
    },
  );
  assert.deepEqual(sourcePlace({ file, component: "Toolbar", via: "vue-file" }, root), {
    label: "Files/Toolbar.vue",
    path: "apps/web/app/components/Files/Toolbar.vue",
    line: 1,
    title: "Toolbar\napps/web/app/components/Files/Toolbar.vue",
  });
  // Outside the repo (or climbing out of it) there's nothing the editor route will open.
  for (const outside of ["/home/dev/shop-old/X.vue", "/opt/X.vue", "../X.vue"])
    assert.equal(sourcePlace({ file: outside, via: "vue-file" }, root).path, null, outside);
  assert.equal(sourcePlace({ file: "app/X.vue", via: "vue-file" }, root).path, "app/X.vue");
});

test("a Windows source path opens repo-relative under a Windows root, and is never relative", () => {
  for (const file of ["C:/proj/src/a.vue", String.raw`C:\proj\src\a.vue`, "c:/proj/src/a.vue"]) {
    const place = sourcePlace({ file, line: 2, via: "vue-tracer" }, String.raw`C:\proj`);
    assert.equal(place.path, "src/a.vue", file);
    assert.equal(place.label, "src/a.vue:2", file);
  }
  for (const file of ["D:/proj/src/a.vue", String.raw`C:\other\a.vue`, "C:/proj-old/a.vue"])
    assert.equal(sourcePlace({ file, via: "vue-file" }, "C:/proj").path, null, file);
  assert.equal(
    sourcePlace({ file: String.raw`src\a.vue`, via: "vue-file" }, "C:/proj").path,
    "src/a.vue",
  );
  assert.equal(sourcePlace({ file: String.raw`..\a.vue`, via: "vue-file" }, "C:/proj").path, null);
});

test("an annotation's source is its first element's that has one", () => {
  const src = { file: "/r/a.vue", line: 3, via: "vue-tracer" as const };
  const el = (source?: typeof src) => ({
    selector: "b",
    tag: "b",
    rect: { x: 0, y: 0, width: 1, height: 1 },
    ...(source ? { source } : {}),
  });
  assert.equal(annotationSource({ kind: "element", elements: [el()] }), undefined);
  assert.deepEqual(annotationSource({ kind: "element", elements: [el(), el(src)] }), src);
});

// ── Questions ───────────────────────────────────────────────────────────────────────────────────
type Message = UiAnnotationRecord["comments"][number];
const msg = (id: string, role: "user" | "agent", at: string, intent?: Message["intent"]) => ({
  id,
  role,
  intent,
  body: `${role} ${id}`,
  createdAt: at,
  updatedAt: at,
});
const T0 = "2026-10-13T10:00:00.000Z";
const T1 = "2026-10-13T10:01:00.000Z";

test("a question waits until an agent reply follows it; the head counts it and the tooltip says so", () => {
  const waiting = ann("q", 2, "/", {
    intent: "question",
    comments: [msg("q1", "user", T0, "question")],
  });
  const answered = ann("r", 3, "/", {
    intent: "question",
    comments: [msg("r1", "user", T0, "question"), msg("r2", "agent", T1)],
  });
  const replied = ann("c", 1, "/", {
    comments: [msg("c1", "user", T0, "action"), msg("c2", "agent", T1)],
  });
  // Asked in a change request's thread, after the agent's last reply.
  const askedInChange = ann("d", 4, "/", {
    comments: [
      msg("d1", "user", T0, "action"),
      msg("d2", "agent", T0),
      msg("d3", "user", T1, "question"),
    ],
  });
  const resolved = ann("e", 5, "/", {
    intent: "question",
    status: "resolved",
    comments: [msg("e1", "user", T0, "question")],
  });
  const list = [waiting, answered, replied, askedInChange, resolved];
  assert.equal(waitingCount(list), 2, "the open, unanswered ones");
  assert.equal(openChangeCount(list), 2, "questions aren't change requests");
  assert.deepEqual(list.map(rowTitle), [
    "#2 · Question · Waiting",
    "#3 · Question · Answered",
    "#1 · Change request · Agent replied",
    "#4 · Change request · Waiting",
    "#5 · Question · Resolved",
  ]);
});

test("a question whose thread requests a change counts as an open change request, as the Send sends it", () => {
  const requested = ann("q", 1, "/", {
    intent: "question",
    comments: [
      msg("q1", "user", T0, "question"),
      msg("q2", "agent", T1),
      msg("q3", "user", T1, "action"),
    ],
  });
  const asked = ann("r", 2, "/", {
    intent: "question",
    comments: [msg("r1", "user", T0, "question")],
  });
  assert.equal(openChangeCount([requested, asked]), 1);
  assert.equal(openChangeCount([{ ...requested, status: "resolved" }]), 0);
});

test("the poll's agent replies join the tab's threads once, and nothing else from it does", () => {
  const local = [ann("a", 1, "/"), ann("b", 2, "/")];
  const server = [
    ann("a", 1, "/", {
      comments: [
        local[0]!.comments[0]!,
        // A message of the reviewer's the tab no longer has (deleted, its save not landed yet).
        msg("gone", "user", T0, "action"),
        msg("r1", "agent", T1),
      ],
    }),
    // An annotation the tab deleted.
    ann("c", 3, "/", { comments: [msg("c1", "user", T0, "action"), msg("r2", "agent", T1)] }),
  ];
  assert.equal(mergeAgentReplies(local, server), 1);
  assert.deepEqual(
    local[0]!.comments.map((m) => m.id),
    ["a-m", "r1"],
  );
  assert.equal(mergeAgentReplies(local, server), 0, "a reply the tab has isn't added again");
  assert.equal(local[0]!.comments.length, 2);
});
