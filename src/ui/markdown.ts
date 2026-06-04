import { createRender } from "@comark/html";
import highlight from "@comark/html/plugins/highlight";
import footnotes from "@comark/html/plugins/footnotes";
import DOMPurify from "dompurify";
import { esc } from "./store";
import { render } from "./render";
import type { ReviewComment } from "./types";

// comark's highlight only wires ~10 web-focused languages on-demand, so without an
// explicit preload python/go/rust/diff/etc. silently fall back to plaintext. Deep-import
// a curated set of grammars (same path comark itself uses) and register them up front.
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
import markdown from "shiki/dist/langs/markdown.mjs";
import diff from "shiki/dist/langs/diff.mjs";
import toml from "shiki/dist/langs/toml.mjs";
import ruby from "shiki/dist/langs/ruby.mjs";
import php from "shiki/dist/langs/php.mjs";
import dockerfile from "shiki/dist/langs/dockerfile.mjs";

const languages = [javascript, typescript, tsx, json, html, css, python, go, rust, c, cpp, java, bash, sql, yaml, markdown, diff, toml, ruby, php, dockerfile];

// One reusable async renderer (parser + Shiki highlighter initialized once).
// - html:false drops embedded raw HTML at the source (no <script>/<img onerror> from a body)
// - a single dark Shiki theme bakes colors into inline `color:` (no --shiki-dark var that a
//   sanitizer might strip), so code is readable on the always-dark desk
// - DOMPurify is the final gate before we innerHTML comment bodies (incl. agent-authored ones)
const md = createRender({ html: false, plugins: [highlight({ themes: { dark: "material-theme-palenight" }, languages } as never), footnotes()] });

const cache = new Map<string, string>();
const inflight = new Set<string>();
const cacheKey = (c: ReviewComment) => `${c.id}:${c.updatedAt}`;

let repaintQueued = false;
function queueRepaint() {
  if (repaintQueued) return;
  repaintQueued = true;
  setTimeout(() => { repaintQueued = false; render(); }, 0); // coalesce warms into one repaint
}

async function warm(body: string, key: string) {
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    cache.set(key, DOMPurify.sanitize(await md(body || "")));
  } catch {
    cache.set(key, `<p>${esc(body)}</p>`);
  } finally {
    inflight.delete(key);
    queueRepaint(); // swap the plaintext fallback for the rendered markdown
  }
}

// Markdown render is async (Shiki) but renderAnnotation is synchronous, so the first
// call returns an escaped-plaintext fallback and warms the cache, then triggers one
// repaint. Keyed by id+updatedAt, so editing a comment re-renders it.
export function renderCommentBody(c: ReviewComment): string {
  const key = cacheKey(c);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  void warm(c.body, key);
  return `<p>${esc(c.body)}</p>`;
}
