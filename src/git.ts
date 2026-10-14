import crypto from "node:crypto";
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

// `core.quotePath` defaults to true, so any path with a non-ASCII byte comes back C-quoted and
// wrapped in double quotes (café.txt → "caf\303\251.txt"), which the diff parser and every path
// consumer downstream then mangle. Disabling it via `-c` here — the one wrapper git.ts and state.ts
// both spawn git through — makes every invocation (diff builders, rawBlobOids, ls-files --others,
// diff --cached --name-only, …) emit raw UTF-8 paths, in one place. It's a no-op for commands that
// emit no paths, so applying it globally is safe rather than per-call-site (which could miss one).
export async function git(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    maxBuffer: MAX_BUFFER,
  });
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

// The folder name of the MAIN worktree, for display. A linked worktree's show-toplevel is its own
// folder, but the common git dir is always the main worktree's `.git`. Any other layout (a bare
// repo, a submodule's .git/modules/<name>, no repo at all) names root's own folder instead.
export async function getProjectName(root: string) {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root).catch(
    () => "",
  );
  return path.basename(common) === ".git"
    ? path.basename(path.dirname(common))
    : path.basename(root);
}

// The checked-out branch, or undefined on a detached HEAD or outside a repo — unlike getBranch,
// which names a detached HEAD because a session key must always exist.
export async function getCheckedOutBranch(cwd: string) {
  return (await git(["symbolic-ref", "--short", "-q", "HEAD"], cwd).catch(() => "")) || undefined;
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
  gitStats.parses++;
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

// Test-observability counters. `fileReads`: the number of times fileAt actually reads a
// blob/working file — buildReviewState must NOT read committed contents (issue 04), a pr-mode
// fixture asserts this stays 0 across a build. `parses`: the number of parseUnifiedDiff calls —
// a reload must parse the diff exactly once (issue 06), shared across build + skim resolution.
// Reset the relevant field before the window you want to measure.
export const gitStats = { fileReads: 0, parses: 0 };

// One reviewed file's contents at a ref (git blob) or from the working tree. By default a missing
// object/file swallows to "" — for the diff a vanished side degrades to an add/delete rather than
// crashing. `strict` (used by on-demand content resolution for a side the diff says MUST exist)
// rethrows instead, so /api/file-contents can 404 with a reload hint when a rebase drops the object
// mid-session, instead of silently serving an empty file.
export async function fileAt(root: string, rel: string | undefined, ref?: string, strict = false) {
  if (!rel) return "";
  gitStats.fileReads++;
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
  } catch (error) {
    if (strict) throw error;
    return "";
  }
}

// Git's blob object id for a piece of content: sha1 over "blob <byteLen>\0" + bytes, the exact
// bytes git hashes, so this equals `git hash-object` for that content (barring clean/smudge
// filters, which Galley doesn't use). Used as the file-level staleness key (contentHash) — the
// same value git reports in `git diff --raw`, so the committed sides need no re-hashing (see
// rawBlobOids) and only the working/untracked side is hashed here. SHA-1 only (git's default
// object format); on a rare sha256 repo committed sides still carry their real 64-hex OIDs while
// working sides get this sha1 — internally consistent per file, so staleness stays correct.
export function blobOid(content: string) {
  const bytes = Buffer.from(content, "utf8");
  return crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// A blob OID git reports as all-zeros — the working-tree side of a dirty/untracked file, which has
// no stored object yet. Signals "hash the working copy locally" (blobOid) rather than harvest.
function isZeroOid(oid: string) {
  return /^0+$/.test(oid);
}

// Harvest per-file new-side blob OIDs from `git diff --raw` in ONE process (not a `git show`
// per file), for the same args the patch diff was taken with. Only useful where the new side is
// committed (pr: HEAD; staged repo: the index) — a plain working-tree side comes back all-zeros
// and is dropped here so the caller falls back to blobOid(workingCopy). Keyed by new path (the
// rename target, since -M pairs the halves). Full 40-hex via --no-abbrev; -z tolerates spaces.
export async function rawBlobOids(
  root: string,
  opts: { staged?: boolean; base?: string; path?: string },
): Promise<Map<string, string>> {
  const args = ["diff", "--no-ext-diff", "-M", "--raw", "-z", "--no-abbrev"];
  if (opts.staged) args.push("--cached");
  if (opts.base) args.push(`${opts.base}..HEAD`);
  if (opts.path) args.push("--", opts.path);
  const raw = await git(args, root).catch(() => "");
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const out = new Map<string, string>();
  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i++]!;
    if (!meta.startsWith(":")) continue;
    // ":<oldmode> <newmode> <oldsha> <newsha> <status>" — status R/C consumes old+new paths.
    const parts = meta.slice(1).split(" ");
    const newOid = parts[3];
    const status = parts[4] ?? "";
    const isCopyOrRename = status[0] === "R" || status[0] === "C";
    if (isCopyOrRename) i++; // skip the old path
    const newPath = tokens[i++];
    if (newPath && newOid && !isZeroOid(newOid)) out.set(newPath, newOid);
  }
  return out;
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

// The change block of a diff file a stableKey names: the block whose key it is, else the nearest
// one of the same side and shape.
function findChangeBlock(file: DiffFile, stableKey: string) {
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
  if (!match) throw new Error(`No matching change found for ${file.newPath}:${stableKey}`);
  return match;
}

// Each change block of a diff file's hunks with the line just before it on each side (0 at the
// top of the file): where the block sits. A hunk header whose count is 0 names the line before.
function placedBlocks(hunks: DiffHunk[]) {
  const placed: Array<{ block: DiffLine[]; oldBefore: number; newBefore: number }> = [];
  for (const hunk of hunks) {
    let oldLine = hunk.oldCount ? hunk.oldStart - 1 : hunk.oldStart;
    let newLine = hunk.newCount ? hunk.newStart - 1 : hunk.newStart;
    let block: DiffLine[] | null = null;
    for (const l of hunk.lines) {
      if (l.kind === "context") block = null;
      else if (!block) {
        block = [];
        placed.push({ block, oldBefore: oldLine, newBefore: newLine });
      }
      block?.push(l);
      if (l.kind !== "add") oldLine++;
      if (l.kind !== "delete") newLine++;
    }
  }
  return placed;
}

const textsOf = (block: DiffLine[], kind: DiffLine["kind"]) =>
  block.filter((l) => l.kind === kind).map((l) => l.text);
const sameTexts = (a: string[], b: string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

// Where one change block of the reviewed diff (`rawDiff`, the working tree against the index it was
// taken on) stands in the index now, read off `fresh`: the file's working-tree-vs-index diff taken
// now. Staging only edits the index, so the block keeps its place in the working tree. Still
// pending, `fresh` shows the same edit after the same working-tree line. Staged, `fresh` shows
// nothing there, and its index line follows from the edits `fresh` still shows above it. `at` is
// the index line the block's edit goes after. null when the file moved on since the review's diff
// was taken, so no index write would be the reviewed one: the working tree (`worktree`) no longer
// holds the block's hunk, or `fresh` shows another edit on or beside the block.
export function changeInIndex(
  rawDiff: string,
  fresh: string,
  worktree: string,
  filePath: string,
  stableKey: string,
): { staged: boolean; at: number; deleted: string[]; added: string[] } | null {
  const ofPath = (f: DiffFile) => (f.newPath ?? f.oldPath) === filePath;
  const reviewed = parseUnifiedDiff(rawDiff).find(ofPath);
  if (!reviewed) throw new Error(`No diff found for ${filePath}`);
  // A file added or deleted whole has no index lines around it to place an edit by.
  if (!reviewed.oldPath || !reviewed.newPath)
    throw new Error(`${filePath} is added or deleted whole, so it stages only as a whole file`);
  const { hunk, block } = findChangeBlock(reviewed, stableKey);
  const lines = worktree.split(/\r?\n/);
  if (hunk.lines.some((l) => l.newLine !== undefined && lines[l.newLine - 1] !== l.text))
    return null;
  // findChangeBlock returns one of the hunk's own blocks, so it is placed.
  const before = placedBlocks([hunk]).find((p) => p.block[0] === block[0])!.newBefore;
  const deleted = textsOf(block, "delete");
  const added = textsOf(block, "add");
  const edits = placedBlocks(parseUnifiedDiff(fresh).find(ofPath)?.hunks ?? []);
  const pending = edits.find(
    (e) =>
      e.newBefore === before &&
      sameTexts(textsOf(e.block, "delete"), deleted) &&
      sameTexts(textsOf(e.block, "add"), added),
  );
  if (pending) return { staged: false, at: pending.oldBefore, deleted, added };
  let at = before;
  for (const e of edits) {
    // Past the block's last working-tree line: no bearing on where it sits.
    if (e.newBefore > before + added.length) continue;
    const adds = textsOf(e.block, "add").length;
    // On the block, or on the line before it.
    if (e.newBefore + adds >= before) return null;
    at += e.block.length - 2 * adds;
  }
  return { staged: true, at, deleted, added };
}

// A zero-context patch that replaces the index lines `from`, right after index line `at`, with
// `to`. git apply starts its search for a hunk at the hunk's + side start, so both sides name `at`:
// an empty `from` (a pure insertion) lands exactly there, and a non-empty one must match the lines
// found there.
export function indexPatch(filePath: string, at: number, from: string[], to: string[]) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${formatRange(from.length ? at + 1 : at, from.length)} +${formatRange(at + 1, to.length)} @@`,
    ...from.map((t) => `-${t}`),
    ...to.map((t) => `+${t}`),
    "",
  ].join("\n");
}
