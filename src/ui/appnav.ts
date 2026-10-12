import type { BridgeMessage } from "./types";

// Pure helpers for the UI view's traffic with the bridge (kept free of the store so they unit-test
// without a DOM). The app page is untrusted: what it posts is re-validated and capped here before
// it touches the store.

const ROUTE_CAP = 2048;
const TITLE_CAP = 300;

// A message from the bridge, validated: the token must match, the shape must be one the bridge
// sends, and the route must be a path on the app's own origin. Anything else is null (dropped).
export function readBridgeMessage(data: unknown, token: string): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.token !== token) return null;
  if (d.type === "leave") return { type: "leave", token };
  if (d.type !== "ready" && d.type !== "nav") return null;
  if (typeof d.route !== "string" || !d.route.startsWith("/") || d.route.startsWith("//"))
    return null;
  const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
  return {
    type: d.type,
    token,
    route: d.route.slice(0, ROUTE_CAP),
    title: typeof d.title === "string" ? d.title.slice(0, TITLE_CAP) : "",
    canGoBack: flag(d.canGoBack),
    canGoForward: flag(d.canGoForward),
  };
}

// The address bar's input as a route on the app: a path as typed (a leading "/" added), or a full
// URL on one of `origins` (the dev server's or the proxy's) reduced to its path. Null for anything
// that would leave the app.
export function routeFromInput(input: string, origins: readonly string[]): string | null {
  const raw = input.trim();
  if (!raw || raw.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try {
      const url = new URL(raw);
      return origins.includes(url.origin) ? url.pathname + url.search + url.hash : null;
    } catch {
      return null;
    }
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}
