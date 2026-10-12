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
