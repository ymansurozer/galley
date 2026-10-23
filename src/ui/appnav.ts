import type {
  AppMode,
  BridgeMessage,
  BridgeShot,
  ForwardedKey,
  PickedTarget,
  Rect,
  UiCaps,
  UiElement,
  UiPage,
  UiSource,
} from "./types";

// Pure helpers for the UI view's traffic with the bridge and the desk's UI status (kept free of the
// store so they unit-test without a DOM). The app page is untrusted: what it posts is re-validated
// and capped here before it touches the store. The server checks a saved annotation against the
// same caps again.

const CAPS: UiCaps = {
  selector: 512,
  file: 1024,
  text: 300,
  name: 200,
  outline: 2048,
  attrs: 12,
  attr: 200,
  url: 2048,
  route: 2048,
  title: 300,
  quote: 500,
  elements: 16,
  shot: 33_554_432,
};
const ERROR_CAP = 300;
// Far past the annotations one page carries: a page posting more is posting junk.
const PLACEMENTS_CAP = 1000;
type Placements = Extract<BridgeMessage, { type: "placements" }>["placements"];

const isPng = (v: unknown): v is Blob =>
  v instanceof Blob && v.type === "image/png" && v.size <= CAPS.shot;

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
  if (d.type === "pending") {
    const { count } = d;
    return Number.isSafeInteger(count) &&
      (count as number) >= 0 &&
      (count as number) <= CAPS.elements
      ? { type: "pending", token, count: count as number }
      : null;
  }
  if (d.type === "anchor") {
    const rect = readRect(d.rect);
    return rect && { type: "anchor", token, rect };
  }
  if (d.type === "pins") {
    const { clicked } = d;
    if (!Array.isArray(d.pins) || !(clicked === undefined || clicked === null || isId(clicked)))
      return null;
    const pins = d.pins
      .slice(0, PLACEMENTS_CAP)
      .filter(isObj)
      .flatMap(({ id, rect }) => {
        const r = readRect(rect);
        return isId(id) && r ? [{ id, rect: r }] : [];
      });
    return { type: "pins", token, pins, ...(clicked !== undefined && { clicked }) };
  }
  if (d.type === "placements") {
    if (!Array.isArray(d.placements)) return null;
    const placements: Placements = d.placements
      .slice(0, PLACEMENTS_CAP)
      .filter(isObj)
      .flatMap(({ id, placement }) =>
        typeof id === "string" &&
        id.length <= 64 &&
        (placement === "placed" || placement === "unplaced")
          ? [{ id, placement }]
          : [],
      );
    return { type: "placements", token, placements };
  }
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

// The keys an app page may pass up, and only in this form: ⌥A, ⌥P (annotate the page), and Esc and
// the UI view's ⇧ chords (next / previous annotation, Code / App). The desk runs them
// through its own hotkey table, so anything that sends, resets, approves or confirms (⇧S, ⇧R, ⇧A,
// Enter) is refused here: a page could post any key it likes.
const SHIFT_CHORDS: Record<string, string> = {
  U: "KeyU",
  ArrowDown: "ArrowDown",
  ArrowUp: "ArrowUp",
};
function forwardedKey(d: Obj): ForwardedKey | null {
  const { key, code, shiftKey, altKey } = d;
  if (typeof shiftKey !== "boolean" || typeof altKey !== "boolean") return null;
  // ⌥A and ⌥P by their codes: on a Mac layout their keys are "å" and "π".
  if (code === "KeyA" && altKey && !shiftKey)
    return { key: "a", code: "KeyA", shiftKey: false, altKey: true };
  if (code === "KeyP" && altKey && !shiftKey)
    return { key: "p", code: "KeyP", shiftKey: false, altKey: true };
  if (key === "Escape" && !shiftKey && !altKey)
    return { key: "Escape", code: "Escape", shiftKey: false, altKey: false };
  if (typeof key === "string" && shiftKey && !altKey && Object.hasOwn(SHIFT_CHORDS, key))
    return { key, code: SHIFT_CHORDS[key]!, shiftKey: true, altKey: false };
  return null;
}

// Whether `galley reload` ran since the tab last adopted the desk's reload counter
// (DeskStatus.reloadGeneration): it went up within one desk process. A new process counts from 0
// again, so it's only a new baseline: a different proxy token says so, and so does a counter that
// went back, which is all a desk without a UI target (no token) shows. A reload is the agent coming
// back from a Send whether or not the diff moved: on a UI-only desk the counter is the only thing
// that does.
export const reloadRan = (
  adopted: { token: string | undefined; generation: number },
  polled: { token: string | undefined; generation: number },
) => adopted.token === polled.token && polled.generation > adopted.generation;

// Whether to load the app in the background while the code view shows, so the first switch to the
// UI view finds it loaded: there's an app (a target, the proxy up), nothing has loaded it yet, and
// the desk's first diff render has finished, so warming never slows opening the desk. The UI view
// loads the app itself on the way in, so a UI-only desk never warms.
export const shouldWarm = (desk: {
  rendered: boolean;
  proxy: boolean;
  target: boolean;
  view: "code" | "ui";
  loaded: boolean;
}) => desk.rendered && desk.proxy && desk.target && desk.view === "code" && !desk.loaded;

// Whether a key passed up from the app runs: ⌥A always; the rest only while annotating, since in
// Interact mode the app's keys are its own (Esc included).
export const forwardedKeyRuns = (k: ForwardedKey, mode: AppMode) =>
  mode === "annotate" || (k.code === "KeyA" && k.altKey);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
// An annotation id, as the desk gave it to the page.
const isId = (v: unknown): v is string => typeof v === "string" && v.length <= 64;
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

// The source the page says rendered an element. Malformed, or a path over its cap (cut short, it
// would name another file), and the element stands without one.
function readSource(v: unknown): UiSource | undefined {
  if (!isObj(v) || typeof v.file !== "string" || !v.file || v.file.length > CAPS.file)
    return undefined;
  if ([...v.file].some((c) => c < " " || c === "\x7f")) return undefined;
  if (v.via !== "vue-tracer" && v.via !== "vue-file") return undefined;
  const source: UiSource = { file: v.file, via: v.via };
  for (const key of ["line", "column"] as const) {
    const n = v[key];
    if (n === undefined) continue;
    if (!Number.isSafeInteger(n) || (n as number) < 1) return undefined;
    source[key] = n as number;
  }
  const component = capped(v.component, CAPS.name);
  if (component) source.component = component;
  if (v.vendor === true) source.vendor = true;
  return source;
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
  const source = readSource(v.source);
  if (source) el.source = source;
  return el;
}

// A target's elements, at most CAPS.elements of them. One bad element spoils them all (null): the
// reviewer pointed at every one.
function readElements(v: unknown): UiElement[] | null {
  if (!Array.isArray(v)) return null;
  const sent = v.slice(0, CAPS.elements);
  const elements = sent.map(readElement).filter((e) => e !== null);
  return elements.length === sent.length ? elements : null;
}

// What the bridge picked: elements (at least one), a box with a size (its elements may be none),
// or a quote and the element holding it. Never a page: that's the desk's own target.
function readPickedTarget(v: unknown): PickedTarget | null {
  if (!isObj(v)) return null;
  if (v.kind === "element") {
    const elements = readElements(v.elements);
    return elements?.length ? { kind: "element", elements } : null;
  }
  if (v.kind === "region") {
    const rect = readRect(v.rect);
    const elements = readElements(v.elements);
    return rect && rect.width > 0 && rect.height > 0 && elements
      ? { kind: "region", rect, elements }
      : null;
  }
  if (v.kind === "text") {
    const element = readElement(v.element);
    const quote = typeof v.quote === "string" ? v.quote.trim() : "";
    return element && quote ? { kind: "text", quote: cap(quote, CAPS.quote), element } : null;
  }
  return null;
}

function readPicked(d: Obj, token: string): BridgeMessage | null {
  const page = d.page;
  if (!isObj(page) || !isRoute(page.route) || !isObj(page.viewport)) return null;
  const { width, height, dpr } = page.viewport;
  if (![width, height, dpr].every((n) => finite(n) && n > 0)) return null;
  const target = readPickedTarget(d.target);
  if (!target) return null;
  const view: Omit<UiPage, "url"> = {
    route: cap(page.route, CAPS.route),
    viewport: { width: width as number, height: height as number, dpr: dpr as number },
  };
  const title = capped(page.title, CAPS.title);
  if (title) view.title = title;
  return { type: "picked", token, page: view, target };
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
    has: (id: number) => pending.has(id),
    isBusy: () => pending.size > 0,
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

// Whether all of `work` settles, failures included, within `ms`: true once it has, false once `ms`
// passes first. Never rejects.
export function settledWithin(work: Iterable<Promise<unknown>>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  return Promise.race([Promise.allSettled(work).then(() => true), cap]).finally(() =>
    clearTimeout(timer),
  );
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
