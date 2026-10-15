import type { FileContents, FileDiffMetadata } from "@pierre/diffs";
import type { DiffHunk } from "../types";
import { changeStableKey } from "./decisions-derive";
import type { ChangeState, Decision, DiffHolder } from "./types";

// A side's lines without their endings, and whether its last line goes without one (git's
// "\ No newline at end of file"). "" has no lines.
function sideLines(contents: string) {
  const lines = contents.split("\n");
  const noEol = lines[lines.length - 1] !== "";
  if (!noEol) lines.pop();
  return { lines, noEol };
}

// A file line as the server's parsed hunks carry it: git.ts parseUnifiedDiff splits the patch on
// \r?\n, so a CRLF line's CR is gone. The last line of a hunk may also have lost trailing
// whitespace: git() trims the end of the whole diff, which is the last line of its last hunk.
function sameText(line: string | undefined, text: string, last: boolean) {
  if (line === undefined) return false;
  const t = line.endsWith("\r") ? line.slice(0, -1) : line;
  return t === text || (last && t.trimEnd() === text);
}

// The file's git patch, rebuilt from the server's parsed hunks over the two sides the tab fetched,
// for @pierre to parse (parseRawDiff). null when the hunks don't describe these two sides — the
// file moved on since the server took its diff (an edit not yet reloaded, a block staged before
// the file was first opened), or there's no diff to describe (an untracked add, a movedFrom merge,
// identical sides). The check is whole-file: every line outside the hunks is the same on both
// sides, every hunk line is the side's line at its place, and the counts match the headers. A
// hunk whose last context lines the trim above dropped (blank lines) takes them from the sides.
export function gitPatch(
  oldName: string,
  newName: string,
  hunks: readonly DiffHunk[],
  oldContents: string,
  newContents: string,
): string | null {
  if (!hunks.length || oldContents === newContents) return null;
  const old = sideLines(oldContents);
  const neu = sideLines(newContents);
  const out = [`--- ${oldName}`, `+++ ${newName}`];
  let o = 0;
  let n = 0;
  // After a line that ends a side: the side's missing final newline, as git marks it. A context
  // line ends both sides or neither — a final line with a newline on one side only is a change.
  const eof = (kind: DiffHunk["lines"][number]["kind"]) => {
    const oldEnd = kind !== "add" && o === old.lines.length && old.noEol;
    const newEnd = kind !== "delete" && n === neu.lines.length && neu.noEol;
    if (kind === "context" && oldEnd !== newEnd) return false;
    if (oldEnd || newEnd) out.push("\\ No newline at end of file");
    return true;
  };
  for (const h of hunks) {
    // Each side's first line in the hunk, 0-based. A side the hunk has no lines on names the line
    // before it (`-5,0` is "after line 5"; `-0,0` is the top of an empty side).
    const oStart = h.oldCount ? h.oldStart - 1 : h.oldStart;
    const nStart = h.newCount ? h.newStart - 1 : h.newStart;
    if (oStart < o || oStart > old.lines.length || nStart - n !== oStart - o) return null;
    for (; o < oStart; o++, n++) if (old.lines[o] !== neu.lines[n]) return null;
    out.push(h.header);
    const oEnd = oStart + h.oldCount;
    const nEnd = nStart + h.newCount;
    for (const [i, l] of h.lines.entries()) {
      const last = i === h.lines.length - 1;
      if (l.kind !== "add" && !sameText(old.lines[o], l.text, last)) return null;
      if (l.kind !== "delete" && !sameText(neu.lines[n], l.text, last)) return null;
      if (l.kind === "context" && old.lines[o] !== neu.lines[n]) return null;
      out.push(`${l.kind === "add" ? "+" : l.kind === "delete" ? "-" : " "}${l.text}`);
      if (l.kind !== "add") o++;
      if (l.kind !== "delete") n++;
      if (!eof(l.kind)) return null;
    }
    if (o > oEnd || oEnd - o !== nEnd - n) return null;
    while (o < oEnd) {
      if (old.lines[o] === undefined || old.lines[o] !== neu.lines[n]) return null;
      out.push(` ${old.lines[o]}`);
      o++;
      n++;
      if (!eof("context")) return null;
    }
  }
  // The shared tail after the last hunk, its final newline included.
  const tail = old.lines.length - o;
  if (tail !== neu.lines.length - n || (tail > 0 && old.noEol !== neu.noEol)) return null;
  for (; o < old.lines.length; o++, n++) if (old.lines[o] !== neu.lines[n]) return null;
  return out.join("\n") + "\n";
}

// The raw diff of a reviewed file — what its change blocks derive from (deriveChanges) and the
// view replays decisions onto. It must be the diff the server keyed the file's blocks on: git's,
// parsed into ReviewFile.hunks. @pierre's own parseDiffFromFile re-diffs the two sides with jsdiff,
// which aligns a hunk differently from git wherever more than one alignment is minimal (a moved
// `}` or blank line). Its blocks then split or shift, so their `path:stableKey` ids name no server
// block: the server-stamped part, skim, stageable and contentHash, all carried by id, drop (the
// block falls to its file's Rest step, unskimmed, unstageable), and a decision recorded against
// the server's block matches nothing. So git's patch is parsed instead, over the full sides
// (expansion needs them), and the re-diff is only the fallback where git's hunks don't describe
// the sides (gitPatch): there no server block describes what the tab shows, so none can carry.
export function parseRawDiff(
  lib: Pick<DiffHolder, "processFile" | "parseDiffFromFile">,
  hunks: readonly DiffHunk[],
  oldFile: FileContents,
  newFile: FileContents,
): FileDiffMetadata {
  const patch = gitPatch(oldFile.name, newFile.name, hunks, oldFile.contents, newFile.contents);
  const keyed = oldFile.cacheKey != null && newFile.cacheKey != null;
  const fd =
    patch === null
      ? undefined
      : lib.processFile(patch, {
          oldFile,
          newFile,
          isGitDiff: false,
          // As parseDiffFromFile keys it, apart from a re-diff of the same two sides, which may
          // align differently: a diff with an equal cacheKey reads to @pierre as the same diff.
          cacheKey: keyed ? `${oldFile.cacheKey}:${newFile.cacheKey}:git` : undefined,
        });
  if (fd && newFile.lang != null) fd.lang = newFile.lang;
  return fd ?? lib.parseDiffFromFile(oldFile, newFile);
}

// The change blocks of one file's raw diff (parseRawDiff). The server-stamped fields ride on each
// block's identity, carried from the block of `previous` with the same id: the server's own block
// while the raw diff is git's.
export function deriveChanges(
  diff: FileDiffMetadata,
  path: string,
  previous: ReadonlyMap<string, ChangeState>,
  decisions: readonly Decision[],
): ChangeState[] {
  const derived: ChangeState[] = [];
  diff.hunks.forEach((h, hunkIndex) => {
    (h.hunkContent || []).forEach((part, contentIndex) => {
      if (part.type !== "change") return;
      const side = part.additions > 0 ? "additions" : "deletions";
      const lineNumber =
        (side === "additions" ? part.additionLineIndex : part.deletionLineIndex) + 1;
      const stableKey = changeStableKey(part);
      const id = `${path}:${stableKey}`;
      const prev = previous.get(id);
      // Status comes from the explicit decision record (source of truth), not from
      // whether the hunk happens to be staged.
      const decision = decisions.find((d) => d.key === id);
      const status: ChangeState["status"] = decision?.status ?? "pending";
      derived.push({
        id,
        path,
        hunkIndex,
        changeIndex: contentIndex,
        stableKey,
        side,
        lineNumber,
        endLine:
          side === "additions"
            ? part.additionLineIndex + (part.additions || 1)
            : part.deletionLineIndex + (part.deletions || 1),
        title: `${part.deletions || 0} removed · ${part.additions || 0} added`,
        status,
        stageable: prev?.stageable,
        contentHash: prev?.contentHash,
        reviewedHash: decision?.reviewedHash ?? prev?.reviewedHash,
        // Server-stamped skim rides on the change's identity; carry it across client
        // re-derivation. A rewritten block gets a new id → no prev → skim drops on its own.
        skim: prev?.skim,
        // The guide part that claims the block rides the same identity (absent = Rest).
        part: prev?.part,
      });
    });
  });
  return derived;
}
