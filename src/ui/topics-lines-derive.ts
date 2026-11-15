import type { DiffHunk, DiffLine, LineSpan } from "../types";
import type { Side } from "./types";
import type { LineRange } from "./annotations";

// Pure logic for a topic's line blocks (types.ts LineSpan): which rows of a file's diff a block
// draws, the patch @pierre/diffs draws them from, and the parts its lines are. Store-free, so it
// unit-tests; topics-lines.ts mounts the diffs and wires their comments.

// A row a block draws, with the side and line a comment on it anchors to, as in Code mode: a
// removed line on the old side, any other on the new side. `oAt`/`nAt` are each side's next line
// where the row sits, which the patch's hunk headers are cut from.
export type SliceRow = {
  kind: DiffLine["kind"];
  text: string;
  side: Side;
  line: number;
  oAt: number;
  nAt: number;
};

// The rows of `hunks` a block of new-side lines start..end draws: every line of the range the diff
// shows, and the removed lines among them, from just before its first line to just after its last
// (as a pure deletion block touches a range: state.ts skimRangesForHunk). A file the diff shows
// without hunks (an untracked add) is all added lines, read from `newLines`.
export function sliceRows(
  hunks: readonly DiffHunk[],
  start: number,
  end: number,
  newLines: readonly string[] = [],
): SliceRow[] {
  if (!hunks.length)
    return newLines.slice(start - 1, end).map((text, i) => ({
      kind: "add",
      text,
      side: "additions",
      line: start + i,
      oAt: 1,
      nAt: start + i,
    }));
  const rows: SliceRow[] = [];
  for (const h of hunks) {
    // A side the hunk has no lines on names the line before it (`-5,0` is "after line 5").
    let o = h.oldCount ? h.oldStart : h.oldStart + 1;
    let n = h.newCount ? h.newStart : h.newStart + 1;
    for (const l of h.lines) {
      const inRange =
        l.kind === "delete" ? n - 1 >= start - 1 && n - 1 <= end : n >= start && n <= end;
      if (inRange)
        rows.push({
          kind: l.kind,
          text: l.text,
          side: l.kind === "delete" ? "deletions" : "additions",
          line: l.kind === "delete" ? o : n,
          oAt: o,
          nAt: n,
        });
      if (l.kind !== "add") o++;
      if (l.kind !== "delete") n++;
    }
  }
  return rows;
}

// The raw lines `rows` draw, by side: what the annotation builder takes as a block's range. A side
// with no row is an empty range.
export function sliceRange(rows: readonly SliceRow[]): LineRange {
  const span = (lines: number[]): [number, number] =>
    lines.length ? [Math.min(...lines), Math.max(...lines)] : [1, 0];
  return {
    additions: span(rows.flatMap((r) => (r.kind === "delete" ? [] : [r.nAt]))),
    deletions: span(rows.flatMap((r) => (r.kind === "add" ? [] : [r.oAt]))),
  };
}

// A unified patch of `path` holding only `rows`: a hunk per run of rows that follow each other, its
// header naming the file's own lines, so the drawn gutter numbers are the file's.
export function slicePatch(path: string, rows: readonly SliceRow[]): string {
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let run: SliceRow[] = [];
  const flush = () => {
    if (!run.length) return;
    const first = run[0]!;
    const olds = run.filter((r) => r.kind !== "add").length;
    const news = run.filter((r) => r.kind !== "delete").length;
    out.push(
      `@@ -${olds ? first.oAt : first.oAt - 1},${olds} +${news ? first.nAt : first.nAt - 1},${news} @@`,
    );
    for (const r of run)
      out.push(`${r.kind === "add" ? "+" : r.kind === "delete" ? "-" : " "}${r.text}`);
    run = [];
  };
  let next: { o: number; n: number } | null = null;
  for (const r of rows) {
    if (next && (r.oAt !== next.o || r.nAt !== next.n)) flush();
    run.push(r);
    next = { o: r.oAt + (r.kind === "add" ? 0 : 1), n: r.nAt + (r.kind === "delete" ? 0 : 1) };
  }
  flush();
  return out.join("\n") + "\n";
}

// How the header names a span's lines: `path:start-end`, or `path:n` for one line.
export const spanLabel = (s: Pick<LineSpan, "path" | "start" | "end">) =>
  s.start === undefined
    ? s.path
    : `${s.path}:${s.start === s.end ? s.start : `${s.start}-${s.end}`}`;

// A line of a block as a part of its topic's page: its side, line and path. It names a code line,
// so it lives only in the tab: a comment on it is a ReviewComment, never a topic thread's part.
export const linePart = (side: Side, line: number, path: string) => `line:${side}:${line}:${path}`;
export function readLinePart(part: string): { side: Side; line: number; path: string } | null {
  const m = /^line:(additions|deletions):(\d+):(.+)$/.exec(part);
  // The pattern admits only the two sides.
  return m ? { side: m[1] as Side, line: Number(m[2]), path: m[3]! } : null;
}
