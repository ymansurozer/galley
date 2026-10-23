import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

// Adapted from the integration lifecycle probe: real desk modules, with only HTTP and
// the cross-origin page boundary simulated. Bundling stays in memory beside a live tester.
const bundle = build({
  stdin: {
    contents:
      'import {S,saver} from "./store"; import {adoptDeskStatus,pollState} from "./poll"; import {setView,installAppView,appRefresh,adoptUiTarget} from "./appview"; import {pickedInApp,annotatePage,setAppMode,submitUiComposer,screenshotsSettled} from "./uilane"; import {closeComposer} from "./composer"; import {renderMarkdown} from "./markdown"; window.h={S,saver,adoptDeskStatus,pollState,setView,installAppView,appRefresh,adoptUiTarget,pickedInApp,annotatePage,setAppMode,submitUiComposer,screenshotsSettled,closeComposer,renderMarkdown};',
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  logLevel: "silent",
});

async function until(check: () => unknown) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "bounded lifecycle wait");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const win = new Window({
    url: "http://localhost:41000/",
    settings: { disableIframePageLoading: true },
  });
  t.after(async () => {
    await win.happyDOM.waitUntilComplete();
    await win.happyDOM.close();
  });
  win.document.body.innerHTML =
    '<div id="appFrame"></div><div id="appStage"></div><div id="pinCard"></div><div id="uiComposer"></div>';
  win.eval((await bundle).outputFiles[0]!.text);
  const h = (win as any).h;
  const { S } = h;
  await until(() => h.renderMarkdown("**ready**").includes("<strong>"));
  const ui = { target: "http://localhost:3000/entry" };
  S.state = {
    root: "/repo",
    ui,
    files: [],
    changes: [],
    comments: [],
    annotations: [],
    baseDiffHash: "base",
  };
  S.lastBaseDiffHash = "base";
  let payload = {
    ui,
    comments: [],
    annotations: [],
    baseDiffHash: "base",
    uiProxy: { port: 41001, token: "first" },
    reloadGeneration: 0,
    uiRefreshGeneration: 0,
    project: "project",
    branch: "branch",
  };
  const requests: Array<{ url: string; body: any }> = [];
  let onRequest = async (_url: string): Promise<void> => {};
  win.fetch = (async (url: string, options: any) => {
    requests.push({ url, body: url === "/api/save" ? JSON.parse(options.body) : options?.body });
    await onRequest(url);
    return { ok: true, status: 200, json: async () => payload };
  }) as any;
  h.adoptDeskStatus(payload);
  h.setView("ui");
  h.installAppView();
  const frame = win.document.querySelector("iframe")! as any;
  const messages: any[] = [];
  Object.defineProperty(frame, "contentWindow", {
    value: { postMessage: (m: any) => messages.push(m) },
  });
  const bridge = (data: any) =>
    win.dispatchEvent(
      new win.MessageEvent("message", {
        origin: "http://localhost:41001",
        source: frame.contentWindow,
        data: { token: payload.uiProxy.token, ...data },
      }),
    );
  const ready = () => bridge({ type: "ready", route: "/current?q=kept", title: "App" });
  ready();
  const page = { route: S.app.route, viewport: { width: 1000, height: 700, dpr: 1 } };
  const target = {
    kind: "element",
    elements: [
      { selector: "#action", tag: "button", rect: { x: 10, y: 10, width: 100, height: 20 } },
    ],
  };
  const open = () => {
    h.pickedInApp(page, target);
    const input = win.document.querySelector("#uiComposer textarea")! as any;
    input.value = "Reviewer words";
    input.dispatchEvent(new win.Event("input"));
  };
  const submitShot = () => {
    open();
    (win.document.querySelector('#uiComposer input[type="checkbox"]')! as any).click();
    h.submitUiComposer("action");
    return S.state.annotations.at(-1);
  };
  return {
    win,
    h,
    S,
    frame,
    messages,
    requests,
    bridge,
    ready,
    page,
    target,
    open,
    submitShot,
    payload: () => payload,
    update: (patch: Partial<typeof payload>) => (payload = { ...payload, ...patch }),
    onRequest: (fn: typeof onRequest) => (onRequest = fn),
    reloads: () => messages.filter((m) => m.type === "reload").length,
    captures: () => messages.filter((m) => m.type === "capture"),
  };
}

test("refresh disables new annotations until ready, including late old-page traffic", async (t) => {
  const f = await fixture(t);
  const { h, S, bridge } = f;
  h.setAppMode("annotate");
  f.update({ reloadGeneration: 1, uiRefreshGeneration: 1 });
  await h.pollState();
  assert.equal(f.reloads(), 1);
  assert.equal(S.app.connected, false, "annotation affordances disable at dispatch");
  bridge({ type: "nav", route: S.app.route, title: "Old page" });
  bridge({ type: "picked", page: f.page, target: f.target });
  bridge({ type: "pending", count: 1 });
  h.annotatePage();
  assert.equal(S.composerOpen, false, "the departing page cannot open a doomed draft");
  assert.equal(S.pendingPicks, 0);
  bridge({ type: "leave" });
  assert.equal(S.app.connected, false);
  f.ready();
  f.open();
  assert.equal(S.composerBody, "Reviewer words", "drafts work again after the handshake");
  h.closeComposer();
  await h.pollState();
  assert.equal(f.reloads(), 1);

  h.appRefresh();
  assert.equal(S.app.connected, false, "manual refresh uses the same navigation lifecycle");
  bridge({ type: "nav", route: S.app.route });
  assert.equal(S.app.connected, false, "a nav from the old document is not ready");
  f.ready();
  assert.equal(S.app.connected, true);
});

test("automatic refresh waits from screenshot submission through bytes, but not upload", async (t) => {
  const f = await fixture(t);
  const { h, S } = f;
  let releaseUpload: (() => void) | undefined;
  f.onRequest(async (url) => {
    if (url.endsWith("kind=crop")) await new Promise<void>((resolve) => (releaseUpload = resolve));
  });
  const annotation = f.submitShot();
  f.update({ reloadGeneration: 1, uiRefreshGeneration: 1 });
  await h.pollState();
  assert.equal(f.reloads(), 0, "protect even the two animation frames before capture dispatch");
  await until(() => f.captures().length === 1);
  await h.pollState();
  assert.equal(f.reloads(), 0, "the bridge still owes image bytes");
  f.bridge({
    type: "captured",
    id: f.captures()[0].id,
    shot: {
      crop: new f.win.Blob(["crop"], { type: "image/png" }),
      viewport: new f.win.Blob(["viewport"], { type: "image/png" }),
      ms: 1,
    },
  });
  await until(() => releaseUpload);
  // The real Resolve callback must also stay closed across refresh and upload completion.
  (f.win.document.querySelector("#pinCard .resolve-thread")! as any).click();
  await h.pollState();
  assert.equal(f.reloads(), 1, "upload-only work does not hold the app");
  f.bridge({ type: "leave" });
  f.ready();
  releaseUpload!();
  assert.equal(await h.screenshotsSettled(1000), true);
  assert.equal(annotation.screenshots, true);
  assert.equal(annotation.status, "resolved");
  assert.equal(S.selectedAnnotation, null);
  assert.equal(f.requests.filter((r) => r.url.startsWith("/api/ui-shot")).length, 2);
});

test("superseded poll and full-state responses cannot rewind refreshes or a restart baseline", async (t) => {
  const f = await fixture(t);
  const { h, S, win } = f;
  let releaseOld: ((payload: any) => void) | undefined;
  win.fetch = (async () => ({
    json: () => new Promise((resolve) => (releaseOld = resolve)),
  })) as any;
  const oldPayload = f.payload();
  const oldPoll = h.pollState();
  await until(() => releaseOld);
  f.update({ reloadGeneration: 1, uiRefreshGeneration: 1 });
  win.fetch = (async () => ({ json: async () => f.payload() })) as any;
  await h.pollState();
  f.ready();
  releaseOld!(oldPayload);
  await oldPoll;
  assert.equal(S.uiRefreshGeneration, 1);
  await h.pollState();
  assert.equal(f.reloads(), 1, "one generation produces one navigation");

  // An older poll can also be suspended in its second (full-state) request.
  f.update({ baseDiffHash: "older-diff" });
  releaseOld = undefined;
  win.fetch = (async (url: string) => ({
    json: () =>
      url === "/api/state"
        ? new Promise((resolve) => (releaseOld = resolve))
        : Promise.resolve(f.payload()),
  })) as any;
  const olderState = h.pollState();
  await until(() => releaseOld);
  f.update({
    baseDiffHash: "base",
    uiProxy: { port: 41001, token: "restart" },
    reloadGeneration: 0,
    uiRefreshGeneration: 0,
  });
  win.fetch = (async () => ({ json: async () => f.payload() })) as any;
  await h.pollState();
  releaseOld!({ ...S.state, ...oldPayload, baseDiffHash: "older-diff" });
  await olderState;
  assert.equal(S.uiProxy.token, "restart");
  assert.equal(S.uiRefreshGeneration, 0);
  assert.equal(S.lastBaseDiffHash, "base", "the superseded full state is discarded too");
  f.ready();
  f.update({ reloadGeneration: 1, uiRefreshGeneration: 1 });
  await h.pollState();
  assert.equal(f.reloads(), 2, "the restarted process can issue its own first refresh");
});

test("capture failures release deferred refresh and save failure without losing annotations", async (t) => {
  const f = await fixture(t);
  const { h } = f;
  for (const failure of ["bridge error", "timeout", "postMessage error"] as const) {
    // Drive the real 30-second timeout without a wall-clock wait or changing production timing.
    const originalTimeout = f.win.setTimeout.bind(f.win);
    let expire: (() => void) | undefined;
    if (failure === "timeout") {
      f.win.setTimeout = ((callback: () => void, ms: number, ...args: any[]) => {
        if (ms === 30_000) expire = callback;
        return originalTimeout(callback, ms, ...args);
      }) as any;
    }
    const postMessage = f.frame.contentWindow.postMessage;
    if (failure === "postMessage error") {
      f.frame.contentWindow.postMessage = (message: any) => {
        postMessage(message);
        if (message.type === "capture") throw new Error("capture transport failed");
      };
    }
    const priorCaptures = f.captures().length;
    const annotation = f.submitShot();
    const generation = f.payload().reloadGeneration + 1;
    f.update({ reloadGeneration: generation, uiRefreshGeneration: generation });
    await h.pollState();
    assert.equal(f.reloads(), generation - 1, "submission holds the pending refresh");
    await until(() => f.captures().length > priorCaptures);
    f.frame.contentWindow.postMessage = postMessage;
    f.win.setTimeout = originalTimeout;
    if (failure === "bridge error")
      f.bridge({ type: "captured", id: f.captures().at(-1).id, error: "render failed" });
    if (failure === "timeout") expire!();
    assert.equal(await h.screenshotsSettled(1000), true, failure);
    await h.saver.settled();
    assert.equal(annotation.screenshotCapture, "failed");
    assert.equal(annotation.screenshots, undefined);
    assert.ok(
      f.requests
        .filter((r) => r.url === "/api/save")
        .at(-1)!
        .body.annotations.some(
          (a: any) => a.id === annotation.id && a.screenshotCapture === "failed",
        ),
    );
    await h.pollState();
    assert.equal(f.reloads(), generation, "failure releases exactly one refresh");
    f.bridge({ type: "leave" });
    f.ready();
    await h.pollState();
    assert.equal(f.reloads(), generation);
  }
  assert.equal(f.requests.filter((r) => r.url.startsWith("/api/ui-shot")).length, 0);
});

test("manual refresh cancels a capture before paint without sending it to the returning page", async (t) => {
  const f = await fixture(t);
  const { h } = f;
  const originalFrame = f.win.requestAnimationFrame.bind(f.win);
  const frames: Array<(time: number) => void> = [];
  f.win.requestAnimationFrame = ((callback: (time: number) => void) =>
    frames.push(callback)) as any;
  const annotation = f.submitShot();
  f.update({ reloadGeneration: 1, uiRefreshGeneration: 1 });
  await h.pollState();
  assert.equal(f.reloads(), 0);
  h.appRefresh();
  f.ready();
  assert.equal(await h.screenshotsSettled(1000), true);
  assert.equal(annotation.screenshotCapture, "failed");
  f.win.requestAnimationFrame = originalFrame;
  for (const callback of frames) callback(0);
  await f.win.happyDOM.waitUntilComplete();
  await h.pollState();
  assert.equal(f.captures().length, 0, "the canceled request cannot capture the replacement page");
  assert.equal(f.reloads(), 1, "manual refresh consumed the deferred signal");
  assert.equal(f.requests.filter((r) => r.url.startsWith("/api/ui-shot")).length, 0);
});

test("manual navigation, bridge replacement, target detach and reset clean up pending captures", async (t) => {
  const f = await fixture(t);
  const { h, S } = f;
  for (const navigation of ["manual", "leave", "ready", "target", "detach"] as const) {
    const priorCaptures = f.captures().length;
    const annotation = f.submitShot();
    await until(() => f.captures().length > priorCaptures);
    const generation = f.payload().reloadGeneration + 1;
    f.update({ reloadGeneration: generation, uiRefreshGeneration: generation });
    await h.pollState();
    const reloads = f.reloads();
    if (navigation === "manual") h.appRefresh();
    if (navigation === "leave") f.bridge({ type: "leave" });
    if (navigation === "ready") f.ready();
    if (navigation === "target") {
      f.update({ ui: { target: "http://localhost:3000/changed" } });
      await h.pollState();
    }
    if (navigation === "detach") h.adoptUiTarget(undefined);
    assert.equal(await h.screenshotsSettled(1000), true, navigation);
    assert.equal(annotation.screenshotCapture, "failed");
    assert.equal(annotation.screenshots, undefined);
    if (navigation === "detach") {
      h.adoptUiTarget(f.payload().ui);
      h.setView("ui");
      // The iframe is removed on detach: subsequent messages must come from its replacement.
      const newFrame = f.win.document.querySelector("iframe")! as any;
      Object.defineProperty(newFrame, "contentWindow", { value: f.frame.contentWindow });
    }
    f.ready();
    await h.pollState();
    assert.equal(
      f.reloads(),
      reloads + (navigation === "target" || navigation === "detach" ? 0 : 1),
    );
    f.ready();
  }

  const beforeReset = f.captures().length;
  const removed = f.submitShot();
  await until(() => f.captures().length > beforeReset);
  f.update({ reloadGeneration: 6, uiRefreshGeneration: 6 });
  await h.pollState();
  // S.reset adopts the returned ReviewState wholesale; the capture must not resurrect its record.
  S.state = { ...S.state, annotations: [] };
  f.bridge({
    type: "captured",
    id: f.captures().at(-1).id,
    shot: {
      crop: new f.win.Blob(["crop"], { type: "image/png" }),
      viewport: new f.win.Blob(["viewport"], { type: "image/png" }),
      ms: 1,
    },
  });
  assert.equal(await h.screenshotsSettled(1000), true);
  await h.pollState();
  assert.equal(
    S.state.annotations.some((a: any) => a.id === removed.id),
    false,
  );
  assert.equal(f.requests.filter((r) => r.url.startsWith("/api/ui-shot")).length, 0);
});
