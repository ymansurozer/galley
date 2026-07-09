import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffFile, DiffHunk, DiffLine } from "./types.js";

const execFileAsync = promisify(execFile);

// Cap on a single git/gh stdout. Generous because a whole-PR `git diff` or a `git show` of a large
// generated/vendored file can be big; exceeding it rejects (git()) or degrades a file to a spurious
// full add/delete (fileAt swallows the error), so a too-small cap silently corrupts a large diff.
const MAX_BUFFER = 256 * 1024 * 1024;

export async function git(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER });
  return String(stdout).trimEnd();
}

// Thin wrapper around the GitHub CLI, used only to resolve a PR number/URL to its branch.
// Kept optional: callers catch failures (gh missing or unauthenticated) and report them.
export async function gh(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("gh", args, { cwd, maxBuffer: MAX_BUFFER });
  return String(stdout).trimEnd();
}

export async function getGitRoot(cwd: string) {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export async function getHead(cwd: string) {
  try {
    return await git(["rev-parse", "HEAD"], cwd);
  } catch {
    return null;
  }
}

export async function getBranch(cwd: string) {
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (branch && branch !== "HEAD") return branch;
    const short = await git(["rev-parse", "--short", "HEAD"], cwd);
    return short ? `detached-${short}` : "";
  } catch {
    return "";
  }
}

export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  // Files whose content section is binary ("Binary files … differ" / "GIT binary patch") — a
  // transient parse-time set (never a DiffFile field, so it can't leak into ReviewFile). Used
  // to drop a renamed binary: it's zero-hunk with distinct paths, so the rename-keep rule below
  // would otherwise keep it and its bytes would later be read as mangled utf8 text (fileAt).
  const binaryFiles = new WeakSet<DiffFile>();
  // Files whose paths came from the `rename from`/`rename to` extended headers — those give the
  // raw, unprefixed path (reliable for paths with spaces, unlike the `diff --git`/`--- +++`
  // regexes), so once set we don't let the later `--- a/`/`+++ b/` lines clobber them.
  const renamedFiles = new WeakSet<DiffFile>();
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let diffPosition = 0;

  for (const rawLine of raw.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      file = { hunks: [] };
      hunk = undefined;
      diffPosition = 0;
      const match = rawLine.match(/^diff --git a\/(.*?) b\/(.*)$/);
      if (match) {
        file.oldPath = match[1];
        file.newPath = match[2];
      }
      files.push(file);
      continue;
    }
    if (!file) continue;
    // git -M rename headers. Authoritative over the diff --git / --- +++ paths (see above), and
    // they arrive BEFORE any hunk, so they must be handled ahead of the `!hunk` guard below.
    if (rawLine.startsWith("rename from ")) {
      file.oldPath = rawLine.slice("rename from ".length);
      renamedFiles.add(file);
      continue;
    }
    if (rawLine.startsWith("rename to ")) {
      file.newPath = rawLine.slice("rename to ".length);
      renamedFiles.add(file);
      continue;
    }
    if (rawLine.startsWith("Binary files ") || rawLine.startsWith("GIT binary patch")) {
      binaryFiles.add(file);
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      if (renamedFiles.has(file)) continue;
      const value = rawLine.slice(4).trim();
      file.oldPath = value === "/dev/null" ? undefined : value.replace(/^a\//, "");
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      if (renamedFiles.has(file)) continue;
      const value = rawLine.slice(4).trim();
      file.newPath = value === "/dev/null" ? undefined : value.replace(/^b\//, "");
      continue;
    }
    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      hunk = {
        header: rawLine,
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? "1"),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? "1"),
        lines: [],
      };
      file.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      diffPosition = 0;
      continue;
    }
    if (!hunk || rawLine.startsWith("\\ No newline")) continue;
    const prefix = rawLine[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") continue;
    diffPosition++;
    const text = rawLine.slice(1);
    if (prefix === " ") {
      hunk.lines.push({
        kind: "context",
        text,
        oldLine,
        newLine,
        diffPosition,
        hunkHeader: hunk.header,
      });
      oldLine++;
      newLine++;
    } else if (prefix === "+") {
      hunk.lines.push({ kind: "add", text, newLine, diffPosition, hunkHeader: hunk.header });
      newLine++;
    } else {
      hunk.lines.push({ kind: "delete", text, oldLine, diffPosition, hunkHeader: hunk.header });
      oldLine++;
    }
  }

  // Keep every file that has real hunks, plus a zero-hunk PURE rename (git -M with 100%
  // similarity emits no content) — distinct old/new paths and not binary. A renamed binary is
  // also zero-hunk with distinct paths, but its "Binary files … differ" line marks it (excluded
  // so its bytes aren't read as text); same-path zero-hunk sections (mode-only changes, same-path
  // binary diffs) have no rename to surface and stay dropped.
  return files.filter(
    (f) =>
      f.hunks.length > 0 ||
      (!!f.oldPath && !!f.newPath && f.oldPath !== f.newPath && !binaryFiles.has(f)),
  );
}

export async function fileAt(root: string, rel: string | undefined, ref?: string) {
  if (!rel) return "";
  try {
    // Use a raw exec (not git()) so the trailing newline is preserved — otherwise
    // the file looks like it has "no newline at end of file" and the last line
    // renders as a spurious diff.
    if (ref) {
      const { stdout } = await execFileAsync("git", ["show", `${ref}:${rel}`], {
        cwd: root,
        maxBuffer: MAX_BUFFER,
      });
      return String(stdout);
    }
    return await fs.readFile(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}

export async function listProjectTree(root: string) {
  try {
    const tracked = await git(["ls-files"], root);
    return tracked
      .split(/\r?\n/)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function changeBlocks(hunk: DiffHunk) {
  const blocks: DiffLine[][] = [];
  let current: DiffLine[] = [];
  for (const line of hunk.lines) {
    if (line.kind === "add" || line.kind === "delete") current.push(line);
    else if (current.length) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

export function changeStableKeyFromBlock(lines: DiffLine[]) {
  const adds = lines.filter((l) => l.kind === "add");
  const dels = lines.filter((l) => l.kind === "delete");
  const side = adds.length > 0 ? "additions" : "deletions";
  // First line of the block, matching the client's derivation so server-seeded
  // and client-derived change ids line up.
  const start = side === "additions" ? adds[0]?.newLine : dels[0]?.oldLine;
  const lineNumber = start ?? 0;
  return `${side}:${lineNumber}:${dels.length}:${adds.length}`;
}

export function changeBlockContent(lines: DiffLine[]) {
  return lines.map((l) => `${l.kind === "add" ? "+" : "-"}${l.text}`).join("\n");
}

function formatRange(start: number, count: number) {
  return count === 1 ? String(start) : `${start},${count}`;
}

export function patchForChange(rawDiff: string, filePath: string, stableKey: string) {
  const file = parseUnifiedDiff(rawDiff).find((f) => (f.newPath ?? f.oldPath) === filePath);
  if (!file) throw new Error(`No diff found for ${filePath}`);
  const requested = stableKey.match(/^(additions|deletions):(\d+):(\d+):(\d+)$/);
  const requestedSide = requested?.[1];
  const requestedLine = Number(requested?.[2] ?? 0);
  const requestedDeletes = Number(requested?.[3] ?? -1);
  const requestedAdds = Number(requested?.[4] ?? -1);
  const candidates: Array<{ hunk: DiffHunk; block: DiffLine[]; score: number }> = [];
  for (const hunk of file.hunks) {
    for (const block of changeBlocks(hunk)) {
      if (changeStableKeyFromBlock(block) === stableKey)
        candidates.push({ hunk, block, score: -1_000_000 });
      const adds = block.filter((l) => l.kind === "add");
      const deletes = block.filter((l) => l.kind === "delete");
      const side = adds.length > 0 ? "additions" : "deletions";
      const line =
        side === "additions"
          ? (adds.at(-1)?.newLine ?? adds[0]?.newLine ?? 0)
          : (deletes.at(-1)?.oldLine ?? deletes[0]?.oldLine ?? 0);
      if (requestedSide && side !== requestedSide) continue;
      let score = Math.abs(line - requestedLine);
      if (requestedAdds >= 0) score += Math.abs(adds.length - requestedAdds) * 10;
      if (requestedDeletes >= 0) score += Math.abs(deletes.length - requestedDeletes) * 10;
      candidates.push({ hunk, block, score });
    }
  }
  const match = candidates.sort((a, b) => a.score - b.score)[0];
  if (!match) throw new Error(`No matching change found for ${filePath}:${stableKey}`);
  const { hunk, block } = match;
  const deletes = block.filter((l) => l.kind === "delete");
  const adds = block.filter((l) => l.kind === "add");
  const firstIndex = hunk.lines.indexOf(block[0]);
  const prevContext = hunk.lines
    .slice(0, firstIndex)
    .reverse()
    .find((l) => l.kind === "context");
  const oldStart =
    deletes[0]?.oldLine ??
    prevContext?.oldLine ??
    Math.max(0, (adds[0]?.newLine ?? hunk.newStart) - 1);
  const newStart =
    adds[0]?.newLine ??
    prevContext?.newLine ??
    Math.max(0, (deletes[0]?.oldLine ?? hunk.oldStart) - 1);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${formatRange(oldStart, deletes.length)} +${formatRange(newStart, adds.length)} @@`,
    ...block.map((l) => `${l.kind === "add" ? "+" : "-"}${l.text}`),
    "",
  ].join("\n");
}
