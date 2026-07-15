import { S, api } from "./store";
import { currentFile } from "./changes";
import type { FileContentsPayload, ReviewState } from "./types";

type ReviewFile = ReviewState["files"][number];

// Per-file old/new contents fetched from GET /api/file-contents, so the render path no longer
// reads them off the polled ReviewState (issue 04 removes the embedded copies entirely). A small
// client-side LRU keeps recently opened files warm (matching the render instance cache's size), so
// re-opening a visited file re-renders without a round-trip. Preview files (opened from the tree
// via /api/file) carry their contents inline and never hit this cache — see loadCurrentContents.

type Contents = { oldContents: string; newContents: string };

const CACHE_CAP = 30;
// Keyed path + contentHash: a reload that rewrites a file changes its hash, so the stale entry
// falls out on its own (mirrors the server-side cache token).
const cache = new Map<string, Contents>();
const cacheKey = (f: ReviewFile) => `${f.path}\0${f.contentHash}`;

// The current file's resolved contents. The render pass and its synchronous helpers
// (currentSplittable, the markdown/anchor readers) read from here instead of fetching per call.
// `path` records which file these belong to so a helper can tell when they're not yet loaded for
// the current file (before the first fetch resolves).
export const cur: { path: string | null; oldContents: string; newContents: string } = {
  path: null,
  oldContents: "",
  newContents: "",
};

// Cache-only lookup (no fetch, no LRU touch). Preview files answer from their inline contents.
export function peekContents(f: ReviewFile): Contents | null {
  if (S.preview && f === S.preview)
    return { oldContents: S.preview.previewContents, newContents: S.preview.previewContents };
  return cache.get(cacheKey(f)) ?? null;
}

async function fetchContents(f: ReviewFile): Promise<Contents> {
  const key = cacheKey(f);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // re-insert → most-recently-used
    cache.set(key, hit);
    return hit;
  }
  const r = await api<Partial<FileContentsPayload> & { error?: string }>(
    `/api/file-contents?path=${encodeURIComponent(f.path)}`,
  );
  if (typeof r.oldContents !== "string" || typeof r.newContents !== "string")
    throw new Error(r.error || "file-contents fetch failed");
  const val = { oldContents: r.oldContents, newContents: r.newContents };
  cache.set(key, val);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return val;
}

// Load the current file's contents into `cur` before it renders. Returns:
//   "ok"    — cur now holds this file's contents;
//   "stale" — the reviewer switched files while the fetch was in flight (the response is for a
//             file that is no longer current), so cur was left untouched and this render must
//             abort — a newer render() for the now-current file is already running;
//   "error" — the fetch failed (git object gone after a rebase, transport error); the caller
//             renders an error card.
// The stale guard is why the in-flight request is pinned to the file it was issued for: a late
// response must never render into, or seed `cur` for, the wrong file.
export async function loadCurrentContents(): Promise<"ok" | "stale" | "error"> {
  const f = currentFile();
  if (!f) {
    cur.path = null;
    cur.oldContents = "";
    cur.newContents = "";
    return "ok";
  }
  // A preview carries its contents inline (fetched from /api/file); nothing to fetch.
  if (S.preview && f === S.preview) {
    cur.path = f.path;
    cur.oldContents = S.preview.previewContents;
    cur.newContents = S.preview.previewContents;
    return "ok";
  }
  try {
    const { oldContents, newContents } = await fetchContents(f);
    if (currentFile() !== f) return "stale"; // switched files mid-fetch — drop this pass
    cur.path = f.path;
    cur.oldContents = oldContents;
    cur.newContents = newContents;
    return "ok";
  } catch {
    if (currentFile() !== f) return "stale";
    return "error";
  }
}
