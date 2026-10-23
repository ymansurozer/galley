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
        'import {S} from "./store"; import {adoptDeskStatus} from "./poll"; import {setView,appRefresh,applyPendingUiRefresh} from "./appview"; import {renderMarkdown} from "./markdown"; window.harness={S,adoptDeskStatus,setView,appRefresh,applyPendingUiRefresh,renderMarkdown};',
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
    const { S, setView, appRefresh, applyPendingUiRefresh } = (win as any).harness;
    const adoptDeskStatus = (payload: any) => {
      const result = (win as any).harness.adoptDeskStatus(payload);
      applyPendingUiRefresh();
      return result;
    };
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
    assert.deepEqual(
      Object.keys(
        adoptDeskStatus({ ...status(7, 4), agentRecentlyActive: true, baseDiffHash: "hash" }),
      ),
      ["baseDiffHash"],
    );
    assert.equal(S.agentRecentlyActive, true);
    adoptDeskStatus(status(7, 4));
    assert.equal(S.agentRecentlyActive, false, "absent transient status resets on adoption");
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

// The bridge's returning document is the destructive boundary: use its real message handler,
// composer input tracking, lane-switch draft storage, and polling together.
test("automatic refresh waits for active and set-aside drafts, then drains on a normal poll", async () => {
  const bundle = await build({
    stdin: {
      contents:
        'import {S} from "./store"; import {adoptDeskStatus,pollState} from "./poll"; import {setView,installAppView,appRefresh} from "./appview"; import {pickedInApp,setUiComposerAside,resumeUiComposer} from "./uilane"; import {closeComposer} from "./composer"; import {renderMarkdown} from "./markdown"; window.harness={S,adoptDeskStatus,pollState,setView,installAppView,appRefresh,pickedInApp,setUiComposerAside,resumeUiComposer,closeComposer,renderMarkdown};',
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
    settings: { disableIframePageLoading: true },
  });
  try {
    win.document.body.innerHTML =
      '<div id="appFrame"></div><div id="appStage"></div><div id="pinCard"></div><div id="uiComposer"></div>';
    win.eval(bundle.outputFiles[0]!.text);
    const h = (win as any).harness;
    const { S } = h;
    const readyBy = Date.now() + 10_000;
    while (!h.renderMarkdown("**ready**").includes("<strong>")) {
      assert.ok(Date.now() < readyBy);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ui = { target: "http://localhost:3000/entry" };
    S.state = { ui, files: [], changes: [], comments: [], annotations: [], baseDiffHash: "base" };
    S.lastBaseDiffHash = "base";
    let payload = {
      ui,
      comments: [],
      annotations: [],
      baseDiffHash: "base",
      uiProxy: { port: 41001, token: "first" },
      reloadGeneration: 0,
      uiRefreshGeneration: 0,
    };
    win.fetch = (async () => ({ json: async () => payload })) as any;
    h.adoptDeskStatus(payload);
    h.setView("ui");
    h.installAppView();
    const frame = win.document.querySelector("iframe")! as any;
    const messages: any[] = [];
    Object.defineProperty(frame, "contentWindow", {
      value: { postMessage: (m: any) => messages.push(m) },
    });
    const reloads = () => messages.filter((m) => m.type === "reload").length;
    const ready = () =>
      win.dispatchEvent(
        new win.MessageEvent("message", {
          origin: "http://localhost:41001",
          source: frame.contentWindow,
          data: {
            type: "ready",
            token: payload.uiProxy.token,
            route: "/current?query=kept",
            title: "App",
          },
        }),
      );
    ready();
    const openDraft = (body: string) => {
      h.pickedInApp(
        { route: S.app.route, viewport: { width: 1000, height: 700, dpr: 1 } },
        {
          kind: "element",
          elements: [
            { selector: "#action", tag: "button", rect: { x: 10, y: 10, width: 100, height: 20 } },
          ],
        },
      );
      const input = win.document.querySelector<HTMLTextAreaElement>("#uiComposer textarea")!;
      input.value = body;
      input.dispatchEvent(new win.Event("input"));
    };
    openDraft("Second annotation — keep my words");
    payload = { ...payload, reloadGeneration: 1, uiRefreshGeneration: 1 };
    await h.pollState();
    if (reloads()) ready();
    assert.equal(S.composerOpen, true, "returning bridge must not discard an active composer");
    assert.ok(S.annotationDraft, "draft target stays available");
    assert.equal(S.composerBody, "Second annotation — keep my words");
    assert.equal(reloads(), 0, "typing defers the automatic refresh");
    await h.pollState();
    payload = { ...payload, reloadGeneration: 2 };
    await h.pollState();
    assert.equal(
      reloads(),
      0,
      "duplicate polls and a later ordinary reload keep the pending intent",
    );
    h.setUiComposerAside();
    S.view = "code";
    await h.pollState();
    if (reloads()) ready();
    S.view = "ui";
    h.resumeUiComposer();
    assert.equal(S.composerOpen, true, "lane switch can resume the saved pick draft");
    assert.equal(S.composerBody, "Second annotation — keep my words");
    assert.ok(S.annotationDraft);
    await h.pollState();
    assert.equal(reloads(), 0);
    h.closeComposer();
    await h.pollState();
    assert.equal(reloads(), 1, "normal polling automatically drains after the draft closes");
    ready();
    await h.pollState();
    assert.equal(reloads(), 1, "a delivered request is not replayed");
    assert.equal(S.app.route, "/current?query=kept");

    openDraft("A set-aside draft when the next signal arrives");
    h.setUiComposerAside();
    S.view = "code";
    payload = { ...payload, reloadGeneration: 3, uiRefreshGeneration: 2 };
    await h.pollState();
    if (reloads() > 1) ready();
    S.view = "ui";
    h.resumeUiComposer();
    assert.equal(S.composerBody, "A set-aside draft when the next signal arrives");
    assert.ok(S.annotationDraft, "a hidden draft also prevents destructive refresh");
    payload = { ...payload, reloadGeneration: 4, uiRefreshGeneration: 3 };
    await h.pollState();
    h.closeComposer();
    await h.pollState();
    assert.equal(reloads(), 2, "multiple pending signals coalesce into one refresh");
    ready();

    openDraft("Survive process replacement");
    payload = { ...payload, reloadGeneration: 5, uiRefreshGeneration: 4 };
    await h.pollState();
    payload = {
      ...payload,
      uiProxy: { port: 41001, token: "restart" },
      reloadGeneration: 0,
      uiRefreshGeneration: 0,
    };
    await h.pollState();
    h.closeComposer();
    await h.pollState();
    assert.equal(reloads(), 2, "a restarted process clears stale pending intent");
    ready();
    openDraft("Survive target replacement");
    payload = { ...payload, reloadGeneration: 1, uiRefreshGeneration: 1 };
    await h.pollState();
    h.closeComposer();
    payload = { ...payload, ui: { target: "http://localhost:3000/replacement" } };
    await h.pollState();
    assert.equal(reloads(), 2, "a changed target clears pending refresh before it can drain");

    ready();
    openDraft("Manual refresh while an agent refresh waits");
    payload = { ...payload, reloadGeneration: 2, uiRefreshGeneration: 2 };
    await h.pollState();
    assert.equal(reloads(), 2, "the draft holds the next explicit signal");
    h.appRefresh();
    assert.equal(reloads(), 3, "manual Refresh app fulfills the pending request");
    ready();
    await h.pollState();
    assert.equal(reloads(), 3, "unchanged polling must not refresh again after manual refresh");
    openDraft("New text after manual refresh");
    await h.pollState();
    h.closeComposer();
    await h.pollState();
    assert.equal(reloads(), 3, "closing a later draft does not replay the fulfilled request");
  } finally {
    await win.happyDOM.waitUntilComplete();
    await win.happyDOM.close();
  }
});
