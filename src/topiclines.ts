import MarkdownIt from "markdown-it";

// A topic's line blocks: a top-level `lines` fence in its body names, one entry per line, a file
// and a range of new-side lines (`path:start-end`, or `path:n` for one line) for the desk to quote
// from the diff. The tab reads the same grammar (ui/topics-body-derive.ts); the desk stamps where
// each entry's lines are in the current diff (types.ts LineSpan), which is what the tab draws.

export type LineEntry = { path: string; start: number; end: number };
export type LineBlock = { line: number; entries: LineEntry[] };

const parser = new MarkdownIt({ html: false });
const ENTRY = /^(.+):([1-9]\d*)(?:-([1-9]\d*))?$/;

// One entry, or null when it doesn't parse (a range must not run backwards).
export function lineEntry(text: string): LineEntry | null {
  const m = ENTRY.exec(text.trim());
  if (!m) return null;
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  return start <= end ? { path: m[1]!, start, end } : null;
}

// How an entry is written, for an error that names it.
export const entryLabel = (e: LineEntry) =>
  `${e.path}:${e.start === e.end ? e.start : `${e.start}-${e.end}`}`;

// The body's line blocks in order, each by its fence's 1-based source line, blank lines skipped;
// or the first entry that doesn't parse.
export function lineBlocks(
  body: string,
): { ok: true; blocks: LineBlock[] } | { ok: false; entry: string } {
  const blocks: LineBlock[] = [];
  for (const t of parser.parse(body, {})) {
    if (t.type !== "fence" || t.level !== 0 || t.info.trim() !== "lines" || !t.map) continue;
    const entries: LineEntry[] = [];
    for (const text of t.content.split("\n")) {
      if (!text.trim()) continue;
      const entry = lineEntry(text);
      if (!entry) return { ok: false, entry: text.trim() };
      entries.push(entry);
    }
    blocks.push({ line: t.map[0] + 1, entries });
  }
  return { ok: true, blocks };
}
