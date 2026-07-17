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

// The curated Shiki theme + language set is shared with the diff view (@pierre/diffs, via
// shiki-shim.ts) so one language set styles both surfaces — see shiki-curated.ts. The JS regex
// engine (below) avoids an oniguruma wasm, and the theme names match the settings picker.
import { CURATED_LANGS as LANGS, CURATED_THEMES as THEMES } from "./shiki-curated";

// One markdown renderer for both comment bodies (#17) and markdown files (#21).
// markdown-it gives exact per-block source lines (token.map) — see sourceLine below —
// which is why we use it over comark; html:false drops raw HTML at the source, and
// DOMPurify is the final gate before anything is innerHTML'd (incl. agent-authored).

let md: MarkdownIt | null = null;
// A second renderer for comment bodies with `breaks: true`, so a single newline a reviewer types
// renders as a line break (people write comments as chat, not markdown source). File/guide
// markdown keeps the standard soft-break behavior via `md`, so hard-wrapped prose isn't shredded.
let mdComment: MarkdownIt | null = null;
let hl: Awaited<ReturnType<typeof createHighlighterCore>> | null = null;
// Comment bodies re-render on every poll tick, and each edit mints a fresh id:updatedAt key —
// so the cache would grow without bound (an orphaned entry per edit) if left uncapped. An LRU
// keeps it bounded like the other UI caches (contents.ts, render.ts both cap at 30).
const COMMENT_CACHE_CAP = 30;
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

// Diff-only themes (e.g. pierre-dark) aren't Shiki bundles → render comment code in the
// GitHub theme matching the chrome appearance (applyAppearance sets <html data-theme>).
function resolveTheme(want: string): string {
  if (THEMES[want]) return want;
  return document.documentElement.dataset.theme === "light" ? "github-light" : "github-dark";
}

// All curated themes preload into one highlighter, so switching is instant.
void (async () => {
  hl = await createHighlighterCore({
    themes: Object.values(THEMES) as never,
    langs: LANGS as never,
    engine: createJavaScriptRegexEngine(),
  });
  const theme = resolveTheme(loadSettings().theme);
  md = buildMd(theme);
  mdComment = buildMd(theme, true);
  if (S.state) render();
})();

// Switch the comment-code theme (settings) — rebuild the renderer + drop the cache;
// the caller re-renders. @pierre/diffs handles the diff side with the same theme name.
export function setMarkdownTheme(name: string) {
  if (!hl) return;
  const theme = resolveTheme(name);
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
  if (cached !== undefined) {
    cache.delete(key); // re-insert → most-recently-used
    cache.set(key, cached);
    return cached;
  }
  if (!mdComment) return `<p>${esc(c.body)}</p>`; // not ready yet — don't cache the fallback
  const html = DOMPurify.sanitize(mdComment.render(c.body || ""));
  cache.set(key, html);
  while (cache.size > COMMENT_CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return html;
}
