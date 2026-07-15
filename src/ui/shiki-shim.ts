// Stand-in for the bare `shiki` barrel, wired in only for @pierre/diffs by an esbuild onResolve
// plugin (see scripts/build-ui.mjs). @pierre/diffs imports shiki v3's full barrel, which statically
// references ~180 grammars + a 607 KB inlined oniguruma wasm — a second, near-complete copy of the
// shiki that markdown.ts already curates from shiki/core. This module exports exactly the surface
// @pierre/diffs pulls from `shiki`, backed by that same curated set (see shiki-curated.ts) built on
// shiki/core (v4) with the JavaScript regex engine — no wasm, no unused grammars.
//
// Galley's own deep imports (shiki/core, shiki/engine/javascript, shiki/dist/*) are NOT rerouted
// here — only @pierre/diffs' bare `shiki` specifier is.
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { CURATED_LANGS, CURATED_THEMES } from "./shiki-curated";

// Pure re-exports — utilities @pierre/diffs uses that don't drag the bundle in.
export {
  codeToHtml,
  createCssVariablesTheme,
  getTokenStyleObject,
  stringifyTokenStyle,
  normalizeTheme,
} from "shiki/core";
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// @pierre/diffs' shared_highlighter.js calls this once as
//   createHighlighter({ themes: [], langs: ["text"], engine })
// then attaches curated langs/themes lazily via loadLanguageSync/loadThemeSync (see resolveLanguage
// / resolveTheme, which read bundledLanguages/bundledThemes below). The barrel's createHighlighter
// closes over the FULL bundle; the core builder does not — so we start empty and let @pierre attach.
// The "text"/"ansi" placeholder langs it passes are strings core can't resolve, and @pierre skips
// them anyway, so we drop the incoming langs/themes and keep only the engine.
export function createHighlighter(options: { engine?: unknown }) {
  return createHighlighterCore({ engine: options.engine as never, langs: [], themes: [] });
}

// Never reached in practice: every @pierre code path defaults preferredHighlighter to "shiki-js"
// (the JS regex engine) and Galley never overrides it. But shared_highlighter.js statically
// references this symbol, so we must export it — and we force the JS engine rather than throw, so
// even a hypothetical "shiki-wasm" selection keeps working without pulling the oniguruma wasm.
// (The `import("shiki/wasm")` argument @pierre passes is aliased to an empty stub in the build.)
export function createOnigurumaEngine(_wasm?: unknown) {
  return createJavaScriptRegexEngine();
}

// A grammar with no patterns tokenizes every line as one default-scoped span → plain text, no
// syntax colors. Registered under the requested language name so @pierre's areLanguagesAttached()
// and shiki's own lookup both resolve it. scopeName is made unique + ascii-safe per language.
function plainGrammar(lang: string) {
  return {
    name: lang,
    scopeName: `source.galley-plain.${lang.replace(/[^a-zA-Z0-9_.-]/g, "-")}`,
    patterns: [],
  };
}

// resolveLanguage does `loader().then(({ default: data }) => …)`, so each loader resolves to
// `{ default: <grammar input> }`. We forward the FULL imported default (an array carrying the
// grammar's embedded-language deps), not just the primary grammar.
type LangLoader = () => Promise<{ default: unknown }>;

const plainLoaderCache = new Map<string, LangLoader>();
function plainLoader(lang: string): LangLoader {
  let loader = plainLoaderCache.get(lang);
  if (loader == null) {
    loader = () => Promise.resolve({ default: plainGrammar(lang) });
    plainLoaderCache.set(lang, loader);
  }
  return loader;
}

// Build name→loader for the curated set, keyed by each grammar's canonical name AND all its aliases
// (e.g. the "shellscript" grammar covers zsh/sh/bash/shell; yaml covers yml). These are the names
// @pierre/diffs' getFiletypeFromFileName() requests, so the key must match what it asks for.
const curatedLanguages: Record<string, LangLoader> = {};
for (const def of CURATED_LANGS) {
  const grammars = Array.isArray(def) ? def : [def];
  const primary = grammars[grammars.length - 1] as { name?: string; aliases?: string[] };
  const loader: LangLoader = () => Promise.resolve({ default: def });
  for (const key of [primary?.name, ...(primary?.aliases ?? [])])
    if (typeof key === "string") curatedLanguages[key] = loader;
}

// @pierre/diffs' resolveLanguage throws for any language not in bundledLanguages (guarded by
// Object.prototype.hasOwnProperty.call(bundledLanguages, lang)). This Proxy reports EVERY string
// key as present and hands back a curated loader, or a plain-text fallback for anything else — so an
// exotic-language file renders plain instead of throwing. hasOwnProperty consults
// getOwnPropertyDescriptor and `in` consults has, so both traps must agree with get.
export const bundledLanguages: Record<string, LangLoader> = new Proxy(curatedLanguages, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && !(prop in target)) return plainLoader(prop);
    return Reflect.get(target, prop, receiver);
  },
  has(target, prop) {
    if (typeof prop === "string") return true;
    return Reflect.has(target, prop);
  },
  getOwnPropertyDescriptor(target, prop) {
    if (typeof prop === "string" && !(prop in target))
      return { configurable: true, enumerable: false, writable: true, value: plainLoader(prop) };
    return Reflect.getOwnPropertyDescriptor(target, prop);
  },
});

// Curated theme loaders, keyed by theme name. resolveTheme requires theme.name === key, which holds
// (CURATED_THEMES is keyed by each theme's own name). Galley only ever requests these dark names
// plus pierre-light/pierre-dark, which @pierre registers itself as custom themes (checked first).
type ThemeLoader = () => Promise<{ default: unknown }>;
const curatedThemes: Record<string, ThemeLoader> = {};
for (const name of Object.keys(CURATED_THEMES))
  curatedThemes[name] = () => Promise.resolve({ default: CURATED_THEMES[name] });

export const bundledThemes: Record<string, ThemeLoader> = curatedThemes;
