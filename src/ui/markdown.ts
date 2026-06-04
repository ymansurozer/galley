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
import type { ReviewComment } from "./types";

// Curated Shiki theme + languages, deep-imported so only these are bundled (using
// shiki's full createHighlighter would pull ~200 unused grammars). The JS regex
// engine avoids a second oniguruma wasm.
import palenight from "shiki/dist/themes/material-theme-palenight.mjs";
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
const THEME = "material-theme-palenight";
const LANGS = [javascript, typescript, tsx, json, html, css, python, go, rust, c, cpp, java, bash, sql, yaml, markdownLang, diff, toml, ruby, php, dockerfile];

let md: MarkdownIt | null = null;
const cache = new Map<string, string>();

// Stamp each commentable block-open token with its 1-based source line (1-based
// matches @pierre/diffs' additions-side numbers). Top-level blocks AND list items,
// so a comment can target an individual list item rather than the whole list.
function sourceLine(mdi: MarkdownIt) {
  mdi.core.ruler.push("source_line", (state) => {
    for (const t of state.tokens) if (t.map && (t.level === 0 || t.type === "list_item_open")) t.attrSet("data-line", String(t.map[0] + 1));
    return true;
  });
}

// Shiki's highlighter loads async (wasm + grammars); markdown-it render is sync once
// ready. Until then renderMarkdown returns an escaped-text fallback; on ready we
// repaint once so any fallbacks upgrade to rendered markdown.
void (async () => {
  const hl = await createHighlighterCore({ themes: [palenight] as never, langs: LANGS as never, engine: createJavaScriptRegexEngine() });
  const instance = new MarkdownIt({ html: false, linkify: true })
    .use(footnote)
    .use(taskLists, { label: true })
    .use(fromHighlighter(hl, { theme: THEME, fallbackLanguage: "text" as never })) // unknown fences → plain
    .use(sourceLine);
  md = instance;
  if (S.state) render();
})();

// Render arbitrary markdown to sanitized HTML (data-* attributes, incl. data-line,
// are preserved by DOMPurify). Synchronous once the highlighter is ready.
export function renderMarkdown(text: string): string {
  if (!md) return `<p>${esc(text)}</p>`;
  return DOMPurify.sanitize(md.render(text || ""));
}

// Comment body → sanitized HTML, cached by id+updatedAt (so an edit re-renders).
export function renderCommentBody(c: ReviewComment): string {
  const key = `${c.id}:${c.updatedAt}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (!md) return `<p>${esc(c.body)}</p>`; // not ready yet — don't cache the fallback
  const html = renderMarkdown(c.body);
  cache.set(key, html);
  return html;
}
