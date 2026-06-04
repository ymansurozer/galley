import { createRender } from "@comark/html";
import highlight from "@comark/html/plugins/highlight";
import DOMPurify from "dompurify";
import { esc } from "./store";
import { render } from "./render";
import type { ReviewComment } from "./types";

// One reusable async renderer (parser + Shiki highlighter initialized once).
// - html:false drops embedded raw HTML at the source (no <script>/<img onerror> from a body)
// - a single dark Shiki theme bakes colors into inline `color:` (no --shiki-dark var that a
//   sanitizer might strip), so code is readable on the always-dark desk
// - DOMPurify is the final gate before we innerHTML comment bodies (incl. agent-authored ones)
const md = createRender({ html: false, plugins: [highlight({ themes: { dark: "material-theme-palenight" } as never })] });

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
