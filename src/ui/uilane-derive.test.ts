import { test } from "node:test";
import assert from "node:assert/strict";
import type { UiAnnotationRecord } from "./types";
import {
  annotationSource,
  draftAnchor,
  firstLine,
  keepPlacements,
  marksFor,
  mergeAgentReplies,
  nextNumber,
  openChangeCount,
  outlineClasses,
  pageGroups,
  pageMarks,
  pageName,
  placeComposer,
  rowTitle,
  sendSummary,
  sourcePlace,
  stepFrom,
  stepOrder,
  targetLabel,
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

test("a page is not checked while an open annotation on it hasn't been looked for since the reload", () => {
  const groups = pageGroups([
    ann("a", 1, "/p", { placement: "unvisited" }),
    ann("b", 2, "/p", { placement: "unplaced" }),
    ann("c", 3, "/q", { placement: "unplaced" }),
    ann("d", 4, "/r", { placement: "unvisited", status: "resolved" }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.route, g.unchecked]),
    [
      ["/p", true],
      ["/q", false],
      ["/r", false],
    ],
  );
  assert.deepEqual(
    groups[0]!.open.map((a) => a.id),
    ["a", "b"],
    "unplaced and unchecked rows stay in their page's list, in number order",
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
  assert.equal(
    rowTitle(ann("u", 3, "/", { placement: "unplaced" })),
    "#3 · Change request · Unplaced",
  );
  assert.equal(
    rowTitle(ann("v", 4, "/", { placement: "unvisited" })),
    "#4 · Change request · Not checked",
  );
  assert.equal(
    rowTitle(ann("w", 5, "/", { placement: "unplaced", status: "resolved" })),
    "#5 · Change request · Resolved",
  );
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
    {
      id: "a",
      number: 1,
      target: {
        kind: "element",
        elements: [{ selector: "#el-a", tag: "button", rect: { x: 0, y: 0, width: 1, height: 1 } }],
      },
      resolved: false,
      question: false,
    },
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

const uiEl = (selector: string, rect = { x: 0, y: 0, width: 1, height: 1 }) => ({
  selector,
  tag: "button",
  rect,
});

test("each kind's pin finds its target its own way, and a page annotation's pin is the desk's", () => {
  const rect = { x: 10, y: 20, width: 300, height: 100 };
  const list = [
    ann("e", 1, "/p", { target: { kind: "element", elements: [uiEl("#a"), uiEl("#b")] } }),
    ann("r", 2, "/p", {
      target: {
        kind: "region",
        rect,
        elements: [uiEl("#a", { x: 12, y: 30, width: 80, height: 20 })],
      },
    }),
    ann("bare", 3, "/p", { target: { kind: "region", rect, elements: [] } }),
    ann("t", 4, "/p", { target: { kind: "text", quote: "Date recieved", element: uiEl("#th") } }),
    ann("pg", 5, "/p", { target: { kind: "page" } }),
  ];
  const found = (selector: string, r = { x: 0, y: 0, width: 1, height: 1 }) => ({
    selector,
    tag: "button",
    rect: r,
  });
  assert.deepEqual(
    marksFor(list, "/p", null).map((m) => [m.id, m.target]),
    [
      ["e", { kind: "element", elements: [found("#a"), found("#b")] }],
      [
        "r",
        { kind: "region", rect, elements: [found("#a", { x: 12, y: 30, width: 80, height: 20 })] },
      ],
      ["bare", { kind: "region", rect, elements: [] }],
      ["t", { kind: "text", quote: "Date recieved", element: found("#th") }],
    ],
  );
  assert.deepEqual(pageMarks(list, "/p", null), [
    { id: "pg", number: 5, question: false, selected: false },
  ]);
  assert.deepEqual(pageMarks(list, "/q", null), []);
  const resolved = ann("pr", 6, "/p", { target: { kind: "page" }, status: "resolved" });
  assert.deepEqual(pageMarks([resolved], "/p", null), [], "a resolved page pin leaves the bar");
  assert.deepEqual(
    pageMarks([resolved], "/p", "pr").map((m) => [m.id, m.selected]),
    [["pr", true]],
    "until its revealed row is selected",
  );
});

test("a pin's target can be posted to the page while the store holds the annotation as a proxy", () => {
  // Alpine's store wraps every object in a reactive Proxy, which postMessage (structured clone)
  // refuses.
  const proxied = <T extends object>(o: T): T => new Proxy(o, {});
  const rect = proxied({ x: 10, y: 20, width: 300, height: 100 });
  const el = {
    ...uiEl("#a"),
    rect: proxied({ x: 12, y: 30, width: 80, height: 20 }),
    source: proxied({ file: "/app/pages/files.vue", line: 3, via: "vue-tracer" as const }),
  };
  const region = ann("r", 1, "/p", { target: { kind: "region", rect, elements: [proxied(el)] } });
  assert.doesNotThrow(() => structuredClone(marksFor([region], "/p", null)));
});

test("a pin carries what the bridge checks a match against: text, name, classes and source", () => {
  const source = { file: "/app/pages/files.vue", line: 41, column: 9, via: "vue-tracer" as const };
  const upload = {
    ...uiEl("div:nth-of-type(2) > button"),
    text: "Upload",
    name: "Upload",
    role: "button",
    heading: "Files",
    outline: `<button class="btn btn-primary w-full" type="button">Upload</button>`,
    source,
  };
  const [mark] = marksFor(
    [ann("u", 1, "/p", { target: { kind: "element", elements: [upload] } })],
    "/p",
    null,
  );
  assert.deepEqual(mark!.target, {
    kind: "element",
    elements: [
      {
        selector: "div:nth-of-type(2) > button",
        tag: "button",
        text: "Upload",
        name: "Upload",
        classes: ["btn", "btn-primary", "w-full"],
        source,
        rect: { x: 0, y: 0, width: 1, height: 1 },
      },
    ],
  });
});

test("an element's classes are read off its outline, without a class its cap cut short", () => {
  assert.deepEqual(outlineClasses(`<a class="nav-link active" href="/x">X</a>`), [
    "nav-link",
    "active",
  ]);
  assert.deepEqual(outlineClasses(`<div class="say &quot;hi&quot; a&amp;b">`), [
    "say",
    '"hi"',
    "a&b",
  ]);
  assert.deepEqual(outlineClasses(`<div class="card shadow-lg rounded-x…"><p>…</p></div>`), [
    "card",
    "shadow-lg",
  ]);
  assert.deepEqual(outlineClasses(`<div><p class="inner">x</p></div>`), [], "a child's aren't its");
  assert.deepEqual(outlineClasses(`<div>`), []);
  assert.deepEqual(outlineClasses(undefined), []);
});

test("the composer's head names each kind of target", () => {
  const save = { ...uiEl("#save"), role: "button", name: "Save" };
  assert.equal(targetLabel({ kind: "element", elements: [save] }), 'button · "Save"');
  assert.equal(
    targetLabel({ kind: "element", elements: [save, uiEl("#a"), uiEl("#b")] }),
    'button · "Save"',
    "the head counts the rest on its own, where a long name can't cut it off",
  );
  assert.equal(
    targetLabel({ kind: "element", elements: [{ selector: "p", tag: "p", rect: save.rect }] }),
    "p",
  );
  const rect = { x: 10.4, y: 20, width: 300.6, height: 99.5 };
  assert.equal(
    targetLabel({ kind: "region", rect, elements: [save] }),
    "Region 301 × 100 · 1 element",
  );
  assert.equal(targetLabel({ kind: "region", rect, elements: [] }), "Region 301 × 100");
  assert.equal(
    targetLabel({
      kind: "text",
      quote: "Date recieved",
      element: { ...uiEl("#th"), role: "columnheader" },
    }),
    "Text in columnheader",
  );
  assert.equal(targetLabel({ kind: "page" }), "Whole page");
});

test("a new pick's composer starts beside all of it; a page's has no anchor", () => {
  const a = { x: 100, y: 50, width: 80, height: 20 };
  const b = { x: 300, y: 200, width: 40, height: 40 };
  assert.deepEqual(draftAnchor({ kind: "element", elements: [uiEl("#a", a), uiEl("#b", b)] }), {
    x: 100,
    y: 50,
    width: 240,
    height: 190,
  });
  const rect = { x: 10, y: 20, width: 300, height: 100 };
  assert.deepEqual(draftAnchor({ kind: "region", rect, elements: [uiEl("#a", a)] }), rect);
  assert.deepEqual(draftAnchor({ kind: "text", quote: "q", element: uiEl("#a", a) }), a);
  assert.equal(draftAnchor({ kind: "page" }), null);
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
  // No target (the whole page): the stage's top right.
  assert.deepEqual(placeComposer(null, card, stage), { left: 692, top: 48 });
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
  const rect = { x: 0, y: 0, width: 9, height: 9 };
  assert.deepEqual(annotationSource({ kind: "region", rect, elements: [el(), el(src)] }), src);
  assert.deepEqual(annotationSource({ kind: "text", quote: "q", element: el(src) }), src);
  assert.equal(annotationSource({ kind: "page" }), undefined);
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
  const answered = ann("s", 3, "/b", {
    intent: "question",
    comments: [msg("s1", "user", T0, "question"), msg("s2", "agent", T1)],
  });
  assert.equal(openChangeCount([requested, asked]), 1);
  assert.equal(openChangeCount([{ ...requested, status: "resolved" }]), 0);
  // The Send dialog agrees: the escalated question goes as a change request, not as answered.
  assert.deepEqual(
    sendSummary([requested, asked, answered, ann("t", 4, "/", { status: "resolved" })]),
    {
      ui: "1 change request on 1 page · 1 open question",
      uiNotSent: "Not sent: 1 resolved · 1 answered question",
    },
  );
  assert.deepEqual(sendSummary([]), { ui: "No change requests", uiNotSent: "" });
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

test("adopting the desk's state after a reload keeps the placements the tab has looked for since", () => {
  // The tab saw the reload, marked everything unvisited and asked the page to look again; the
  // page answered while the desk's state, read before that answer was saved, was on its way.
  const local = [
    ann("a", 1, "/", { placement: "placed" }),
    ann("b", 2, "/", { placement: "unplaced" }),
    ann("c", 3, "/other", { placement: "unvisited" }),
  ];
  const server = [
    ann("a", 1, "/", { placement: "unvisited" }),
    ann("b", 2, "/", { placement: "unvisited" }),
    ann("c", 3, "/other", { placement: "placed" }),
    ann("d", 4, "/", { placement: "unvisited" }),
  ];
  keepPlacements(server, local);
  assert.deepEqual(
    server.map((a) => a.placement),
    // c: the tab hasn't looked, so the desk's copy stands; d: the tab doesn't have it.
    ["placed", "unplaced", "placed", "unvisited"],
  );
});
