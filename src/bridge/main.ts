import type { BridgeMessage, BridgeNav, DeskMessage, Rect } from "../types";
import { installAnnotate } from "./annotate";
import { capturePage } from "./capture";

// The bridge: the desk's UI proxy injects it as the first script in every proxied HTML page. It is
// the app page's only line to the desk, and the line is postMessage to the parent desk frame, never
// the desk API (a different origin, which the desk's origin guard refuses). Its tag carries the
// desk origin and the per-desk token. Every message it posts carries the token and targets exactly
// the desk origin. It obeys only messages from that origin, sent by the parent frame, that carry the
// token. It does the handshake, reports navigation, runs the desk's back/forward/refresh/address
// commands, screenshots the page on request, and runs Annotate mode and the pins (annotate.ts).
(() => {
  const tag = document.currentScript;
  const deskOrigin = tag?.dataset.galleyDesk;
  const token = tag?.dataset.galleyToken;
  // Outside the desk's iframe (the proxy URL opened in its own tab) the page runs untouched.
  if (!deskOrigin || !token || window.parent === window) return;

  const post = (msg: BridgeMessage) => window.parent.postMessage(msg, deskOrigin);

  // The Navigation API's history is per frame. history.length counts the whole tab's joint session
  // history, and history.back() can step the desk itself back once the app runs out of entries.
  // Where the API is missing, canGoBack/canGoForward are null and the desk leaves the buttons on.
  const nav = "navigation" in window ? window.navigation : null;
  // A traversal the app intercepts or aborts rejects both promises. That's the app's business, so
  // keep it out of the console.
  const settle = (r: NavigationResult) => {
    r.committed?.catch(() => {});
    r.finished?.catch(() => {});
  };

  const snapshot = (): BridgeNav => ({
    route: location.pathname + location.search,
    title: document.title,
    canGoBack: nav ? nav.canGoBack : null,
    canGoForward: nav ? nav.canGoForward : null,
  });
  let last = "";
  const report = (type: "ready" | "nav") => {
    const now = snapshot();
    const key = JSON.stringify(now);
    if (type === "nav" && key === last) return;
    last = key;
    post({ type, token, ...now });
  };
  // Deferred a microtask so the report sees the state the router just committed.
  const changed = () => queueMicrotask(() => report("nav"));

  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
      original.apply(this, args);
      changed();
    };
  }
  addEventListener("popstate", changed);
  addEventListener("hashchange", changed);
  nav?.addEventListener("currententrychange", changed);
  // The bridge runs before <title> is parsed, and SPAs retitle on route changes. Watch <head>.
  new MutationObserver(changed).observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  addEventListener("pagehide", () => post({ type: "leave", token }));
  const annotate = installAnnotate(post, token);

  // The crop's target: the selector's element, else the rect the desk sent. A selector that matches
  // nothing (or doesn't parse) gives no crop rather than failing the capture.
  const captureTarget = (
    msg: Partial<Extract<DeskMessage, { type: "capture" }>>,
  ): Element | Rect | null => {
    if (typeof msg.selector === "string") {
      try {
        return document.querySelector(msg.selector);
      } catch {
        return null;
      }
    }
    const r = msg.rect;
    return r && [r.x, r.y, r.width, r.height].every(Number.isFinite) ? r : null;
  };

  addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== deskOrigin || e.source !== window.parent) return;
    const msg = e.data as Partial<DeskMessage> | null;
    if (!msg || typeof msg !== "object" || msg.token !== token) return;
    if (msg.type === "navigate" && typeof msg.route === "string") {
      // Same-origin paths only: an absolute or protocol-relative route resolves elsewhere and is ignored.
      const url = new URL(msg.route, location.origin);
      if (url.origin === location.origin) location.assign(url.href);
    } else if (msg.type === "back") {
      if (!nav) history.back();
      else if (nav.canGoBack) settle(nav.back());
    } else if (msg.type === "forward") {
      if (!nav) history.forward();
      else if (nav.canGoForward) settle(nav.forward());
    } else if (msg.type === "reload") location.reload();
    else if (msg.type === "mode" && (msg.mode === "annotate" || msg.mode === "interact"))
      annotate.setMode(msg.mode);
    else if (msg.type === "marks" && Array.isArray(msg.marks))
      annotate.setMarks(msg.marks, msg.selected ?? null, msg.picking === true);
    else if (msg.type === "capture" && typeof msg.id === "number") {
      const id = msg.id;
      capturePage(captureTarget(msg)).then(
        (shot) => post({ type: "captured", token, id, shot }),
        (err: unknown) =>
          post({
            type: "captured",
            token,
            id,
            error: err instanceof Error ? err.message : String(err),
          }),
      );
    }
  });

  report("ready");
})();
