import type {
  AppMode,
  BridgeMessage,
  BridgeShot,
  ForwardedKey,
  Rect,
  UiCaps,
  UiElement,
  UiPage,
} from "./types";

// Pure helpers for the UI view's traffic with the bridge (kept free of the store so they unit-test
// without a DOM). The app page is untrusted: what it posts is re-validated and capped here before
// it touches the store. The server checks a saved annotation against the same caps again.

const CAPS: UiCaps = {
  selector: 512,
  text: 300,
  name: 200,
  outline: 2048,
  attrs: 12,
  attr: 200,
  url: 2048,
  route: 2048,
  title: 300,
  elements: 16,
};
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
  if (d.type === "picked") return readPicked(d, token);
  if (d.type === "anchor") {
    const rect = readRect(d.rect);
    return rect && { type: "anchor", token, rect };
  }
  if (d.type === "select")
    return typeof d.id === "string" && d.id.length <= 64
      ? { type: "select", token, id: d.id }
      : null;
  if (d.type === "key") {
    const k = forwardedKey(d);
    return k && { type: "key", token, ...k };
  }
  if (d.type !== "ready" && d.type !== "nav") return null;
  if (!isRoute(d.route)) return null;
  const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
  return {
    type: d.type,
    token,
    route: d.route.slice(0, CAPS.route),
    title: typeof d.title === "string" ? d.title.slice(0, CAPS.title) : "",
    canGoBack: flag(d.canGoBack),
    canGoForward: flag(d.canGoForward),
  };
}

// The keys an app page may pass up, and only in this form: ⌥A, and Esc and the UI view's ⇧ chords
// (sidebar, next / previous annotation, Code / UI). The desk runs them through its own hotkey
// table, so anything that sends, resets, approves or confirms (⇧S, ⇧R, ⇧A, Enter) is refused here:
// a page could post any key it likes.
const SHIFT_CHORDS: Record<string, string> = {
  L: "KeyL",
  U: "KeyU",
  ArrowDown: "ArrowDown",
  ArrowUp: "ArrowUp",
};
function forwardedKey(d: Obj): ForwardedKey | null {
  const { key, code, shiftKey, altKey } = d;
  if (typeof shiftKey !== "boolean" || typeof altKey !== "boolean") return null;
  // ⌥A by its code: on a Mac layout its key is "å".
  if (code === "KeyA" && altKey && !shiftKey)
    return { key: "a", code: "KeyA", shiftKey: false, altKey: true };
  if (key === "Escape" && !shiftKey && !altKey)
    return { key: "Escape", code: "Escape", shiftKey: false, altKey: false };
  if (typeof key === "string" && shiftKey && !altKey && Object.hasOwn(SHIFT_CHORDS, key))
    return { key, code: SHIFT_CHORDS[key]!, shiftKey: true, altKey: false };
  return null;
}

// Whether a key passed up from the app runs: ⌥A always; the rest only while annotating, since in
// Interact mode the app's keys are its own (Esc included).
export const forwardedKeyRuns = (k: ForwardedKey, mode: AppMode) =>
  mode === "annotate" || (k.code === "KeyA" && k.altKey);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
// A path on the app's own origin. Absolute and protocol-relative URLs lead elsewhere, and so does a
// backslash in the path, which the URL parser reads as a slash (`/\evil.example`). Routes carry no
// control characters.
function isRoute(v: unknown): v is string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//")) return false;
  const path = v.split(/[?#]/, 1)[0]!;
  return !path.includes("\\") && ![...v].some((c) => c < " " || c === "\x7f");
}
// Cut to `max` characters, ending in "…" so the reader knows.
const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const capped = (v: unknown, max: number) => (typeof v === "string" && v ? cap(v, max) : undefined);
const ATTR_NAME = /^[a-z][\w.:-]{0,63}$/i;

function readRect(v: unknown): Rect | null {
  if (!isObj(v)) return null;
  const { x, y, width, height } = v;
  return finite(x) && finite(y) && finite(width) && finite(height) ? { x, y, width, height } : null;
}

function readElement(v: unknown): UiElement | null {
  if (!isObj(v)) return null;
  const { selector, tag } = v;
  // A selector can't be cut short: a cut one matches something else, or nothing.
  if (typeof selector !== "string" || !selector || selector.length > CAPS.selector) return null;
  if (typeof tag !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(tag)) return null;
  const rect = readRect(v.rect);
  if (!rect) return null;
  const el: UiElement = { selector, tag, rect };
  const text = capped(v.text, CAPS.text);
  if (text) el.text = text;
  for (const key of ["role", "name", "landmark", "heading"] as const) {
    const s = capped(v[key], CAPS.name);
    if (s) el[key] = s;
  }
  const outline = capped(v.outline, CAPS.outline);
  if (outline) el.outline = outline;
  if (isObj(v.attrs))
    el.attrs = Object.fromEntries(
      Object.entries(v.attrs)
        .filter((e): e is [string, string] => ATTR_NAME.test(e[0]) && typeof e[1] === "string")
        .slice(0, CAPS.attrs)
        .map(([k, s]) => [k, cap(s, CAPS.attr)]),
    );
  return el;
}

function readPicked(d: Obj, token: string): BridgeMessage | null {
  const page = d.page;
  const target = d.target;
  if (!isObj(page) || !isRoute(page.route) || !isObj(page.viewport)) return null;
  const { width, height, dpr } = page.viewport;
  if (![width, height, dpr].every((n) => finite(n) && n > 0)) return null;
  if (!isObj(target) || target.kind !== "element" || !Array.isArray(target.elements)) return null;
  const sent = target.elements.slice(0, CAPS.elements);
  const elements = sent.map(readElement).filter((e) => e !== null);
  // One bad element spoils the pick: the reviewer pointed at all of them.
  if (!elements.length || elements.length !== sent.length) return null;
  const view: Omit<UiPage, "url"> = {
    route: cap(page.route, CAPS.route),
    viewport: { width: width as number, height: height as number, dpr: dpr as number },
  };
  const title = capped(page.title, CAPS.title);
  if (title) view.title = title;
  return {
    type: "picked",
    token,
    page: view,
    target: { kind: "element", elements },
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
      // Settling deletes the entry being visited, which a Map iterator tolerates.
      for (const settle of pending.values()) settle(new Error(reason));
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
