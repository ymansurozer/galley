import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  captureWaits,
  forwardedKeyRuns,
  readBridgeMessage,
  reloadRan,
  routeFromInput,
  settledWithin,
} from "./appnav";

const TOKEN = "t0k";

test("readBridgeMessage accepts a well-formed report carrying the token", () => {
  assert.deepEqual(
    readBridgeMessage(
      {
        type: "nav",
        token: TOKEN,
        route: "/app?x=1",
        title: "App",
        canGoBack: true,
        canGoForward: false,
      },
      TOKEN,
    ),
    {
      type: "nav",
      token: TOKEN,
      route: "/app?x=1",
      title: "App",
      canGoBack: true,
      canGoForward: false,
    },
  );
  assert.deepEqual(readBridgeMessage({ type: "leave", token: TOKEN }, TOKEN), {
    type: "leave",
    token: TOKEN,
  });
});

test("readBridgeMessage drops anything without the right token or shape", () => {
  const nav = { type: "ready", route: "/", title: "", canGoBack: null, canGoForward: null };
  assert.equal(readBridgeMessage({ ...nav, token: "other" }, TOKEN), null);
  assert.equal(readBridgeMessage({ ...nav }, TOKEN), null);
  assert.equal(readBridgeMessage({ ...nav, token: TOKEN, type: "navigate" }, TOKEN), null);
  assert.equal(
    readBridgeMessage({ ...nav, token: TOKEN, route: "https://evil.example/" }, TOKEN),
    null,
  );
  assert.equal(readBridgeMessage({ ...nav, token: TOKEN, route: 42 }, TOKEN), null);
  assert.equal(readBridgeMessage("ready", TOKEN), null);
  assert.equal(readBridgeMessage(null, TOKEN), null);
});

test("readBridgeMessage caps page-sourced strings and coerces junk flags to null", () => {
  const msg = readBridgeMessage(
    {
      type: "ready",
      token: TOKEN,
      route: "/" + "a".repeat(5000),
      title: "t".repeat(1000),
      canGoBack: "yes",
      canGoForward: 1,
    },
    TOKEN,
  );
  assert.ok(msg && msg.type === "ready");
  assert.equal(msg.route.length, 2048);
  assert.equal(msg.title.length, 300);
  assert.equal(msg.canGoBack, null);
  assert.equal(msg.canGoForward, null);
});

const png = (bytes = 8) => new Blob([new Uint8Array(bytes)], { type: "image/png" });

test("readBridgeMessage accepts a capture reply carrying PNG blobs or an error", () => {
  const viewport = png();
  const crop = png();
  assert.deepEqual(
    readBridgeMessage(
      { type: "captured", token: TOKEN, id: 3, shot: { viewport, crop, ms: 412 } },
      TOKEN,
    ),
    { type: "captured", token: TOKEN, id: 3, shot: { viewport, crop, ms: 412 } },
  );
  assert.deepEqual(
    readBridgeMessage(
      { type: "captured", token: TOKEN, id: 4, shot: { viewport, crop: null, ms: 0 } },
      TOKEN,
    ),
    { type: "captured", token: TOKEN, id: 4, shot: { viewport, crop: null, ms: 0 } },
  );
  const failed = readBridgeMessage(
    { type: "captured", token: TOKEN, id: 5, error: "x".repeat(1000) },
    TOKEN,
  );
  assert.ok(failed && failed.type === "captured" && "error" in failed);
  assert.equal(failed.error.length, 300);
});

test("readBridgeMessage drops a capture reply that isn't PNGs within the size cap", () => {
  const ok = { type: "captured", token: TOKEN, id: 1 };
  const shot = { viewport: png(), crop: null, ms: 10 };
  assert.equal(
    readBridgeMessage({ ...ok, shot: { ...shot, viewport: "data:image/png;base64," } }, TOKEN),
    null,
  );
  assert.equal(
    readBridgeMessage(
      { ...ok, shot: { ...shot, viewport: new Blob(["<svg/>"], { type: "image/svg+xml" }) } },
      TOKEN,
    ),
    null,
  );
  assert.equal(
    readBridgeMessage({ ...ok, shot: { ...shot, crop: png(32 * 1024 * 1024 + 1) } }, TOKEN),
    null,
  );
  assert.equal(readBridgeMessage({ ...ok, shot: { ...shot, ms: Number.NaN } }, TOKEN), null);
  assert.equal(readBridgeMessage({ ...ok, id: "1", shot }, TOKEN), null);
  assert.equal(readBridgeMessage({ ...ok }, TOKEN), null);
  assert.equal(readBridgeMessage({ ...ok, token: "other", shot }, TOKEN), null);
});

const element = (over: Record<string, unknown> = {}) => ({
  selector: 'button[data-testid="upload"]',
  tag: "button",
  text: "Upload",
  role: "button",
  name: "Upload",
  attrs: { "data-testid": "upload" },
  landmark: "main",
  heading: "Files",
  outline: '<button data-testid="upload">Upload</button>',
  rect: { x: 10, y: 20, width: 90, height: 32 },
  ...over,
});
const picked = (over: Record<string, unknown> = {}, el = element()) => ({
  type: "picked",
  token: TOKEN,
  page: { route: "/app/files", title: "Files", viewport: { width: 1280, height: 800, dpr: 2 } },
  target: { kind: "element", elements: [el] },
  ...over,
});

test("readBridgeMessage takes the placements the bridge found, dropping malformed ones", () => {
  const placements = [
    { id: "a1", placement: "placed" },
    { id: "a2", placement: "unplaced" },
  ];
  assert.deepEqual(readBridgeMessage({ type: "placements", token: TOKEN, placements }, TOKEN), {
    type: "placements",
    token: TOKEN,
    placements,
  });
  const junk = [
    "a1",
    { id: "a3", placement: "unvisited" }, // only the desk says unvisited
    { id: "a4", placement: "lost" },
    { id: 4, placement: "placed" },
    { id: "x".repeat(65), placement: "placed" },
    { id: "a5", placement: "placed", extra: "<b>" },
  ];
  assert.deepEqual(
    readBridgeMessage({ type: "placements", token: TOKEN, placements: junk }, TOKEN),
    { type: "placements", token: TOKEN, placements: [{ id: "a5", placement: "placed" }] },
  );
  const flood = Array.from({ length: 5000 }, (_, i) => ({ id: `a${i}`, placement: "placed" }));
  const capped = readBridgeMessage({ type: "placements", token: TOKEN, placements: flood }, TOKEN);
  assert.equal(capped?.type === "placements" && capped.placements.length, 1000);
  assert.equal(
    readBridgeMessage({ type: "placements", token: TOKEN, placements: {} }, TOKEN),
    null,
  );
  assert.equal(readBridgeMessage({ type: "placements", token: "other", placements }, TOKEN), null);
});

test("readBridgeMessage accepts a picked element as the bridge describes it", () => {
  assert.deepEqual(readBridgeMessage(picked(), TOKEN), picked());
});

test("readBridgeMessage caps a picked element's page-sourced strings", () => {
  const attrs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`data-a${i}`, "v"]));
  const msg = readBridgeMessage(
    picked(
      { page: { route: "/x", title: "t".repeat(400), viewport: { width: 1, height: 1, dpr: 1 } } },
      element({
        text: "x".repeat(900),
        name: "n".repeat(900),
        heading: "h".repeat(900),
        outline: "o".repeat(9000),
        attrs: { ...attrs, href: "h".repeat(900) },
      }),
    ),
    TOKEN,
  );
  assert.ok(msg && msg.type === "picked" && msg.target.kind === "element");
  const el = msg.target.elements[0]!;
  assert.equal(msg.page.title!.length, 300);
  assert.equal(el.text!.length, 300);
  assert.ok(el.text!.endsWith("…"));
  assert.equal(el.name!.length, 200);
  assert.equal(el.heading!.length, 200);
  assert.equal(el.outline!.length, 2048);
  assert.equal(Object.keys(el.attrs!).length, 12);
  assert.ok(Object.values(el.attrs!).every((v) => v.length <= 200));
});

test("readBridgeMessage drops a malformed pick", () => {
  const bad = [
    picked({ page: { route: "//evil.example/", viewport: { width: 1, height: 1, dpr: 1 } } }),
    picked({ page: { route: "/x", viewport: { width: 0, height: 1, dpr: 1 } } }),
    picked({ target: { kind: "region", elements: [element()] } }),
    picked({ target: { kind: "element", elements: [] } }),
    picked({}, element({ selector: "x".repeat(513) })),
    picked({}, element({ selector: 7 })),
    picked({}, element({ tag: "<img onerror>" })),
    picked({}, element({ rect: { x: 1, y: 2, width: "3", height: 4 } })),
  ];
  for (const msg of bad) assert.equal(readBridgeMessage(msg, TOKEN), null, JSON.stringify(msg));
});

test("readBridgeMessage accepts several elements, a region and a text selection as picked", () => {
  const second = element({ selector: "#cancel", text: "Cancel", name: "Cancel" });
  const rect = { x: 5, y: 10, width: 300, height: 120 };
  for (const target of [
    { kind: "element", elements: [element(), second] },
    { kind: "region", rect, elements: [element(), second] },
    { kind: "region", rect, elements: [] },
    {
      kind: "text",
      quote: "Date recieved",
      element: element({ tag: "th", selector: "#received" }),
    },
  ]) {
    const msg = picked({ target });
    assert.deepEqual(readBridgeMessage(msg, TOKEN), msg, target.kind);
  }
});

test("readBridgeMessage caps a picked quote at 500 characters", () => {
  const msg = readBridgeMessage(
    picked({ target: { kind: "text", quote: "q".repeat(900), element: element() } }),
    TOKEN,
  );
  assert.ok(msg?.type === "picked" && msg.target.kind === "text");
  assert.equal(msg.target.quote.length, 500);
  assert.ok(msg.target.quote.endsWith("…"));
});

test("readBridgeMessage drops a malformed region or text pick, and a page the page claims", () => {
  const rect = { x: 5, y: 10, width: 300, height: 120 };
  const bad = [
    { kind: "region", elements: [element()] },
    { kind: "region", rect: { ...rect, width: 0 }, elements: [] },
    { kind: "region", rect: { ...rect, x: Number.NaN }, elements: [] },
    { kind: "region", rect },
    { kind: "region", rect, elements: [element(), element({ selector: "" })] },
    { kind: "text", element: element() },
    { kind: "text", quote: "", element: element() },
    { kind: "text", quote: "   ", element: element() },
    { kind: "text", quote: 42, element: element() },
    { kind: "text", quote: "Due" },
    { kind: "text", quote: "Due", element: element({ tag: "<b>" }) },
    { kind: "page" },
    { kind: "canvas", rect },
  ];
  for (const target of bad)
    assert.equal(readBridgeMessage(picked({ target }), TOKEN), null, JSON.stringify(target));
});

test("readBridgeMessage reads how many ⇧-picks are waiting", () => {
  const pending = (count: unknown) => ({ type: "pending", token: TOKEN, count });
  for (const count of [0, 3, 16])
    assert.deepEqual(readBridgeMessage(pending(count), TOKEN), pending(count));
  for (const count of [-1, 17, 1.5, "2", null])
    assert.equal(readBridgeMessage(pending(count), TOKEN), null, JSON.stringify(count));
});

test("readBridgeMessage keeps a picked element's source, capped, and drops a malformed one", () => {
  const source = (over: Record<string, unknown> = {}) => ({
    file: "/home/dev/shop/apps/web/app/pages/files.vue",
    line: 20,
    column: 7,
    component: "files",
    vendor: true,
    via: "vue-tracer",
    ...over,
  });
  const read = (s: unknown) => {
    const msg = readBridgeMessage(picked({}, element({ source: s })), TOKEN);
    assert.ok(
      msg && msg.type === "picked" && msg.target.kind === "element",
      "the element stands either way",
    );
    return msg.target.elements[0]!.source;
  };
  assert.deepEqual(read(source()), source());
  assert.deepEqual(read({ file: "app/pages/files.vue", via: "vue-file" }), {
    file: "app/pages/files.vue",
    via: "vue-file",
  });
  const long = read(source({ component: "c".repeat(500), vendor: "yes" }))!;
  assert.equal(long.component!.length, 200);
  assert.equal(long.vendor, undefined, "vendor is true or absent");
  for (const bad of [
    "app/pages/files.vue",
    source({ file: "f".repeat(1025) }),
    source({ file: "" }),
    source({ file: "a.vue\n" }),
    source({ via: "react" }),
    source({ line: 0 }),
    source({ line: 2.5 }),
    source({ column: "7" }),
  ])
    assert.equal(read(bad), undefined, JSON.stringify(bad));
});

test("readBridgeMessage refuses a route that would leave the app's origin", () => {
  const nav = { type: "nav", token: TOKEN, title: "", canGoBack: null, canGoForward: null };
  // The URL parser reads a backslash in the path as a slash: `/\evil.example` is `//evil.example`.
  for (const route of [String.raw`/\evil.example/x`, "/app\nx", "/app\u0000"]) {
    assert.equal(readBridgeMessage({ ...nav, route }, TOKEN), null, JSON.stringify(route));
    const page = { route, viewport: { width: 1, height: 1, dpr: 1 } };
    assert.equal(readBridgeMessage(picked({ page }), TOKEN), null, JSON.stringify(route));
  }
  // In the query a backslash is just data.
  assert.ok(readBridgeMessage({ ...nav, route: String.raw`/search?q=a\b` }, TOKEN));
});

const key = (k: string, code: string, shiftKey = false, altKey = false) => ({
  type: "key",
  token: TOKEN,
  key: k,
  code,
  shiftKey,
  altKey,
});

test("readBridgeMessage passes up only the UI view's keys, never ones that send, reset or confirm", () => {
  for (const ok of [
    key("L", "KeyL", true),
    key("U", "KeyU", true),
    key("ArrowDown", "ArrowDown", true),
    key("ArrowUp", "ArrowUp", true),
    key("Escape", "Escape"),
  ])
    assert.deepEqual(readBridgeMessage(ok, TOKEN), ok);
  // ⌥A and ⌥P by their codes (a Mac layout types "å" and "π"), handed on as plain ⌥A and ⌥P.
  assert.deepEqual(
    readBridgeMessage(key("å", "KeyA", false, true), TOKEN),
    key("a", "KeyA", false, true),
  );
  assert.deepEqual(
    readBridgeMessage(key("π", "KeyP", false, true), TOKEN),
    key("p", "KeyP", false, true),
  );
  for (const forged of [
    key("R", "KeyR", true), // ⇧R: reset the review
    key("Enter", "Enter"), // confirms the dialog ⇧R opens
    key("S", "KeyS", true), // ⇧S: send
    key("A", "KeyA", true), // ⇧A: approve
    key("P", "KeyP", true, true),
    key("Escape", "Escape", true),
    key("x".repeat(40), "KeyX"),
  ])
    assert.equal(readBridgeMessage(forged, TOKEN), null, JSON.stringify(forged));
  assert.equal(readBridgeMessage({ ...key("L", "KeyL", true), shiftKey: "yes" }, TOKEN), null);
});

test("a forwarded key runs only while annotating, except ⌥A", () => {
  const altA = { key: "a", code: "KeyA", shiftKey: false, altKey: true };
  const altP = { key: "p", code: "KeyP", shiftKey: false, altKey: true };
  const shiftL = { key: "L", code: "KeyL", shiftKey: true, altKey: false };
  const escape = { key: "Escape", code: "Escape", shiftKey: false, altKey: false };
  assert.equal(forwardedKeyRuns(altA, "interact"), true);
  assert.equal(forwardedKeyRuns(altP, "interact"), false);
  assert.equal(forwardedKeyRuns(shiftL, "interact"), false);
  assert.equal(forwardedKeyRuns(escape, "interact"), false, "in Interact, Esc belongs to the app");
  assert.equal(forwardedKeyRuns(altP, "annotate"), true);
  assert.equal(forwardedKeyRuns(shiftL, "annotate"), true);
  assert.equal(forwardedKeyRuns(escape, "annotate"), true);
});

test("a moved reload counter is the agent's `galley reload`, diff or no diff; a new desk process isn't", () => {
  const desk = (token: string | undefined, generation: number) => ({ token, generation });
  // A UI-only desk: the diff stays empty, so the counter is all that says the agent is back.
  assert.equal(reloadRan(desk("t1", 3), desk("t1", 4)), true);
  assert.equal(reloadRan(desk("t1", 4), desk("t1", 4)), false, "no reload since the last poll");
  // A desk without a UI target has no proxy token; its counter moves the same way.
  assert.equal(reloadRan(desk(undefined, 0), desk(undefined, 1)), true);
  // A restarted desk (new token) counts from 0 again, and the tab's first poll meets the first
  // token it sees: both are a baseline, not a reload.
  assert.equal(reloadRan(desk("t1", 5), desk("t2", 0)), false);
  assert.equal(reloadRan(desk(undefined, 0), desk("t1", 2)), false);
  // Without a UI target there's no token to change, so a counter that went back is the restart.
  assert.equal(reloadRan(desk(undefined, 3), desk(undefined, 0)), false);
  assert.equal(reloadRan(desk(undefined, 3), desk(undefined, 1)), false);
});

test("readBridgeMessage reads pin clicks and anchor moves", () => {
  const select = { type: "select", token: TOKEN, id: "a-1" };
  assert.deepEqual(readBridgeMessage(select, TOKEN), select);
  assert.equal(readBridgeMessage({ ...select, id: 3 }, TOKEN), null);
  const anchor = { type: "anchor", token: TOKEN, rect: { x: 1, y: 2, width: 3, height: 4 } };
  assert.deepEqual(readBridgeMessage(anchor, TOKEN), anchor);
  assert.equal(readBridgeMessage({ ...anchor, rect: { x: 1 } }, TOKEN), null);
});

const shot = () => ({ viewport: png(), crop: null, ms: 5 });

test("captureWaits settles a capture with its own reply, once", async () => {
  const waits = captureWaits(30_000);
  const a = waits.wait(1);
  const b = waits.wait(2);
  const shotB = shot();
  waits.settle(2, shotB);
  waits.settle(2, new Error("late duplicate"));
  waits.settle(99, shot());
  assert.equal(await b, shotB);
  waits.settle(1, new Error("render failed"));
  await assert.rejects(a, { message: "render failed" });
});

test("captureWaits.abandon fails every pending capture at once", async () => {
  const waits = captureWaits(30_000);
  const a = waits.wait(1);
  const b = waits.wait(2);
  waits.abandon("The app page navigated away during the capture");
  waits.settle(1, shot());
  await assert.rejects(a, { message: "The app page navigated away during the capture" });
  await assert.rejects(b, { message: "The app page navigated away during the capture" });
});

test("captureWaits times a capture out when no reply comes", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const waits = captureWaits(30_000);
  let outcome = "pending";
  const a = waits.wait(1).then(
    () => (outcome = "resolved"),
    (err: Error) => (outcome = err.message),
  );
  mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(outcome, "pending");
  mock.timers.tick(1);
  await a;
  assert.equal(outcome, "The app page didn't answer the capture");
});

test("settledWithin waits for every piece of work, failed ones included, up to its cap", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  // setImmediate isn't mocked: it runs once every queued promise job has.
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let finishA!: () => void;
  let failB!: (e: Error) => void;
  const a = new Promise<void>((resolve) => (finishA = resolve));
  const b = new Promise<void>((_, reject) => (failB = reject));
  let outcome: boolean | "pending" = "pending";
  void settledWithin([a, b], 15_000).then((done) => (outcome = done));
  finishA();
  await flush();
  assert.equal(outcome, "pending", "b is still out");
  failB(new Error("upload failed"));
  await flush();
  assert.equal(outcome, true);

  // Work that outlasts the cap: the wait gives up at the cap.
  let late: boolean | "pending" = "pending";
  void settledWithin([new Promise(() => {})], 15_000).then((done) => (late = done));
  mock.timers.tick(14_999);
  await flush();
  assert.equal(late, "pending");
  mock.timers.tick(1);
  await flush();
  assert.equal(late, false);

  assert.equal(await settledWithin([], 15_000), true, "nothing to wait for");
});

test("routeFromInput turns what the reviewer typed into a same-app route", () => {
  const origins = ["http://localhost:3000", "http://127.0.0.1:45000"];
  assert.equal(routeFromInput("/app/matters?tab=files", origins), "/app/matters?tab=files");
  assert.equal(routeFromInput("  app/settings ", origins), "/app/settings");
  assert.equal(routeFromInput("http://localhost:3000/app#x", origins), "/app#x");
  assert.equal(routeFromInput("http://127.0.0.1:45000/a?b=1", origins), "/a?b=1");
  assert.equal(routeFromInput("https://example.com/", origins), null, "another site stays out");
  assert.equal(routeFromInput("//example.com/x", origins), null);
  assert.equal(routeFromInput("   ", origins), null);
});
