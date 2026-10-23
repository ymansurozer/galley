import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

// Run the real browser modules together, including status stripping and iframe navigation.
// Only the cross-origin page boundary is simulated; desk state and annotation rendering are real.
test("status adoption refreshes only a signaled app, retaining route and desk state", async () => {
  const bundle = await build({
    stdin: {
      contents:
        'import {S} from "./store"; import {adoptDeskStatus} from "./poll"; import {setView,appRefresh} from "./appview"; import {renderMarkdown} from "./markdown"; window.harness={S,adoptDeskStatus,setView,appRefresh,renderMarkdown};',
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
  });
  const win = new Window({
    url: "http://localhost:41000/",
    settings: {
      disableIframePageLoading: true,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  try {
    win.document.body.innerHTML =
      '<div id="appFrame"></div><div id="appStage"></div><div id="pinCard"></div><div id="uiComposer"></div>';
    win.eval(bundle.outputFiles[0]!.text);
    const { S, adoptDeskStatus, setView, appRefresh } = (win as any).harness;
    const readyBy = Date.now() + 10_000;
    while (!(win as any).harness.renderMarkdown("**ready**").includes("<strong>")) {
      assert.ok(Date.now() < readyBy, "markdown renderer becomes ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    S.state = {
      ui: { target: "http://localhost:3000/entry?sign-in=x" },
      files: [],
      annotations: [],
      comments: [],
    };
    const proxy = { port: 41001, token: "first" };
    const status = (
      reloadGeneration: number,
      uiRefreshGeneration: number,
      uiProxy: typeof proxy | null = proxy,
    ) => ({ reloadGeneration, uiRefreshGeneration, uiProxy });
    assert.deepEqual(Object.keys(adoptDeskStatus({ ...status(7, 4), baseDiffHash: "hash" })), [
      "baseDiffHash",
    ]);
    setView("ui");
    const frame = win.document.querySelector("#appFrame iframe")! as any;
    assert.equal(frame.src, "http://localhost:41001/entry?sign-in=x");
    S.app.route = "/current?filter=two#row";
    S.app.connected = true;
    S.selectedAnnotation = "keep-selection";
    const state = S.state;
    const messages: any[] = [];
    Object.defineProperty(frame, "contentWindow", {
      value: { postMessage: (message: any) => messages.push(message) },
    });
    adoptDeskStatus(status(8, 4));
    assert.equal(S.app.stale, true, "ordinary reload offers manual refresh");
    assert.ok(!messages.some((m) => m.type === "reload"));
    adoptDeskStatus(status(9, 5));
    assert.equal(messages.filter((m) => m.type === "reload").length, 1);
    assert.equal(S.app.stale, false);
    assert.equal(S.app.route, "/current?filter=two#row");
    assert.equal(S.selectedAnnotation, "keep-selection");
    assert.equal(S.state, state);
    adoptDeskStatus(status(9, 5));
    assert.equal(
      messages.filter((m) => m.type === "reload").length,
      1,
      "duplicate poll does not replay",
    );
    S.app.connected = false;
    adoptDeskStatus(status(10, 6));
    assert.equal(
      frame.src,
      "http://localhost:41001/current?filter=two#row",
      "disconnected navigation uses current route",
    );
    assert.equal(S.app.connected, false, "navigation alone never claims bridge readiness");
    assert.equal(S.selectedAnnotation, "keep-selection");
    appRefresh();
    assert.equal(
      frame.src,
      "http://localhost:41001/current?filter=two#row",
      "manual retry remains available",
    );
    const beforeRestart = frame.src;
    adoptDeskStatus(status(0, 0, { port: 41001, token: "restarted" }));
    assert.equal(frame.src, beforeRestart, "restart adopts a baseline without refreshing");
    assert.equal(S.app.stale, false);
    S.uiRefreshGeneration = null;
    S.reloadGeneration = 0;
    adoptDeskStatus(status(20, 12, { port: 41001, token: "restarted" }));
    assert.equal(frame.src, beforeRestart, "first status adoption never replays an old signal");
    assert.equal(win.location.href, "http://localhost:41000/", "desk tab never navigates");
  } finally {
    await win.happyDOM.waitUntilComplete();
    await win.happyDOM.close();
  }
});
