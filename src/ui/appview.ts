import { S, $, toast } from "./store";
import { render } from "./render";
import {
  captureWaits,
  forwardedKeyRuns,
  readBridgeMessage,
  reloadRan,
  routeFromInput,
  shouldWarm,
} from "./appnav";
import { dispatchKey } from "./keys";
import { restoreComposerFocus } from "./composer";
import {
  annotationsUnvisited,
  appModeNow,
  appPageChanged,
  movedInApp,
  pendingInApp,
  pickedInApp,
  placedInApp,
  placeFloatingComposer,
  placePinCard,
  resumeUiComposer,
  pinsInApp,
  setUiComposerAside,
  syncBridge,
} from "./uilane";
import type {
  BridgeShot,
  DeskMessage,
  Rect,
  ReviewState,
  UiMarkTarget,
  UiPage,
  UiProxyInfo,
  Viewport,
} from "./types";

// The UI lane: the agent's running app, served by the desk's UI proxy (a second port, so a
// different origin from the desk) and shown in an iframe in the centre pane. The iframe is
// cross-origin, so the desk can't read or drive its history directly. It learns the route and
// title from the bridge (the script the proxy injects into every page) and sends navigation
// commands back to it, both over tokenized postMessage. With no bridge listening (the proxy's
// waiting page, a non-HTML page), refresh and the address bar fall back to resetting the src.

const PRESETS: Record<Exclude<Viewport, "fit">, [number, number]> = {
  desktop: [1440, 900],
  tablet: [820, 1180],
  mobile: [390, 844],
};

export const hasUi = () => !!S.state?.ui;
// The app is the whole review: a UI target and no diff. Re-derived on every reload, so a reload
// that brings a diff turns it into a combined desk and the Code / UI switch appears.
export const uiOnly = () => hasUi() && !S.state.files.length;

// The dev server's host, shown dimmed ahead of the route in the address bar.
export const appHost = () => (S.state?.ui ? new URL(S.state.ui.target).host : "");

// The proxy's origin as the tab reaches it: the same hostname the reviewer opened the desk with
// (localhost here, the devbox name over the tailnet), so the app stays same-site with the desk
// and its SameSite=Lax session cookies work inside the iframe.
const proxyOrigin = () =>
  S.uiProxy ? `${location.protocol}//${location.hostname}:${S.uiProxy.port}` : null;

// The first page to load: the target's path + query exactly (a dev sign-in URL lands signed in).
const targetRoute = () => {
  if (!S.state.ui) return "/";
  const url = new URL(S.state.ui.target);
  return url.pathname + url.search;
};

let frame: HTMLIFrameElement | null = null;
// Whether the UI view has shown the page the desk last loaded into the frame. One loaded in the
// code view (warmed, or a new target) has been seen by no one until the first switch.
let shown = false;

// Point the iframe at a route (the first load, a new target, or a fallback when no bridge is
// listening). The bridge on the new page re-handshakes and takes over the route from there.
function loadApp(route: string) {
  const origin = proxyOrigin();
  if (!origin) return;
  if (!frame) {
    frame = document.createElement("iframe");
    frame.title = "App under review";
    $("appFrame").append(frame);
  }
  Object.assign(S.app, {
    loaded: true,
    route,
    connected: false,
    canGoBack: null,
    canGoForward: null,
    stale: false,
  });
  shown = S.view === "ui";
  frame.src = origin + route;
}

// The target went, and the app goes with it: no page of it runs on, hidden, with its bridge still
// talking to the desk. Its farewell can't land with the frame gone, so its captures fail here.
function unloadApp() {
  frame?.remove();
  frame = null;
  Object.assign(S.app, {
    loaded: false,
    connected: false,
    canGoBack: null,
    canGoForward: null,
    stale: false,
  });
  captures.abandon("The app was detached from the desk");
}

let diffRendered = false;
let warming = false;

// Load the app in the background while the reviewer reads code, once the tab is idle (Safari has
// no requestIdleCallback: a short timer stands in). The code view keeps a loaded app laid out where
// the UI view shows it, unseen and inert (styles/appview.css), so it lays out at the stage's real size and
// the first switch finds it loaded.
function warmApp() {
  const ready = () =>
    shouldWarm({
      rendered: diffRendered,
      proxy: !!S.uiProxy,
      target: hasUi(),
      view: S.view,
      loaded: S.app.loaded,
    });
  if (warming || !ready()) return;
  warming = true;
  const run = () => {
    warming = false;
    if (!ready()) return;
    // Only into a tab the reviewer is in. A page that focuses itself as it loads takes the tab's
    // focus, and a tab in the background can't count on hearing of it (reclaimFocus): back in the
    // tab, the reviewer's keys would go to the app.
    if (document.hasFocus()) loadApp(targetRoute());
    else addEventListener("focus", warmApp, { once: true });
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 200);
}

// The desk's first diff render has finished: the app may warm from here on.
export function firstRenderDone() {
  diffRendered = true;
  warmApp();
}

export function postToApp(msg: DeskMessage) {
  const origin = proxyOrigin();
  if (frame?.contentWindow && origin) frame.contentWindow.postMessage(msg, origin);
}

// Out of the UI view the app never holds the tab's focus, and with it the desk's keys. Inert doesn't
// reach into the frame's document, so a page that focuses itself as it loads (an autofocus field, a
// focus() call, a dev server's reload) takes focus from the desk, which takes it straight back.
function reclaimFocus() {
  if (S.view === "ui" || !frame || document.activeElement !== frame) return;
  frame.blur();
  restoreComposerFocus();
}

// Switching to the code view repaints the diff; the returned render settles once it has.
export function setView(view: "code" | "ui"): Promise<void> | undefined {
  if (view === "ui" ? !hasUi() : uiOnly()) return;
  // A UI-lane composer can't stay open behind the code view (it would hold the code lane's keys
  // and the poll's diff adoption): it's set aside with its text and comes back with the UI view.
  if (view === "code") setUiComposerAside();
  S.view = view;
  syncBridge();
  if (view === "code") {
    reclaimFocus();
    return render(); // the diff pane was hidden while the app showed — repaint it
  }
  if (!S.app.loaded) loadApp(targetRoute());
  shown = true;
  requestAnimationFrame(sizeFrame);
  resumeUiComposer();
}

export const toggleView = () => setView(S.view === "ui" ? "code" : "ui");

export function appBack() {
  if (S.uiProxy && S.app.connected) postToApp({ type: "back", token: S.uiProxy.token });
}

export function appForward() {
  if (S.uiProxy && S.app.connected) postToApp({ type: "forward", token: S.uiProxy.token });
}

// Shared by the manual refresh controls and the agent's explicit UI iteration signal.
export function appRefresh() {
  S.app.stale = false;
  if (S.uiProxy && S.app.connected) postToApp({ type: "reload", token: S.uiProxy.token });
  else loadApp(S.app.route);
}

export function appGo(input: string) {
  const origins = [proxyOrigin(), S.state.ui && new URL(S.state.ui.target).origin];
  const route = routeFromInput(
    input,
    origins.filter((o): o is string => !!o),
  );
  if (!route) {
    toast("That address isn't part of the app");
    return;
  }
  if (S.uiProxy && S.app.connected) postToApp({ type: "navigate", token: S.uiProxy.token, route });
  else loadApp(route);
  S.app.route = route;
}

const captures = captureWaits(30_000);
let captureSeq = 0;

// Screenshot the app page as the reviewer sees it: the viewport, plus a crop around `target` when
// one is given, with an annotation's `mark` drawn on when one is given. The bridge renders both in
// the page.
export function captureApp(
  target: { target?: UiMarkTarget; mark?: { number: number; question: boolean } } = {},
): Promise<BridgeShot> {
  if (!S.uiProxy || !S.app.connected)
    return Promise.reject(new Error("No bridge is listening on the app page"));
  const id = ++captureSeq;
  const reply = captures.wait(id);
  postToApp({ type: "capture", token: S.uiProxy.token, id, ...target });
  return reply;
}

export function setViewport(viewport: Viewport) {
  S.viewport = viewport;
  sizeFrame();
  placeFloatingComposer();
  placePinCard();
}

// Fit fills the stage. A preset renders the app at its real CSS size, so the app's own media
// queries see a phone or a tablet, and scales it down to fit when the stage is smaller.
export function sizeFrame() {
  const stage = $("appStage");
  const box = $("appFrame");
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  if (!W || !H) return; // not laid out until the app first loads — resized then
  if (S.viewport === "fit") {
    Object.assign(box.style, {
      width: `${W}px`,
      height: `${H}px`,
      transform: "",
      left: "0",
      top: "0",
    });
    S.frameLabel = `${W} × ${H}`;
    return;
  }
  const [w, h] = PRESETS[S.viewport];
  const scale = Math.min(1, (W - 32) / w, (H - 32) / h);
  Object.assign(box.style, {
    width: `${w}px`,
    height: `${h}px`,
    transform: scale < 1 ? `scale(${scale})` : "",
    left: `${Math.round((W - w * scale) / 2)}px`,
    top: "16px",
  });
  S.frameLabel = `${w} × ${h}${scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}`;
}

// The app page's viewport as its own window measures it: the iframe's unscaled size (a preset is
// scaled down by a transform, which the page doesn't see) and the screen's pixel ratio. Null while
// no app is showing.
export function appViewport(): UiPage["viewport"] | null {
  if (!frame?.clientWidth || !frame.clientHeight) return null;
  return { width: frame.clientWidth, height: frame.clientHeight, dpr: devicePixelRatio || 1 };
}

// A rect in the app's viewport, in desk coordinates: through the iframe's position and any
// preset's scale-down. Null while no app is showing.
export function fromAppViewport(r: Rect): Rect | null {
  if (!frame?.offsetWidth) return null;
  const box = frame.getBoundingClientRect();
  const scale = box.width / frame.offsetWidth;
  return {
    x: box.x + r.x * scale,
    y: box.y + r.y * scale,
    width: r.width * scale,
    height: r.height * scale,
  };
}

// The desk's UI status off every poll; true when `galley reload` ran since the last one. A changed
// token means a new desk process: its reload counter starts over, so adopt it as the baseline, and
// the loaded page's bridge (still carrying the old token) is no longer trusted until the page
// reloads. Within one process, a generation that went up means `galley reload` ran, which raises the
// refresh pill on a page the reviewer has seen, unless a flagged reload explicitly asks for app
// refresh. A page the UI view hasn't shown yet has no place to keep: it reloads as it warmed,
// in the background.
// Either way, the desk has marked every annotation unvisited, and so does the tab.
export function adoptUiStatus(
  proxy: UiProxyInfo | null,
  generation: number,
  refreshGeneration: number,
): boolean {
  const prev = S.uiProxy;
  const reloaded = reloadRan(
    { token: prev?.token, generation: S.reloadGeneration },
    { token: proxy?.token, generation },
  );
  // First adoption and a new desk process establish a baseline, never replay old requests.
  const refresh =
    reloaded && S.uiRefreshGeneration !== null && refreshGeneration > S.uiRefreshGeneration;
  S.uiProxy = proxy;
  S.reloadGeneration = generation;
  S.uiRefreshGeneration = refreshGeneration;
  if (reloaded) {
    if (refresh && proxy && S.app.loaded) appRefresh();
    else if (S.app.loaded && shown) S.app.stale = true;
    else if (S.app.loaded) {
      S.app.loaded = false;
      warmApp();
    }
    annotationsUnvisited();
    return true;
  }
  if (prev?.token !== proxy?.token) {
    S.app.connected = false;
    if (prev) annotationsUnvisited();
    // A restarted desk normally gets its stable proxy port back; if not, follow it.
    if (prev && proxy && prev.port !== proxy.port && S.app.loaded) loadApp(S.app.route);
    // The UI view opened before the proxy was up: load now. The code view warms it.
    else if (proxy && S.view === "ui" && !S.app.loaded) loadApp(targetRoute());
    else {
      // A page warmed but never shown still runs the old token's bridge: warm it afresh, as a
      // reload does, rather than show it disconnected on the first switch.
      if (S.app.loaded && !shown) S.app.loaded = false;
      warmApp();
    }
  }
  return false;
}

// The UI target off the poll: `galley ui <url>` on the live desk. A loaded view switches to it; the
// code view warms an app that hasn't loaded.
export function adoptUiTarget(ui: ReviewState["ui"]) {
  const before = S.state.ui?.target;
  if (ui?.target === before) return;
  S.state.ui = ui;
  syncView();
  if (!ui) {
    unloadApp();
    return;
  }
  if (S.app.loaded) loadApp(targetRoute());
  else warmApp();
  if (before) toast("App target changed");
  else toast("App attached — show it with", undefined, "⇧U");
}

// Keep the view legal for the desk's current shape (after init, a reload, or a target change).
export function syncView() {
  if (!hasUi()) S.view = "code";
  else if (uiOnly() && S.view !== "ui") setView("ui");
}

export function installAppView() {
  addEventListener("message", (e: MessageEvent) => {
    if (!frame || e.origin !== proxyOrigin() || !S.uiProxy) return;
    const msg = readBridgeMessage(e.data, S.uiProxy.token);
    if (!msg) return;
    // A page's farewell lands after it's gone, so its source is already null. Accepting it on the
    // origin and token alone is safe, because all it can do is stop the desk trusting a bridge and
    // fail the captures that page will now never answer.
    if (msg.type === "leave") {
      if (e.source !== null && e.source !== frame.contentWindow) return;
      S.app.connected = false;
      captures.abandon("The app page navigated away during the capture");
      return;
    }
    if (e.source !== frame.contentWindow) return;
    if (msg.type === "captured") {
      captures.settle(msg.id, "shot" in msg ? msg.shot : new Error(msg.error));
      return;
    }
    // Picks and keys count only in the mode the desk put the app in, whatever the page claims.
    if (msg.type === "picked") {
      if (appModeNow() === "annotate") pickedInApp(msg.page, msg.target);
      return;
    }
    if (msg.type === "pending") {
      if (appModeNow() === "annotate") pendingInApp(msg.count);
      return;
    }
    if (msg.type === "anchor") return movedInApp(msg.rect);
    if (msg.type === "pins") return pinsInApp(msg.pins, msg.clicked);
    if (msg.type === "placements") return placedInApp(msg.placements);
    if (msg.type === "key") {
      if (forwardedKeyRuns(msg, appModeNow())) dispatchKey(msg);
      return;
    }
    const moved = msg.route !== S.app.route;
    Object.assign(S.app, {
      connected: true,
      route: msg.route,
      title: msg.title,
      canGoBack: msg.canGoBack,
      canGoForward: msg.canGoForward,
    });
    // A new page has a new bridge with nothing drawn yet; an in-page route change has other pins.
    if (msg.type === "ready" || moved) appPageChanged(msg.type === "ready");
  });
  // The tab's focus moving into the frame blurs the desk's window. Taken back once the move has
  // finished: blurring the frame while it's under way doesn't hold.
  addEventListener("blur", () => setTimeout(reclaimFocus));
  new ResizeObserver(() => {
    sizeFrame();
    placeFloatingComposer();
    placePinCard();
  }).observe($("appStage"));
}
