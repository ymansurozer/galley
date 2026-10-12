import { S, $, toast } from "./store";
import { render } from "./render";
import { readBridgeMessage, routeFromInput } from "./appnav";
import type { DeskMessage, ReviewState, UiProxyInfo, Viewport } from "./types";

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
  frame.src = origin + route;
}

function post(msg: DeskMessage) {
  const origin = proxyOrigin();
  if (frame?.contentWindow && origin) frame.contentWindow.postMessage(msg, origin);
}

export function setView(view: "code" | "ui") {
  if (view === "ui" ? !hasUi() : uiOnly()) return;
  S.view = view;
  if (view === "code") {
    render(); // the diff pane was hidden while the app showed — repaint it
    return;
  }
  if (!S.app.loaded) loadApp(targetRoute());
  requestAnimationFrame(sizeFrame);
}

export const toggleView = () => setView(S.view === "ui" ? "code" : "ui");

export function appBack() {
  if (S.uiProxy && S.app.connected) post({ type: "back", token: S.uiProxy.token });
}

export function appForward() {
  if (S.uiProxy && S.app.connected) post({ type: "forward", token: S.uiProxy.token });
}

// Also how the reviewer takes the "App updated" pill: the app reloads only when they ask.
export function appRefresh() {
  S.app.stale = false;
  if (S.uiProxy && S.app.connected) post({ type: "reload", token: S.uiProxy.token });
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
  if (S.uiProxy && S.app.connected) post({ type: "navigate", token: S.uiProxy.token, route });
  else loadApp(route);
  S.app.route = route;
}

export function setViewport(viewport: Viewport) {
  S.viewport = viewport;
  sizeFrame();
}

// Fit fills the stage. A preset renders the app at its real CSS size, so the app's own media
// queries see a phone or a tablet, and scales it down to fit when the stage is smaller.
export function sizeFrame() {
  const stage = $("appStage");
  const box = $("appFrame");
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  if (!W || !H) return; // hidden (code view) — resized when the UI view shows
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

// The desk's UI status off every poll. A changed token means a new desk process: its reload
// counter starts over, so adopt it as the baseline, and the loaded page's bridge (still carrying
// the old token) is no longer trusted until the page reloads. Within one process, a moved
// generation means `galley reload` ran, which raises the refresh pill but never reloads the app.
export function adoptUiStatus(proxy: UiProxyInfo | null, generation: number) {
  const prev = S.uiProxy;
  S.uiProxy = proxy;
  if (prev?.token !== proxy?.token) {
    S.reloadGeneration = generation;
    S.app.connected = false;
    // A restarted desk normally gets its stable proxy port back; if not, follow it.
    if (prev && proxy && prev.port !== proxy.port && S.app.loaded) loadApp(S.app.route);
    // The UI view opened before the proxy was up: load now.
    else if (proxy && S.view === "ui" && !S.app.loaded) loadApp(targetRoute());
    return;
  }
  if (generation !== S.reloadGeneration) {
    S.reloadGeneration = generation;
    if (S.app.loaded) S.app.stale = true;
  }
}

// The UI target off the poll: `galley ui <url>` on the live desk. A loaded view switches to it.
export function adoptUiTarget(ui: ReviewState["ui"]) {
  const before = S.state.ui?.target;
  if (ui?.target === before) return;
  S.state.ui = ui;
  syncView();
  if (!ui) return;
  if (S.app.loaded) loadApp(targetRoute());
  toast(before ? "App target changed" : "App attached — ⇧U shows it");
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
    // origin and token alone is safe, because all it can do is stop the desk trusting a bridge.
    if (msg.type === "leave") {
      if (e.source === null || e.source === frame.contentWindow) S.app.connected = false;
      return;
    }
    if (e.source !== frame.contentWindow) return;
    Object.assign(S.app, {
      connected: true,
      route: msg.route,
      title: msg.title,
      canGoBack: msg.canGoBack,
      canGoForward: msg.canGoForward,
    });
  });
  new ResizeObserver(sizeFrame).observe($("appStage"));
}
