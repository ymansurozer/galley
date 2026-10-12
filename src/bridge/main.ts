import type { BridgeMessage, BridgeNav, DeskMessage } from "../types";

// The bridge: the desk's UI proxy injects it as the first script in every proxied HTML page. It is
// the app page's only line to the desk, and the line is postMessage to the parent desk frame, never
// the desk API (a different origin, which the desk's origin guard refuses). Its tag carries the
// desk origin and the per-desk token. Every message it posts carries the token and targets exactly
// the desk origin. It obeys only messages from that origin, sent by the parent frame, that carry the
// token. For now it does the handshake, reports navigation, and runs the desk's back/forward/
// refresh/address commands.
(() => {
  const tag = document.currentScript as HTMLScriptElement | null;
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
  });

  report("ready");
})();
