import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
// markdown-it-task-lists ships no types and has no @types package.
// @ts-ignore
import taskLists from "markdown-it-task-lists";
import { fromHighlighter } from "@shikijs/markdown-it/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import DOMPurify from "dompurify";
import { S, esc } from "./store";
import { render } from "./render";
import { loadSettings } from "./settings";
import type { ReviewComment } from "./types";

// Curated Shiki themes + languages, deep-imported so only these are bundled (using
// shiki's full createHighlighter would pull ~200 unused grammars). The JS regex
// engine avoids a second oniguruma wasm. The theme set matches the settings picker
// (and @pierre/diffs loads the same names for the diff), so one theme styles both.
import palenight from "shiki/dist/themes/material-theme-palenight.mjs";
import materialDarker from "shiki/dist/themes/material-theme-darker.mjs";
import githubDark from "shiki/dist/themes/github-dark.mjs";
import dracula from "shiki/dist/themes/dracula.mjs";
import ayuDark from "shiki/dist/themes/ayu-dark.mjs";
import gruvbox from "shiki/dist/themes/gruvbox-dark-medium.mjs";
import everforest from "shiki/dist/themes/everforest-dark.mjs";
import darkPlus from "shiki/dist/themes/dark-plus.mjs";
import javascript from "shiki/dist/langs/javascript.mjs";
import typescript from "shiki/dist/langs/typescript.mjs";
import tsx from "shiki/dist/langs/tsx.mjs";
import json from "shiki/dist/langs/json.mjs";
import html from "shiki/dist/langs/html.mjs";
import css from "shiki/dist/langs/css.mjs";
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

// One markdown renderer for both comment bodies (#17) and markdown files (#21).
// markdown-it gives exact per-block source lines (token.map) — see sourceLine below —
// which is why we use it over comark; html:false drops raw HTML at the source, and
// DOMPurify is the final gate before anything is innerHTML'd (incl. agent-authored).
const THEMES: Record<string, unknown> = {
  "material-theme-palenight": palenight,
  "material-theme-darker": materialDarker,
  "github-dark": githubDark,
  dracula: dracula,
  "ayu-dark": ayuDark,
  "gruvbox-dark-medium": gruvbox,
  "everforest-dark": everforest,
  "dark-plus": darkPlus,
};
const LANGS = [
  javascript,
  typescript,
  tsx,
  json,
  html,
  css,
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

let md: MarkdownIt | null = null;
// A second renderer for comment bodies with `breaks: true`, so a single newline a reviewer types
// renders as a line break (people write comments as chat, not markdown source). File/guide
// markdown keeps the standard soft-break behavior via `md`, so hard-wrapped prose isn't shredded.
let mdComment: MarkdownIt | null = null;
let hl: Awaited<ReturnType<typeof createHighlighterCore>> | null = null;
const cache = new Map<string, string>();

// Stamp each commentable block-open token with its 1-based source line (1-based
// matches @pierre/diffs' additions-side numbers). Top-level blocks AND list items,
// so a comment can target an individual list item rather than the whole list.
function sourceLine(mdi: MarkdownIt) {
  mdi.core.ruler.push("source_line", (state) => {
    for (const t of state.tokens)
      if (t.map && (t.level === 0 || t.type === "list_item_open"))
        t.attrSet("data-line", String(t.map[0] + 1));
    return true;
  });
}

// Shiki's highlighter loads async (wasm + grammars); markdown-it render is sync once
// ready. Until then renderMarkdown returns an escaped-text fallback; on ready we
// repaint once so any fallbacks upgrade to rendered markdown.
function buildMd(theme: string, breaks = false): MarkdownIt {
  return new MarkdownIt({ html: false, linkify: true, breaks })
    .use(footnote)
    .use(taskLists, { label: true })
    .use(fromHighlighter(hl as never, { theme, fallbackLanguage: "text" as never })) // unknown fences → plain
    .use(sourceLine);
}

// All curated themes preload into one highlighter, so switching is instant.
void (async () => {
  hl = await createHighlighterCore({
    themes: Object.values(THEMES) as never,
    langs: LANGS as never,
    engine: createJavaScriptRegexEngine(),
  });
  const want = loadSettings().theme;
  const theme = THEMES[want] ? want : "github-dark";
  md = buildMd(theme);
  mdComment = buildMd(theme, true);
  if (S.state) render();
})();

// Switch the comment-code theme (settings) — rebuild the renderer + drop the cache;
// the caller re-renders. @pierre/diffs handles the diff side with the same theme name.
export function setMarkdownTheme(name: string) {
  if (!hl) return;
  // Diff-only themes (e.g. pierre-dark) aren't Shiki bundles → render comment code in github-dark.
  const theme = THEMES[name] ? name : "github-dark";
  md = buildMd(theme);
  mdComment = buildMd(theme, true);
  cache.clear();
}

// Render arbitrary markdown to sanitized HTML (data-* attributes, incl. data-line,
// are preserved by DOMPurify). Synchronous once the highlighter is ready.
export function renderMarkdown(text: string): string {
  if (!md) return `<p>${esc(text)}</p>`;
  return DOMPurify.sanitize(md.render(text || ""));
}

// One-line markdown (guide file summaries): inline rules only, no <p> wrapper. Block-only
// syntax degrades gracefully to its inline text — guide summaries are spec'd as one-liners.
export function renderMarkdownInline(text: string): string {
  if (!md) return esc(text);
  return DOMPurify.sanitize(md.renderInline(text || ""));
}

// Comment body → sanitized HTML, cached by id+updatedAt (so an edit re-renders).
export function renderCommentBody(c: ReviewComment): string {
  const key = `${c.id}:${c.updatedAt}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (!mdComment) return `<p>${esc(c.body)}</p>`; // not ready yet — don't cache the fallback
  const html = DOMPurify.sanitize(mdComment.render(c.body || ""));
  cache.set(key, html);
  return html;
}
