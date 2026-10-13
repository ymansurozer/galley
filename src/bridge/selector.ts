// The selector ladder: a CSS selector for an element the reviewer picked, preferring what survives
// edits to the page. #id, then identity attributes, then word-like classes, then an nth-of-type
// path. Every rung is proven against the live document (it matches this element and nothing else)
// before it's accepted, so the agent can trust it as a locator for the page as it was captured.
// Pure over the element's document, so it runs under happy-dom in tests.

// Test hooks first, then the accessible and form names, then role.
const IDENTITY_ATTRS = [
  "data-testid",
  "data-test",
  "data-cy",
  "data-component",
  "aria-label",
  "name",
  "role",
];

// Classes that describe a state, not a thing: the last word of `tab-active`, `menu__item--open`.
const STATE_WORDS = new Set(
  "active current selected checked disabled enabled focus focused hover hovered open opened closed show shown hidden visible invisible expanded collapsed loading error invalid valid dirty pristine touched".split(
    " ",
  ),
);
// Prefixes CSS-in-JS and frameworks put on generated classes.
const GENERATED_PREFIX = /^(css|sc|jsx|svelte|emotion|ng|chakra|mui|tw)-/;
// Tailwind-style utilities: they say how a thing looks, so they change with every restyle. Those
// with a digit, a variant (`hover:`) or an arbitrary value are already out on their characters.
const UTILITY_WORDS = new Set(
  "flex grid block inline contents table relative absolute fixed sticky static truncate uppercase lowercase capitalize italic underline rounded border shadow outline ring grow shrink container antialiased transition transform isolate sr-only".split(
    " ",
  ),
);
const UTILITY_PREFIX =
  /^(flex|grid|inline|items|justify|self|place|gap|space|[pm][xytrblse]?|w|h|min|max|size|text|font|leading|tracking|bg|border|rounded|shadow|ring|outline|opacity|z|inset|overflow|cursor|pointer|transition|duration|ease|delay|animate|translate|scale|rotate|divide|fill|stroke|object|aspect|whitespace|break|decoration|backdrop|blur|drop)-/;

// A class that names a thing in words (`upload-button`, `matter-card__title`): letters joined by
// hyphens or underscores, no digits (hashes, counters), no variant or arbitrary-value syntax, and
// neither a state, a generated prefix nor a utility.
export function isWordClass(cls: string): boolean {
  if (cls.length < 2 || cls.length > 40) return false;
  if (!/^[a-z][a-z_-]*[a-z]$/i.test(cls)) return false;
  if (GENERATED_PREFIX.test(cls) || UTILITY_WORDS.has(cls) || UTILITY_PREFIX.test(cls))
    return false;
  const words = cls.toLowerCase().split(/[-_]+/);
  if (words[0] === "is" || words[0] === "has") return false;
  return !STATE_WORDS.has(words[words.length - 1]!);
}

// Ids a framework generated (`v-0-3`, `:r1:`, `headlessui-menu-3`) change between renders; a
// hand-written one has no digits.
const isStableId = (id: string) => id.length <= 64 && /^[a-z_][\w-]*$/i.test(id) && !/\d/.test(id);

// An attribute value in double quotes, escaped for CSS.
const quoted = (v: string) => `"${v.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;

export function selectorFor(el: Element): string {
  const doc = el.ownerDocument;
  const escape = (s: string) => doc.defaultView?.CSS.escape(s) ?? s;
  // Proven: matches this element and nothing else. A selector the engine can't parse isn't one.
  const proven = (sel: string) => {
    try {
      const all = doc.querySelectorAll(sel);
      return all.length === 1 && all[0] === el;
    } catch {
      return false;
    }
  };
  const tag = escape(el.localName);
  // The element's own handle: its id or an identity attribute, whichever is unique on the page.
  const handle = (node: Element, prove: (sel: string) => boolean) => {
    const nodeTag = escape(node.localName);
    if (node.id && isStableId(node.id) && prove(`#${escape(node.id)}`))
      return `#${escape(node.id)}`;
    for (const attr of IDENTITY_ATTRS) {
      const v = node.getAttribute(attr);
      if (!v || v.length > 100) continue;
      const sel = `${nodeTag}[${attr}=${quoted(v)}]`;
      if (prove(sel)) return sel;
    }
    return null;
  };

  const own = handle(el, proven);
  if (own) return own;

  const classes = [...el.classList].filter(isWordClass).slice(0, 4);
  for (const c of classes) if (proven(`${tag}.${escape(c)}`)) return `${tag}.${escape(c)}`;
  for (const [i, a] of classes.entries())
    for (const b of classes.slice(i + 1)) {
      const sel = `${tag}.${escape(a)}.${escape(b)}`;
      if (proven(sel)) return sel;
    }

  // Position: tag:nth-of-type steps up the tree until the path is unique, anchored on the nearest
  // ancestor with a handle of its own when there is one. From <body> down it's always unique.
  const unique = (sel: string) => {
    try {
      return doc.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const steps: string[] = [];
  for (let node: Element | null = el; node && node !== doc.documentElement; ) {
    const parent: Element | null = node.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.localName === node!.localName) : [];
    const step =
      same.length > 1
        ? `${escape(node.localName)}:nth-of-type(${same.indexOf(node) + 1})`
        : escape(node.localName);
    steps.unshift(step);
    if (proven(steps.join(" > "))) return steps.join(" > ");
    if (parent && parent !== doc.body && parent !== doc.documentElement) {
      const anchor = handle(parent, unique);
      if (anchor && proven(`${anchor} > ${steps.join(" > ")}`))
        return `${anchor} > ${steps.join(" > ")}`;
    }
    node = parent;
  }
  return steps.join(" > ");
}
