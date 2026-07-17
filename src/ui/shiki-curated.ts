// The single curated Shiki theme + language set, deep-imported so only these grammars are
// bundled (shiki's full bundle statically references ~180 grammars + a 607 KB oniguruma wasm).
// Consumed by BOTH markdown.ts (comment/file fenced code) and shiki-shim.ts (the diff view via
// @pierre/diffs) — one language set styles both surfaces. The theme names match the settings
// picker, so switching a theme restyles diff and markdown together.
//
// Languages outside this set degrade to plain text: markdown-it falls back via fallbackLanguage,
// and the shim's bundledLanguages Proxy hands @pierre/diffs an empty-patterns grammar. Adding a
// language here is the one place to grow coverage — keep it lean, the build gates on bundle size.
import palenight from "shiki/dist/themes/material-theme-palenight.mjs";
import materialDarker from "shiki/dist/themes/material-theme-darker.mjs";
import githubDark from "shiki/dist/themes/github-dark.mjs";
import githubLight from "shiki/dist/themes/github-light.mjs";
import dracula from "shiki/dist/themes/dracula.mjs";
import ayuDark from "shiki/dist/themes/ayu-dark.mjs";
import gruvbox from "shiki/dist/themes/gruvbox-dark-medium.mjs";
import everforest from "shiki/dist/themes/everforest-dark.mjs";
import darkPlus from "shiki/dist/themes/dark-plus.mjs";
import javascript from "shiki/dist/langs/javascript.mjs";
import typescript from "shiki/dist/langs/typescript.mjs";
import tsx from "shiki/dist/langs/tsx.mjs";
import jsx from "shiki/dist/langs/jsx.mjs";
import vue from "shiki/dist/langs/vue.mjs";
import json from "shiki/dist/langs/json.mjs";
import html from "shiki/dist/langs/html.mjs";
import xml from "shiki/dist/langs/xml.mjs";
import css from "shiki/dist/langs/css.mjs";
import scss from "shiki/dist/langs/scss.mjs";
import python from "shiki/dist/langs/python.mjs";
import go from "shiki/dist/langs/go.mjs";
import rust from "shiki/dist/langs/rust.mjs";
import c from "shiki/dist/langs/c.mjs";
import cpp from "shiki/dist/langs/cpp.mjs";
import java from "shiki/dist/langs/java.mjs";
import bash from "shiki/dist/langs/bash.mjs";
import sql from "shiki/dist/langs/sql.mjs";
import yaml from "shiki/dist/langs/yaml.mjs";
import markdownLang from "shiki/dist/langs/markdown.mjs";
import diff from "shiki/dist/langs/diff.mjs";
import toml from "shiki/dist/langs/toml.mjs";
import ruby from "shiki/dist/langs/ruby.mjs";
import php from "shiki/dist/langs/php.mjs";
import dockerfile from "shiki/dist/langs/dockerfile.mjs";

// Keyed by theme name (matches the settings picker). Diff-only themes (pierre-*) aren't here —
// @pierre/diffs registers those itself as custom CSS-variable themes.
export const CURATED_THEMES: Record<string, unknown> = {
  "material-theme-palenight": palenight,
  "material-theme-darker": materialDarker,
  "github-dark": githubDark,
  // Light code theme — used for both the diff and comment/markdown code when the chrome is in
  // light mode (see codeTheme in settings.ts). Registered here so @pierre resolves it too.
  "github-light": githubLight,
  dracula: dracula,
  "ayu-dark": ayuDark,
  "gruvbox-dark-medium": gruvbox,
  "everforest-dark": everforest,
  "dark-plus": darkPlus,
};

export const CURATED_LANGS = [
  javascript,
  typescript,
  tsx,
  jsx,
  vue,
  json,
  html,
  xml,
  css,
  scss,
  python,
  go,
  rust,
  c,
  cpp,
  java,
  bash,
  sql,
  yaml,
  markdownLang,
  diff,
  toml,
  ruby,
  php,
  dockerfile,
];
