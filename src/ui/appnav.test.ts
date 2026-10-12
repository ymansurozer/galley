import { test } from "node:test";
import assert from "node:assert/strict";

import { readBridgeMessage, routeFromInput } from "./appnav";

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
