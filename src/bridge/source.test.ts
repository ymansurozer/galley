import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { describeElement } from "./describe";
import { resolveSource } from "./source";

// A stand-in for a Nuxt dev page: elements carry Vue's dev expandos (`__vnode`,
// `__vueParentComponent`), component instances chain up by `parent`, and the tracer maps vnode
// props to `[file, line, 0-based column]` with files relative to the dev server's cwd (the app's
// package in a monorepo), the way vite-plugin-vue-tracer records them.
const APP = "/home/dev/shop/apps/web";
const UI =
  "/home/dev/shop/node_modules/.pnpm/@nuxt+ui@4/node_modules/@nuxt/ui/dist/runtime/components";
const UI_REL = "../../node_modules/.pnpm/@nuxt+ui@4/node_modules/@nuxt/ui/dist/runtime/components";

type Pos = [string, number, number];
type Inst = { type: Record<string, unknown>; parent: Inst | null; vnode: { props: object } };

function world(html: string) {
  const window = new Window();
  const document = window.document;
  document.body.innerHTML = html;
  const positions = new WeakMap<object, Pos>();
  const vnode = (pos?: Pos) => {
    const props = {};
    if (pos) positions.set(props, pos);
    return { props };
  };
  const tracer = () =>
    Object.defineProperty(window, "__vue_tracer__", {
      value: { hasData: true, vnodeToPos: positions },
      configurable: true,
    });
  const component = (type: Record<string, unknown>, parent: Inst | null, use?: Pos): Inst => ({
    type,
    parent,
    vnode: vnode(use),
  });
  // Mark an element as Vue mounts it: its vnode (traced at `pos`, if given) and its component.
  const mount = (sel: string, inst: Inst, pos?: Pos) => {
    const el = document.querySelector(sel) as unknown as Element;
    Object.assign(el, { __vnode: vnode(pos), __vueParentComponent: inst });
    return el;
  };
  return { window, document, tracer, component, mount };
}

// The app's layout and a page in it; the page uses Nuxt UI's UButton (which renders through ULink,
// ULinkBase and reka-ui's script-only Primitive) and a UBadge.
function shop() {
  const w = world(`
    <main><h1>Files</h1><div class="card"><p id="slotted">Slotted</p></div>
    <button id="upload">Upload</button><span id="badge">New</span><i id="loose"></i></main>`);
  const layout = w.component({ __file: `${APP}/app/layouts/default.vue`, __name: "default" }, null);
  const page = w.component({ __file: `${APP}/app/pages/files.vue`, __name: "files" }, layout, [
    "app/layouts/default.vue",
    4,
    4,
  ]);
  const card = w.component({ __file: `${UI}/Card.vue`, __name: "UCard" }, page, [
    "app/pages/files.vue",
    9,
    4,
  ]);
  const button = w.component({ __file: `${UI}/Button.vue`, __name: "UButton" }, page, [
    "app/pages/files.vue",
    20,
    6,
  ]);
  const link = w.component({ __file: `${UI}/Link.vue`, __name: "ULink" }, button, [
    `${UI_REL}/Button.vue`,
    118,
    2,
  ]);
  const linkBase = w.component({ __file: `${UI}/LinkBase.vue`, __name: "ULinkBase" }, link);
  const primitive = w.component({ name: "Primitive" }, linkBase, [`${UI_REL}/LinkBase.vue`, 3, 2]);
  const badge = w.component({ __file: `${UI}/Badge.vue`, __name: "UBadge" }, page, [
    "app/pages/files.vue",
    22,
    6,
  ]);
  return {
    ...w,
    h1: w.mount("h1", page, ["app/pages/files.vue", 8, 4]),
    // Written in the page's template, mounted inside UCard's slot.
    slotted: w.mount("#slotted", card, ["app/pages/files.vue", 10, 6]),
    // Created by Primitive's render function: the tracer has no position for it.
    upload: w.mount("#upload", primitive),
    // Created in UBadge's own template.
    badgeSpan: w.mount("#badge", badge, [`${UI_REL}/Badge.vue`, 2, 2]),
  };
}

test("with the tracer, an element in the app's template gives its file, line and column", () => {
  const s = shop();
  s.tracer();
  assert.deepEqual(resolveSource(s.h1), {
    file: `${APP}/app/pages/files.vue`,
    line: 8,
    column: 5,
    component: "files",
    via: "vue-tracer",
  });
  // Slot content is the page's, though a library component mounted it.
  assert.deepEqual(resolveSource(s.slotted), {
    file: `${APP}/app/pages/files.vue`,
    line: 10,
    column: 7,
    component: "files",
    via: "vue-tracer",
  });
  assert.deepEqual(describeElement(s.h1).source, resolveSource(s.h1));
});

test("without the tracer, an element gives its component's file and name, no line", () => {
  const s = shop();
  assert.deepEqual(resolveSource(s.h1), {
    file: `${APP}/app/pages/files.vue`,
    component: "files",
    via: "vue-file",
  });
});

test("an element a library renders points at where the app uses the library, flagged vendor", () => {
  const s = shop();
  s.tracer();
  const usage = (line: number, column: number) => ({
    file: `${APP}/app/pages/files.vue`,
    line,
    column,
    component: "files",
    vendor: true,
    via: "vue-tracer",
  });
  assert.deepEqual(resolveSource(s.upload), usage(20, 7));
  assert.deepEqual(resolveSource(s.badgeSpan), usage(22, 7));

  const bare = shop();
  for (const el of [bare.upload, bare.badgeSpan])
    assert.deepEqual(resolveSource(el), {
      file: `${APP}/app/pages/files.vue`,
      component: "files",
      vendor: true,
      via: "vue-file",
    });
});

test("an element nothing resolves has no source", () => {
  const s = shop();
  s.tracer();
  const loose = s.document.querySelector("#loose") as unknown as Element;
  assert.equal(resolveSource(loose), undefined);
  assert.equal(describeElement(loose).source, undefined);
  // Only library components around it, and no app position: nothing to point the agent at.
  const lib = s.component({ __file: `${UI}/App.vue`, __name: "UApp" }, null);
  const el = s.mount("#loose", lib, [`${UI_REL}/App.vue`, 5, 2]);
  assert.equal(resolveSource(el), undefined);
});

test("a throwing or garbage tracer falls back to the component's file", () => {
  const fileOnly = { file: `${APP}/app/pages/files.vue`, component: "files", via: "vue-file" };
  const tracers: unknown[] = [
    { vnodeToPos: { get: () => ["app/pages/files.vue", 8, 4] } }, // not a WeakMap
    { vnodeToPos: "nope" },
    null,
  ];
  for (const value of tracers) {
    const s = shop();
    Object.defineProperty(s.window, "__vue_tracer__", { value });
    assert.deepEqual(resolveSource(s.h1), fileOnly, JSON.stringify(value));
  }
  const throwing = shop();
  Object.defineProperty(throwing.window, "__vue_tracer__", {
    get() {
      throw new Error("internals changed");
    },
  });
  assert.deepEqual(resolveSource(throwing.h1), fileOnly);
  // Positions of the wrong shape are no position.
  for (const pos of [["app/pages/files.vue", "8", 4], [8, 4], ["", 8, 4], ["x.vue", 0, 0], "x"]) {
    const s = shop();
    s.tracer();
    Object.assign(s.h1, { __vnode: { props: {} } });
    const props = (s.h1 as unknown as { __vnode: { props: object } }).__vnode.props;
    const map = new WeakMap([[props, pos]]);
    Object.defineProperty(s.window, "__vue_tracer__", { value: { vnodeToPos: map } });
    assert.deepEqual(resolveSource(s.h1), fileOnly, JSON.stringify(pos));
  }
});

test("odd component chains end without a source or a hang", () => {
  const s = shop();
  s.tracer();
  // A cycle in the parent chain.
  const a = s.component({ name: "A" }, null);
  const b = s.component({ name: "B" }, a);
  a.parent = b;
  assert.equal(resolveSource(s.mount("#loose", a)), undefined);
  // An expando that throws when read.
  const loose = s.document.querySelector("#loose") as unknown as Element;
  Object.defineProperty(loose, "__vueParentComponent", {
    get() {
      throw new Error("no");
    },
  });
  assert.equal(resolveSource(loose), undefined);
});

test("paths lose a /@fs prefix and a query; an over-long one is refused, a long name cut", () => {
  const s = shop();
  const outside = s.component(
    { __file: "/@fs/home/dev/shop/packages/kit/Panel.vue?vue&type=script", __name: "Panel" },
    null,
  );
  assert.deepEqual(resolveSource(s.mount("#loose", outside)), {
    file: "/home/dev/shop/packages/kit/Panel.vue",
    component: "Panel",
    via: "vue-file",
  });
  // The capture caps it: a file past 1 KB is dropped, a component name cut to 200.
  const long = s.component({ __file: `/${"d/".repeat(600)}X.vue`, __name: "X" }, null);
  assert.equal(describeElement(s.mount("#loose", long)).source, undefined);
  const named = s.component({ __file: `${APP}/app/X.vue`, __name: "N".repeat(500) }, null);
  const component = describeElement(s.mount("#loose", named)).source!.component!;
  assert.equal(component.length, 200);
  assert.ok(component.endsWith("…"));
});
