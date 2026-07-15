import type { ReviewComment, ReviewState, ThreadMeta } from "./types";
import { cur } from "./contents";
import { currentComments, currentFile } from "./changes";

type ReviewFile = ReviewState["files"][number];

// ── Unanchored comment threads ───────────────────────────────────────────────
// An open thread whose anchor line no longer exists can't render as a diff annotation —
// and an open change request blocks approval, so it must stay reachable. These threads
// are pulled out of the annotation flow and shown in a strip above the diff with the
// normal thread actions (reply / resolve / reopen).

function sideLineCount(file: ReviewFile, side: ReviewComment["side"]): number {
  // Line counts come from the current file's fetched contents (contents.ts `cur`); this runs
  // during render() for the current file, so cur is loaded. If it isn't the current file yet,
  // return Infinity so the out-of-range fallback can't wrongly flag a thread as unanchored (the
  // authoritative `unanchored` flag from server-side re-anchoring is still honored by the caller).
  if (cur.path !== file.path) return Infinity;
  const contents = side === "deletions" ? cur.oldContents : cur.newContents;
  if (!contents) return 0;
  return contents.split("\n").length;
}

// Re-anchoring (reanchorComments, server-side on reload) sets `unanchored` explicitly;
// the out-of-range check additionally catches legacy comments it couldn't classify.
export function isUnanchored(c: ReviewComment, file: ReviewFile): boolean {
  return c.unanchored === true || c.lineNumber > sideLineCount(file, c.side);
}

// Open unanchored threads of the current file, grouped like annotations() groups them.
export function unanchoredThreads(): ThreadMeta[] {
  const file = currentFile();
  if (!file) return [];
  const groups = new Map<string, ReviewComment[]>();
  for (const c of currentComments()) {
    const key = `${c.side}:${c.lineNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const out: ThreadMeta[] = [];
  for (const comments of groups.values()) {
    comments.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    const open = comments.some((c) => c.status === "open");
    if (!open) continue; // a resolved orphan is done — nothing to act on
    if (!comments.some((c) => isUnanchored(c, file))) continue;
    const first = comments[0];
    out.push({
      type: "thread",
      path: first.path,
      side: first.side,
      lineNumber: first.lineNumber,
      status: "open",
      comments,
    });
  }
  return out;
}
