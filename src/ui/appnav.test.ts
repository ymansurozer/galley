import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { captureWaits, forwardedKeyRuns, readBridgeMessage, routeFromInput } from "./appnav";

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
  assert.ok(msg && msg.type === "picked");
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
    assert.ok(msg && msg.type === "picked", "the element stands either way");
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
  // ⌥A by its code (a Mac layout types "å"), handed on as plain ⌥A.
  assert.deepEqual(
    readBridgeMessage(key("å", "KeyA", false, true), TOKEN),
    key("a", "KeyA", false, true),
  );
  for (const forged of [
    key("R", "KeyR", true), // ⇧R: reset the review
    key("Enter", "Enter"), // confirms the dialog ⇧R opens
    key("S", "KeyS", true), // ⇧S: send
    key("A", "KeyA", true), // ⇧A: approve
    key("Escape", "Escape", true),
    key("x".repeat(40), "KeyX"),
  ])
    assert.equal(readBridgeMessage(forged, TOKEN), null, JSON.stringify(forged));
  assert.equal(readBridgeMessage({ ...key("L", "KeyL", true), shiftKey: "yes" }, TOKEN), null);
});

test("a forwarded key runs only while annotating, except ⌥A", () => {
  const altA = { key: "a", code: "KeyA", shiftKey: false, altKey: true };
  const shiftL = { key: "L", code: "KeyL", shiftKey: true, altKey: false };
  const escape = { key: "Escape", code: "Escape", shiftKey: false, altKey: false };
  assert.equal(forwardedKeyRuns(altA, "interact"), true);
  assert.equal(forwardedKeyRuns(shiftL, "interact"), false);
  assert.equal(forwardedKeyRuns(escape, "interact"), false, "in Interact, Esc belongs to the app");
  assert.equal(forwardedKeyRuns(shiftL, "annotate"), true);
  assert.equal(forwardedKeyRuns(escape, "annotate"), true);
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
