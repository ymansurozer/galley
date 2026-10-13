import type { UiSource } from "../types";

// Which source rendered an element, read from what a framework's dev build leaves on the page.
// Resolvers are tried in order and the first answer wins, so another framework's (React's) slots in
// beside Vue's. None of what they read is public API: a resolver that throws or meets an odd shape
// is no answer, and the element simply has no source. Read-only, and pure over the element's
// window, so it runs under happy-dom in tests.

type Resolver = (el: Element) => UiSource | undefined;
const RESOLVERS: Resolver[] = [vueSource];

export function resolveSource(el: Element): UiSource | undefined {
  for (const resolve of RESOLVERS) {
    const source = attempt(() => resolve(el));
    if (source) return source;
  }
  return undefined;
}

function attempt<T>(fn: () => T | undefined): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// ── Vue ─────────────────────────────────────────────────────────────────────────────────────────
// Vue's dev build marks each element with its vnode (`__vnode`) and the component instance whose
// subtree it was mounted in (`__vueParentComponent`, chained up by `.parent`). A component's type
// carries its SFC's absolute path (`__file`) and name (`__name`). vite-plugin-vue-tracer (installed
// by Nuxt DevTools) adds `__vue_tracer__.vnodeToPos`: a vnode's props object → the template
// position that created it, `[file, line, column]`, the file relative to the dev server's cwd and
// the column 0-based. Everything is typed `unknown` and checked as it's read.

type Obj = Record<string, unknown>;
type Pos = { file: string; line: number; column: number };

const isObj = (v: unknown): v is Obj => !!v && (typeof v === "object" || typeof v === "function");
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
// Paths as the dev server hands them out, minus what is unambiguously not part of the file: Vite's
// `/@fs` prefix for files outside its root (`/@fs/C:/…` on Windows), and a query
// (`?vue&type=template`).
const cleanPath = (p: string) =>
  p.replace(/^\/@fs(?:\/(?=[A-Za-z]:)|(?=\/))/, "").replace(/\?.*$/, "");
const isVendor = (file: string) => /(^|\/)node_modules\//.test(file);

function vueSource(el: Element): UiSource | undefined {
  const chain = components(el);
  if (!chain.length) return undefined;
  return attempt(() => fromTracer(el, chain)) ?? attempt(() => fromComponentFile(chain));
}

// The component instances around an element, innermost first. Bounded, and a cycle ends it.
function components(el: Element): Obj[] {
  const out: Obj[] = [];
  let inst = (el as unknown as Obj).__vueParentComponent;
  while (isObj(inst) && !out.includes(inst) && out.length < 200) {
    out.push(inst);
    inst = inst.parent;
  }
  return out;
}

const fileOf = (inst: Obj) => {
  const file = isObj(inst.type) ? str(inst.type.__file) : undefined;
  return file && cleanPath(file);
};
const nameOf = (inst: Obj) =>
  isObj(inst.type) ? (str(inst.type.__name) ?? str(inst.type.name)) : undefined;

// The exact template position. The element's own position when the app's template created it;
// when a library's did, the nearest place the app uses a library component around it, flagged
// vendor. If the walk reaches an app component without finding an app position inside it, the
// tracer doesn't know this element (a render function, a vnode cloned with new props), and the
// component's file is the honest answer: no answer here.
function fromTracer(el: Element, chain: Obj[]): UiSource | undefined {
  const tracer = (el.ownerDocument.defaultView as unknown as Obj | null)?.__vue_tracer__;
  const map = isObj(tracer) ? tracer.vnodeToPos : undefined;
  if (!(map instanceof WeakMap)) return undefined;
  const posOf = (vnode: unknown): Pos | undefined => {
    const props = isObj(vnode) ? vnode.props : undefined;
    return isObj(props) ? readPos(map.get(props)) : undefined;
  };

  const own = posOf((el as unknown as Obj).__vnode);
  if (own && !isVendor(own.file)) return located(own, chain, false);
  let vendor = !!own;
  for (const [i, inst] of chain.entries()) {
    const file = fileOf(inst);
    if (file && !isVendor(file)) return undefined;
    if (file) vendor = true;
    const use = posOf(inst.vnode);
    if (!use) continue;
    if (isVendor(use.file)) vendor = true;
    else return located(use, chain.slice(i + 1), vendor);
  }
  return undefined;
}

function readPos(v: unknown): Pos | undefined {
  if (!Array.isArray(v)) return undefined;
  const [file, line, column] = v as unknown[];
  if (!str(file) || !Number.isSafeInteger(line) || (line as number) < 1) return undefined;
  if (!Number.isSafeInteger(column) || (column as number) < 0) return undefined;
  return { file: cleanPath(file as string), line: line as number, column: (column as number) + 1 };
}

// A tracer position as a source. Its file is relative to the dev server's cwd, which the desk can't
// know (in a monorepo it is the app's package, not the repo), so it is swapped for the absolute
// path of the component whose template it is: the nearest instance in `owners` whose file ends
// with it (past any leading `../`). That component also names it.
function located(pos: Pos, owners: Obj[], vendor: boolean): UiSource {
  const owner = owners.find((inst) => {
    const file = fileOf(inst);
    return file === pos.file || !!file?.endsWith(`/${pos.file.replace(/^(\.\.?\/)+/, "")}`);
  });
  const source: UiSource = {
    file: (owner && fileOf(owner)) ?? pos.file,
    line: pos.line,
    column: pos.column,
    via: "vue-tracer",
  };
  const component = owner && nameOf(owner);
  if (component) source.component = component;
  if (vendor) source.vendor = true;
  return source;
}

// Without the tracer: the nearest app component's file and name, no line. Library components on
// the way flag the element vendor.
function fromComponentFile(chain: Obj[]): UiSource | undefined {
  let vendor = false;
  for (const inst of chain) {
    const file = fileOf(inst);
    if (!file) continue;
    if (isVendor(file)) {
      vendor = true;
      continue;
    }
    const source: UiSource = { file, via: "vue-file" };
    const component = nameOf(inst);
    if (component) source.component = component;
    if (vendor) source.vendor = true;
    return source;
  }
  return undefined;
}
