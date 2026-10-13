import type { BridgeMessage, BridgeShot } from "./types";

// Pure helpers for the UI view's traffic with the bridge (kept free of the store so they unit-test
// without a DOM). The app page is untrusted: what it posts is re-validated and capped here before
// it touches the store.

const ROUTE_CAP = 2048;
const TITLE_CAP = 300;
const ERROR_CAP = 300;
// Far past any real viewport render (3840 × 2160 device px is ~33 MB of raw RGBA, and PNG packs UI
// screens well below that), so only a page posting junk hits it.
const SHOT_CAP = 32 * 1024 * 1024;

const isPng = (v: unknown): v is Blob =>
  v instanceof Blob && v.type === "image/png" && v.size <= SHOT_CAP;

// A message from the bridge, validated: the token must match, the shape must be one the bridge
// sends, the route must be a path on the app's own origin, and screenshots must be PNG blobs
// within the cap. Anything else is null (dropped).
export function readBridgeMessage(data: unknown, token: string): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.token !== token) return null;
  if (d.type === "leave") return { type: "leave", token };
  if (d.type === "captured") return readCaptured(d, token);
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

function readCaptured(d: Record<string, unknown>, token: string): BridgeMessage | null {
  const id = d.id;
  if (typeof id !== "number") return null;
  if (typeof d.error === "string")
    return { type: "captured", token, id, error: d.error.slice(0, ERROR_CAP) };
  const s = d.shot;
  if (!s || typeof s !== "object") return null;
  const { viewport, crop, ms } = s as Record<string, unknown>;
  if (!isPng(viewport) || (crop !== null && !isPng(crop))) return null;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return { type: "captured", token, id, shot: { viewport, crop, ms } };
}

// Captures awaiting the bridge's reply, by request id. Each settles once: with its reply (a shot or
// an error), with `abandon` when the page leaves and no reply can come, or on its own after
// `timeoutMs`. A reply for an id that already settled is ignored.
export function captureWaits(timeoutMs: number) {
  const pending = new Map<number, (reply: BridgeShot | Error) => void>();
  return {
    wait(id: number) {
      return new Promise<BridgeShot>((resolve, reject) => {
        const settle = (reply: BridgeShot | Error) => {
          clearTimeout(timer);
          pending.delete(id);
          if (reply instanceof Error) reject(reply);
          else resolve(reply);
        };
        const timer = setTimeout(
          () => settle(new Error("The app page didn't answer the capture")),
          timeoutMs,
        );
        pending.set(id, settle);
      });
    },
    settle(id: number, reply: BridgeShot | Error) {
      pending.get(id)?.(reply);
    },
    abandon(reason: string) {
      for (const settle of [...pending.values()]) settle(new Error(reason));
    },
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
