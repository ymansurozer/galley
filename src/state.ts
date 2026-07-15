import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  blobOid,
  changeBlockContent,
  changeStableKeyFromBlock,
  fileAt,
  getGitRoot,
  getHead,
  git,
  parseUnifiedDiff,
  rawBlobOids,
  changeBlocks,
} from "./git.js";
import type {
  ChangeState,
  Decision,
  DiffHunk,
  Guide,
  QuestionPayload,
  ReviewComment,
  ReviewFile,
  ReviewMode,
  ReviewResult,
  ReviewState,
  ReviewerSave,
} from "./types.js";

export function nowIso() {
  return new Date().toISOString();
}

export function hash(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Deterministic per-repo+session port (41000–50999). A restarted desk binds the same
// origin, so an already-open tab self-heals through its state poll instead of dying on
// a dead random port. Collisions with foreign processes fall back to a random port at
// listen time (startServer).
export function stablePort(root: string, session: string) {
  return 41000 + (parseInt(hash(`${root}:${sanitizeSession(session)}`).slice(0, 8), 16) % 10000);
}

export function sanitizeSession(session: string) {
  const cleaned = session.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "review";
}

type DiffSource = { files: ReviewFile[]; changes: ChangeState[]; rawDiff: string };
type FileContents = { oldContents: string; newContents: string };

// New-side line count the way git's `@@ -0,0 +1,N @@` and @pierre count: split on \n, dropping one
// trailing newline so a file ending in \n isn't over-counted by one. Stamps a hunk-less full-file
// add's +count (no hunk to sum) — mirrors the derivation the UI used to run over the embedded copy.
function lineCount(s: string): number {
  if (!s) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}

// +added / −removed line counts from a parsed diff file's hunks.
function countHunkLines(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.kind === "add") added++;
      else if (l.kind === "delete") removed++;
    }
  return { added, removed };
}

// Change class from the diff's paths alone (no contents): deleted (+++ /dev/null → no newPath),
// added (--- /dev/null → no oldPath), renamed (distinct paths), else modified.
function changeKindOf(
  oldPath: string | undefined,
  newPath: string | undefined,
): ReviewFile["changeKind"] {
  if (!newPath) return "deleted";
  if (!oldPath) return "added";
  return oldPath !== newPath ? "renamed" : "modified";
}

// A whole-file entry (file mode's tracked-unchanged / untracked-add; a repo untracked add). The new
// side is always the working copy, so its byte size is free from the bytes we already hold. Carries
// no contents — the tab fetches them on open (readFileContents).
function fileEntry(filePath: string, oldContents: string, newContents: string): ReviewFile {
  const changeKind = changeKindOf(
    oldContents ? filePath : undefined,
    newContents ? filePath : undefined,
  );
  return {
    oldPath: filePath,
    newPath: filePath,
    hunks: [],
    path: filePath,
    contentHash: blobOid(newContents),
    changeKind,
    // Only a fresh add carries a +count here (no hunk to sum); a tracked-unchanged full file is 0/0.
    added: changeKind === "added" ? lineCount(newContents) : 0,
    removed: changeKind === "deleted" ? lineCount(oldContents) : 0,
    renamePure: false,
    size: Buffer.byteLength(newContents, "utf8"),
  };
}

// Parse a unified diff into review files + change blocks, stamping lean metadata and tagging each
// change as stageable or not. Reads NO file contents for a committed new side — the file-level key
// is git's own blob OID (newOids). Only a working-tree new side is read, and only to hash it (the
// bytes aren't retained; the tab fetches contents on demand via readFileContents).
async function assembleDiff(
  rawDiff: string,
  // Reads the working-tree new side to hash it. Called ONLY when there's no committed OID for the
  // file (working/file mode), so pr/staged desks invoke it zero times → zero content reads at build.
  fetchNew: (p?: string) => Promise<string>,
  stageable: boolean,
  // Per-file new-side blob OIDs harvested from `git diff --raw` (committed new sides: pr's HEAD,
  // staged's index). Absent for a working-tree new side, where we hash the working copy instead.
  newOids?: Map<string, string>,
  // The new side is the working tree (repo-unstaged / file mode) — its byte size is then free from
  // the bytes we read to hash. Committed sides (pr/staged) leave size unstamped (see ReviewFile.size).
  workingSide = false,
): Promise<{ files: ReviewFile[]; changes: ChangeState[] }> {
  const files: ReviewFile[] = [];
  const changes: ChangeState[] = [];
  for (const f of parseUnifiedDiff(rawDiff)) {
    const filePath = f.newPath ?? f.oldPath ?? "unknown";
    const committedOid = f.newPath ? newOids?.get(f.newPath) : undefined;
    let contentHash: string;
    let size: number | undefined;
    if (committedOid) {
      contentHash = committedOid; // git already hashed it — no read
    } else {
      // Working-tree new side (or a deletion, whose new side is /dev/null → fetchNew returns "").
      const newContents = await fetchNew(f.newPath);
      contentHash = blobOid(newContents);
      if (workingSide && f.newPath) size = Buffer.byteLength(newContents, "utf8");
    }
    const { added, removed } = countHunkLines(f.hunks);
    const changeKind = changeKindOf(f.oldPath, f.newPath);
    files.push({
      ...f, // oldPath/newPath carry the rename; the UI derives @pierre display names from them
      path: filePath,
      contentHash,
      changeKind,
      added,
      removed,
      // A zero-hunk entry with distinct paths is a pure rename: git -M at 100% similarity emits no
      // hunks, and parseUnifiedDiff only keeps such a zero-hunk section when it's a genuine rename.
      // A rename WITH edits carries hunks, so it isn't pure.
      renamePure: changeKind === "renamed" && f.hunks.length === 0,
      ...(size !== undefined ? { size } : {}),
    });
    f.hunks.forEach((h, hunkIndex) => {
      changeBlocks(h).forEach((block) => {
        const firstAdd = block.find((l) => l.kind === "add");
        const firstDelete = block.find((l) => l.kind === "delete");
        const side: "additions" | "deletions" = firstAdd ? "additions" : "deletions";
        const lineNumber = firstAdd?.newLine ?? firstDelete?.oldLine ?? h.newStart;
        const stableKey = changeStableKeyFromBlock(block);
        changes.push({
          id: `${filePath}:${stableKey}`,
          path: filePath,
          hunkIndex,
          side,
          lineNumber,
          stableKey,
          stageable,
          contentHash: hash(changeBlockContent(block)),
          title: `${block.filter((l) => l.kind === "delete").length} removed · ${block.filter((l) => l.kind === "add").length} added`,
          status: "pending",
        });
      });
    });
  }
  return { files, changes };
}

export type SkimResolution = { ok: true } | { ok: false; reason: string };

// A change block's stable key + the new-file-side line range it occupies, for matching a
// guide's skimBlocks spans. A block with additions spans its added lines' new-side numbers; a
// pure-deletion block has no new-side line of its own, so it falls back to the preceding new
// line (its insertion point) — best-effort, since skim targets additive churn (imports,
// lockfiles) and deletions are the rare edge (see the guide docs in spec.ts).
function skimRangesForHunk(h: DiffHunk): Array<{ stableKey: string; lo: number; hi: number }> {
  const out: Array<{ stableKey: string; lo: number; hi: number }> = [];
  let block: DiffHunk["lines"] = [];
  let prevNew = h.newStart - 1; // last new-side line seen before the current block
  const flush = () => {
    if (!block.length) return;
    const newLines = block.map((l) => l.newLine).filter((n): n is number => typeof n === "number");
    const lo = newLines.length ? Math.min(...newLines) : prevNew;
    const hi = newLines.length ? Math.max(...newLines) : prevNew;
    out.push({ stableKey: changeStableKeyFromBlock(block), lo, hi });
    block = [];
  };
  for (const line of h.lines) {
    if (line.kind === "add" || line.kind === "delete") block.push(line);
    else {
      flush();
      if (typeof line.newLine === "number") prevNew = line.newLine;
    }
  }
  flush();
  return out;
}

// Resolve a guide's skimBlocks (new-file-side line spans) to the change blocks they enclose and
// stamp `skim` onto those ChangeState records. Diff-aware, so it lives here rather than in the
// pure validateGuide. Display-only: it never touches decisions/status. `strict` (initial attach
// or reload-with-a-NEW-guide) REJECTS a span that matches no block — or a skimBlocks entry on a
// file absent from the diff — naming the offending path+span, so a bad guide is caught up front.
// Non-strict (a reload carrying the SAME guide forward) DROPS an unresolvable span silently: the
// diff advanced under the guide, and a block that changed deserves fresh attention, not a stale
// collapse. Idempotent — clears prior stamps first. File-level `skim` is a whole-file flag and
// needs no resolution, so it isn't handled here.
export function resolveSkim(
  rawDiff: string,
  changes: ChangeState[],
  guide: Guide,
  opts: { strict: boolean },
): SkimResolution {
  for (const c of changes) delete c.skim;
  const rangesByPath = new Map<string, Array<{ stableKey: string; lo: number; hi: number }>>();
  for (const f of parseUnifiedDiff(rawDiff)) {
    const filePath = f.newPath ?? f.oldPath ?? "unknown";
    const ranges = rangesByPath.get(filePath) ?? [];
    for (const h of f.hunks) ranges.push(...skimRangesForHunk(h));
    rangesByPath.set(filePath, ranges);
  }
  const changeByKey = new Map(changes.map((c) => [`${c.path}:${c.stableKey}`, c]));
  for (const file of guide.files) {
    if (!file.skimBlocks?.length) continue;
    const ranges = rangesByPath.get(file.path);
    for (const span of file.skimBlocks) {
      const [a, b] = span.lines;
      const matched = ranges?.filter((r) => a <= r.hi && b >= r.lo) ?? [];
      if (matched.length === 0) {
        if (opts.strict)
          return {
            ok: false,
            reason: `guide skimBlocks span [${a}, ${b}] on "${file.path}" matches no change in the diff`,
          };
        continue; // stale span on a reload — drop it
      }
      for (const r of matched) {
        const change = changeByKey.get(`${file.path}:${r.stableKey}`);
        if (change) change.skim = { reason: span.reason };
      }
    }
  }
  return { ok: true };
}

export type MovedResolution = { ok: true } | { ok: false; reason: string };

// Merge guide-declared moves (GuideFile.movedFrom) into a freshly-built review state: the
// moved-AND-edited case content-hash pairing (issue 02) can't catch, so the agent that made the
// move declares it. Restructures files/changes like issue 02's pairing but keyed by declaration —
// the merged entry is rename-CHANGED (contents differ), so the UI derives verdict-only,
// non-stageable blocks from the content re-diff (no server ChangeState, so /api/stage-change can't
// touch it). MUST run on `base` BEFORE mergeReviewState, so the merged entry's distinct old/new
// paths drive the rename migration (issue 01). Mirrors resolveSkim's strict/lenient contract: a NEW
// guide REJECTS an unresolvable movedFrom naming the entry; a carried-forward guide DROPS it
// silently (the pair falls back to today's delete+add — a move that no longer holds deserves fresh
// eyes). Working repo mode only (git -M covers committed renames; file mode has no untracked side).
export function resolveMovedFrom(
  state: ReviewState,
  guide: Guide,
  opts: { strict: boolean },
): MovedResolution {
  for (const gf of guide.files) {
    if (!gf.movedFrom) continue;
    const from = gf.movedFrom;
    const to = gf.path;
    if (state.mode !== "repo" || state.staged) {
      if (opts.strict)
        return {
          ok: false,
          reason: `guide.files["${to}"].movedFrom is only supported in working repo mode`,
        };
      continue;
    }
    // Issue 02's content-hash pairing already merged this exact (byte-identical) move — the agent
    // also declared it, redundantly. Nothing to restructure.
    if (state.files.some((f) => f.path === to && f.oldPath === from && f.newPath === to)) continue;
    const del = state.files.find((f) => f.path === from && !f.newPath); // full deletion (+++ /dev/null)
    const add = state.files.find((f) => f.path === to && f.changeKind === "added"); // untracked full-file add
    if (!del || !add) {
      if (opts.strict)
        return {
          ok: false,
          reason: `guide.files["${to}"].movedFrom "${from}" did not resolve — it must name a fully deleted file paired with the untracked addition "${to}" in the working diff`,
        };
      continue; // carried-forward guide whose move no longer holds → leave delete + add
    }
    // Merge into one rename-CHANGED entry at the new path (contents differ — moved AND edited). No
    // contents retained; the new-side OID is the untracked add's already-stamped contentHash, and the
    // tab fetches old (index :0 at `from`) / new (working at `to`) on open. Drop the deletion + its
    // (deletion-block) changes and the untracked entry; the merged entry carries no ChangeState
    // (blocks are UI-derived on open). renamePure:false so it isn't muted as a no-change move.
    state.files = state.files.filter((f) => f !== del && f !== add);
    state.changes = state.changes.filter((c) => c.path !== from);
    state.files.push({
      path: to,
      oldPath: from,
      newPath: to,
      hunks: [],
      contentHash: add.contentHash,
      changeKind: "renamed",
      renamePure: false,
      added: 0,
      removed: 0,
    });
  }
  return { ok: true };
}

export async function resolveDefaultBranch(root: string): Promise<string> {
  const sym = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root).catch(
    () => "",
  );
  if (sym) return sym; // e.g. "origin/main"
  for (const b of ["main", "master"]) {
    if (
      await git(["rev-parse", "--verify", b], root).then(
        () => true,
        () => false,
      )
    )
      return b;
  }
  return "HEAD";
}

// The deep module: produce review files + changes for a given mode.
// repo  → working/staged diff (opts.path is a root-relative limit).
// file  → one file (opts.path is absolute); tracked+changed = diff (stageable),
//         untracked/new = full file as additions, tracked-unchanged = full file.
// pr    → opts.base..HEAD (committed), verdict-only.
export async function buildDiffSource(opts: {
  mode: ReviewMode;
  root: string;
  path?: string;
  staged?: boolean;
  base?: string;
}): Promise<DiffSource | null> {
  const { mode, root } = opts;
  if (mode === "pr") {
    const base = opts.base ?? "HEAD";
    const rawDiff = await git(["diff", "--no-ext-diff", "-M", `${base}..HEAD`], root);
    if (!rawDiff.trim()) return null;
    // The new side is HEAD (committed) — one `git diff --raw` harvests every new-side OID, so the
    // file-level key needs no per-file re-hash and assembleDiff reads no blob contents at all.
    const { files, changes } = await assembleDiff(
      rawDiff,
      (p) => fileAt(root, p, "HEAD"),
      false,
      await rawBlobOids(root, { base }),
    );
    return { files, changes, rawDiff };
  }
  if (mode === "file") {
    const abs = opts.path!;
    const rel = path.relative(root, abs);
    const key = rel.startsWith("..") ? abs : rel;
    const tracked =
      !rel.startsWith("..") &&
      (await git(["ls-files", "--error-unmatch", "--", rel], root).then(
        () => true,
        () => false,
      ));
    const working = await fs.readFile(abs, "utf8").catch(() => "");
    if (tracked) {
      const rawDiff = await git(["diff", "--no-ext-diff", "-M", "--", rel], root);
      if (rawDiff.trim()) {
        // New side is the working tree — hashed locally (no committed OID). The UI re-diffs old/new
        // (fetched on open against the INDEX baseline via readFileContents), not these hunks.
        const { files, changes } = await assembleDiff(
          rawDiff,
          (p) => fileAt(root, p),
          true,
          undefined,
          true,
        );
        return { files, changes, rawDiff };
      }
      return { files: [fileEntry(key, working, working)], changes: [], rawDiff: "" }; // tracked, unchanged → full file
    }
    return { files: [fileEntry(key, "", working)], changes: [], rawDiff: "" }; // untracked/new → full file as additions
  }
  // repo
  // -M asks git itself to detect renames, so committed/staged renames render deterministically
  // regardless of the user's `diff.renames` config (see buildDiffSource's contract).
  const args = ["diff", "--no-ext-diff", "-M"];
  if (opts.staged) args.push("--cached");
  if (opts.path) args.push("--", opts.path);
  const rawDiff = await git(args, root);
  // Each side must match what the diff was taken against, because the UI re-diffs the
  // old/new contents itself instead of rendering these hunks. Unstaged diffs working
  // tree vs INDEX, so old reads :0 — a HEAD baseline would resurrect already-staged
  // changes as pending diff on every reload. Staged (--cached) diffs index vs HEAD.
  // Staged: the new side is the index (committed object) — harvest its OIDs from `git diff
  // --raw` in one process. Unstaged: the new side is the dirty working tree (`git diff --raw`
  // reports it as all-zeros), so no harvest — assembleDiff hashes the working copy instead.
  const { files, changes } = rawDiff.trim()
    ? await assembleDiff(
        rawDiff,
        // Staged: new side is the index (committed), covered by newOids → fetchNew is never called.
        // Unstaged: new side is the dirty working tree → read to hash (the one build-time read).
        (p) => (opts.staged ? fileAt(root, p, ":0") : fileAt(root, p)),
        true,
        opts.staged ? await rawBlobOids(root, { staged: true, path: opts.path }) : undefined,
        !opts.staged,
      )
    : { files: [], changes: [] };
  // `git diff` never reports untracked files (a brand-new file has no index/HEAD side to
  // diff against), so the working review would silently drop any file the agent created but
  // never `git add`ed. Surface them as full-file additions — same representation as file
  // mode. They carry no stageable hunks; whole-file Approve stages them via `git add`
  // (/api/stage), which doesn't rely on rawDiff. Staged mode is unaffected: untracked files
  // are by definition not in the index.
  if (!opts.staged) {
    const lsArgs = ["ls-files", "--others", "--exclude-standard"];
    if (opts.path) lsArgs.push("--", opts.path);
    const untracked = (await git(lsArgs, root)).split(/\r?\n/).filter(Boolean);
    const untrackedEntries: Array<{ rel: string; working: string }> = [];
    for (const rel of untracked)
      untrackedEntries.push({
        rel,
        working: await fs.readFile(path.join(root, rel), "utf8").catch(() => ""),
      });
    // Pair identical-content moves git can't see: a plain `mv` shows as a full deletion of the
    // tracked file (`+++ /dev/null`, so newPath is undefined) PLUS a full untracked addition. When a
    // deleted file's index (:0) content is byte-identical to exactly one untracked file — and that
    // untracked file matches exactly one deletion — it's an unambiguous rename. Merge the halves into
    // one rename-pure entry (issue 01's muted row / skim-group fold / progress exclusion, no new UI)
    // rather than making the reviewer re-read the whole file as a delete + re-add. Any ambiguity (2+
    // identical candidates on either side) pairs nothing and leaves today's delete+add rendering.
    // Exact bytes only — a moved-AND-edited file is deliberately NOT paired (that's guide movedFrom,
    // issue 03). This runs before the base becomes mergeReviewState's input, so a merged entry's
    // distinct old/new paths get issue 01's decision/comment migration for free.
    // Keyed by blob OID — byte-identical contents share an OID, so the map pairs a deletion with
    // an untracked file exactly when git would call it a rename (OID equality iff content equal).
    // The deletion's old side lives in the index (:0); read it just to hash for pairing (a read, not
    // retained — the merged entry stores no contents; the tab fetches them on open). Skip the reads
    // entirely when there's nothing untracked to pair against.
    const deletions = files.filter((f) => !f.newPath); // full deletions (+++ /dev/null)
    const delByHash = new Map<string, ReviewFile[]>();
    if (untrackedEntries.length)
      for (const d of deletions) {
        const h = blobOid(await fileAt(root, d.oldPath ?? d.path, ":0"));
        const arr = delByHash.get(h);
        if (arr) arr.push(d);
        else delByHash.set(h, [d]);
      }
    const untByHash = new Map<string, Array<{ rel: string; working: string }>>();
    for (const u of untrackedEntries) {
      const h = blobOid(u.working);
      const arr = untByHash.get(h);
      if (arr) arr.push(u);
      else untByHash.set(h, [u]);
    }
    const pairedDel = new Set<string>();
    const pairedUnt = new Set<string>();
    for (const [h, dels] of delByHash) {
      const unts = untByHash.get(h);
      if (dels.length !== 1 || !unts || unts.length !== 1) continue; // unique 1:1 match only
      const del = dels[0]!;
      const unt = unts[0]!;
      pairedDel.add(del.path);
      pairedUnt.add(unt.rel);
      // Merged entry: NEW (untracked) path with the OLD path recorded. Byte-identical content →
      // a pure rename (the muted moved row / skim-group fold). No contents retained; the new side's
      // OID is hashed from the working copy we already read.
      files.push({
        path: unt.rel,
        oldPath: del.path,
        newPath: unt.rel,
        hunks: [],
        contentHash: blobOid(unt.working),
        changeKind: "renamed",
        renamePure: true,
        added: 0,
        removed: 0,
        size: Buffer.byteLength(unt.working, "utf8"),
      });
    }
    // Drop the paired deletions + their change blocks; keep unpaired untracked as full additions.
    if (pairedDel.size) {
      for (let i = files.length - 1; i >= 0; i--)
        if (!files[i]!.newPath && pairedDel.has(files[i]!.path)) files.splice(i, 1);
      for (let i = changes.length - 1; i >= 0; i--)
        if (pairedDel.has(changes[i]!.path)) changes.splice(i, 1);
    }
    for (const u of untrackedEntries)
      if (!pairedUnt.has(u.rel)) files.push(fileEntry(u.rel, "", u.working));
  }
  if (files.length === 0) return null;
  return { files, changes, rawDiff };
}

// A small LRU of resolved file contents, so the tab re-opening a file (or re-fetching after a
// render) doesn't re-spawn `git show`. Keyed by root + path + contentHash: contentHash is the
// new-side blob OID, so a reload that rewrites the file changes the key and the stale entry
// falls out naturally (no explicit invalidation). Process-global — one desk per process.
const CONTENTS_CACHE_CAP = 30;
const contentsCache = new Map<string, FileContents>();

// On-demand old/new contents for one reviewed file — the state carries none (issue 04). Reads git /
// the working tree, replaying the exact per-mode ref semantics buildDiffSource built the diff
// against, so a fetch returns the bytes the diff was taken over. `changeKind` tells which sides
// exist: an added file has no old side, a deletion no new side — so we return "" for a legitimately
// absent side WITHOUT a read, and read the sides that must exist STRICTLY (committed blobs), so a
// git object dropped by a mid-session rebase throws (→ /api/file-contents 404s with a reload hint)
// instead of silently serving empty. The volatile working tree stays non-strict (missing → "").
async function resolveFileContents(state: ReviewState, file: ReviewFile): Promise<FileContents> {
  const root = state.root;
  const hasOld = file.changeKind !== "added"; // an added file has no old side
  const hasNew = file.changeKind !== "deleted"; // a deleted file has no new side
  if (state.mode === "pr") {
    const base = state.base ?? "HEAD";
    return {
      oldContents: hasOld ? await fileAt(root, file.oldPath, base, true) : "",
      newContents: hasNew ? await fileAt(root, file.newPath, "HEAD", true) : "",
    };
  }
  if (state.mode === "file") {
    const abs = path.isAbsolute(file.path) ? file.path : path.join(root, file.path);
    const working = await fs.readFile(abs, "utf8").catch(() => "");
    const tracked = await git(["ls-files", "--error-unmatch", "--", file.path], root).then(
      () => true,
      () => false,
    );
    // tracked + changed reads old from the INDEX (:0) and new from the working tree (buildDiffSource's
    // file-mode fetchers); tracked-unchanged is full-file working/working; untracked/new is ""/working.
    if (tracked && file.hunks.length)
      return { oldContents: await fileAt(root, file.oldPath, ":0"), newContents: working };
    return { oldContents: tracked ? working : "", newContents: working };
  }
  // repo: staged diffs index vs HEAD (old HEAD, new :0 — both committed objects, read strictly);
  // working diffs working tree vs index (old :0 committed → strict; new working → non-strict). An
  // untracked add is changeKind "added" → hasOld false → old "" without a (failing) `:0:path` read.
  if (state.staged)
    return {
      oldContents: hasOld ? await fileAt(root, file.oldPath, "HEAD", true) : "",
      newContents: hasNew ? await fileAt(root, file.newPath, ":0", true) : "",
    };
  return {
    oldContents: hasOld ? await fileAt(root, file.oldPath, ":0", true) : "",
    newContents: await fileAt(root, file.newPath),
  };
}

export async function readFileContents(
  state: ReviewState,
  file: ReviewFile,
): Promise<FileContents> {
  const key = `${state.root}\0${file.path}\0${file.contentHash}`;
  const hit = contentsCache.get(key);
  if (hit) {
    contentsCache.delete(key); // re-insert below → most-recently-used
    contentsCache.set(key, hit);
    return hit;
  }
  const resolved = await resolveFileContents(state, file);
  contentsCache.set(key, resolved);
  while (contentsCache.size > CONTENTS_CACHE_CAP) {
    const oldest = contentsCache.keys().next().value;
    if (oldest === undefined) break;
    contentsCache.delete(oldest);
  }
  return resolved;
}

export async function buildReviewState(
  cwd: string,
  opts: {
    mode?: ReviewMode;
    path?: string;
    staged?: boolean;
    session: string;
    target?: string;
    base?: string;
  },
): Promise<ReviewState | null> {
  const mode = opts.mode ?? "repo";
  const make = (
    root: string,
    source: DiffSource,
    extra: { staged: boolean; target?: string; base?: string },
    head: string | null,
  ): ReviewState => ({
    id: crypto.randomUUID(),
    session: sanitizeSession(opts.session),
    root,
    repoHash: hash(root),
    mode,
    target: extra.target,
    base: extra.base,
    staged: extra.staged,
    head,
    baseDiffHash: hash(source.rawDiff),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    rawDiff: source.rawDiff,
    files: source.files,
    comments: [],
    changes: source.changes,
    reviewedFiles: [],
    reviewedFileHashes: {},
    stagedFiles: [],
    decisions: [],
  });

  if (mode === "file") {
    const resolved = path.isAbsolute(opts.path ?? "")
      ? opts.path!
      : path.resolve(cwd, opts.path ?? "");
    // Resolve symlinks (e.g. macOS /var → /private/var) so the path agrees with
    // getGitRoot's realpath and relative() doesn't wrongly escape the repo.
    const abs = await fs.realpath(resolved).catch(() => resolved);
    const root = await getGitRoot(path.dirname(abs)).catch(() => path.dirname(abs));
    const source = await buildDiffSource({ mode, root, path: abs });
    if (!source) return null;
    const r = path.relative(root, abs);
    return make(
      root,
      source,
      { staged: false, target: r.startsWith("..") ? abs : r },
      await getHead(root),
    );
  }
  if (mode === "pr") {
    const root = await getGitRoot(cwd);
    const defaultBranch = opts.base ?? (await resolveDefaultBranch(root));
    const base = await git(["merge-base", defaultBranch, "HEAD"], root).catch(() => defaultBranch);
    const source = await buildDiffSource({ mode, root, base });
    if (!source) return null;
    return make(root, source, { staged: false, target: opts.target, base }, await getHead(root));
  }
  const requested = opts.path
    ? path.isAbsolute(opts.path)
      ? opts.path
      : path.resolve(cwd, opts.path)
    : cwd;
  const stat = opts.path ? await fs.stat(requested).catch(() => undefined) : undefined;
  const discovery = opts.path ? (stat?.isDirectory() ? requested : path.dirname(requested)) : cwd;
  const root = await getGitRoot(discovery);
  const rel = opts.path ? path.relative(root, requested) : undefined;
  const source = await buildDiffSource({ mode, root, path: rel, staged: opts.staged });
  if (!source) return null;
  return make(root, source, { staged: !!opts.staged }, await getHead(root));
}

export async function reviewDir(root: string, session: string) {
  const home = process.env.HOME || process.env.USERPROFILE || root;
  const dir = path.join(home, ".galley", hash(root), sanitizeSession(session));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Global display preferences (~/.galley/settings.json) — deliberately NOT per-repo or
// per-session: these are the reviewer's, and the desk's random port makes browser
// localStorage useless for them (origin changes every launch).
export function globalSettingsPath() {
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return path.join(home, ".galley", "settings.json");
}

export async function readGlobalSettings(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(globalSettingsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // missing or corrupt → client falls back to defaults
  }
}

export async function writeGlobalSettings(data: unknown) {
  const file = globalSettingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function deskLockPath(dir: string) {
  return path.join(dir, "desk.lock");
}

export type DeskLock = { pid: number; url: string; session: string; startedAt: string };

export async function readDeskLock(root: string, session: string): Promise<DeskLock | null> {
  try {
    const raw = await fs.readFile(deskLockPath(await reviewDir(root, session)), "utf8");
    const lock = JSON.parse(raw) as DeskLock;
    return lock.url ? lock : null;
  } catch {
    return null;
  }
}

// Live desks for this repo (across all sessions), used to auto-target
// await/comment/reload when --session isn't given. A lock whose pid is dead is
// debris from a crash/SIGKILL (only a clean exit unlinks it) — sweep it here so
// stale locks don't accumulate under ~/.galley across sessions.
export async function findLiveDesks(root: string): Promise<DeskLock[]> {
  const home = process.env.HOME || process.env.USERPROFILE || root;
  const base = path.join(home, ".galley", hash(root));
  const sessions = await fs.readdir(base).catch(() => []);
  const out: DeskLock[] = [];
  for (const s of sessions) {
    const lock = await readDeskLock(root, s);
    if (!lock) continue;
    const alive = (() => {
      try {
        process.kill(lock.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (alive) out.push(lock);
    else await fs.unlink(deskLockPath(await reviewDir(root, s))).catch(() => undefined);
  }
  return out;
}

function reviewFileName(state: ReviewState) {
  return `${state.createdAt.replace(/[:.]/g, "-")}-${state.id}.json`;
}

// Merge the reviewer-owned slice posted to /api/save onto the live state. Only these
// fields are mutated from the browser; everything else (rawDiff, files, changes, guide,
// desk metadata) stays server-authoritative. We pick each key from whatever body arrives
// and replace wholesale (snapshot semantics, latest wins) — a key absent from the body is
// left untouched. Picking (rather than Object.assign) is what lets a stale open tab keep
// working: it may POST the whole old ReviewState, and we simply ignore everything but these.
const REVIEWER_SAVE_KEYS = [
  "decisions",
  "comments",
  "reviewedFiles",
  "reviewedFileHashes",
  "decisionFiles",
] as const satisfies ReadonlyArray<keyof ReviewerSave>;
export function mergeReviewerSave(state: ReviewState, body: unknown) {
  if (!body || typeof body !== "object") return;
  const incoming = body as Record<string, unknown>;
  for (const key of REVIEWER_SAVE_KEYS) {
    if (incoming[key] !== undefined) (state as Record<string, unknown>)[key] = incoming[key];
  }
}

// Write via a same-directory temp file + rename so a desk killed mid-write never leaves a truncated
// review behind: the rename is atomic on one filesystem, so a reader sees either the whole old file
// or the whole new one, never a half. Same dir keeps source and target on the same filesystem.
export async function writeFileAtomic(file: string, data: string) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}

export async function persistReview(state: ReviewState) {
  const dir = await reviewDir(state.root, state.session);
  state.updatedAt = nowIso();
  const file = path.join(dir, state.persistFile ?? reviewFileName(state));
  state.persistFile = path.basename(file);
  await writeFileAtomic(file, JSON.stringify(state, null, 2) + "\n");
  return file;
}

export async function loadLatestReview(root: string, session: string) {
  const dir = await reviewDir(root, session);
  const entries = await fs.readdir(dir).catch(() => []);
  for (const name of entries
    .filter((n) => n.endsWith(".json"))
    .sort()
    .reverse()) {
    const full = path.join(dir, name);
    const state = JSON.parse(await fs.readFile(full, "utf8")) as ReviewState;
    if (state.root !== root) continue;
    state.persistFile = name;
    state.comments ??= [];
    state.changes ??= [];
    state.reviewedFiles ??= [];
    state.stagedFiles ??= [];
    return state;
  }
  return null;
}

function decisionFromChange(c: ChangeState): Decision {
  return {
    key: `${c.path}:${c.stableKey}`,
    status: c.status as "accepted" | "rejected",
    reviewedHash: c.reviewedHash,
    path: c.path,
    lineNumber: c.lineNumber,
    side: c.side,
    title: c.title,
  };
}

// Decisions[] is the source of truth. For reviews persisted before it existed,
// derive decisions from any decided changes so the handoff/summary stay correct.
function effectiveDecisions(state: ReviewState): Decision[] {
  if (state.decisions) return state.decisions;
  return state.changes.filter((c) => c.status !== "pending").map(decisionFromChange);
}

// The exact text of the line a comment anchors to, from the file's on-demand contents (additions
// side = new file, deletions side = old file). Pure — the caller fetches the one file's contents
// (readFileContents) since the state no longer embeds them. Captured at comment creation;
// re-anchoring matches against it after the agent's edits move things around.
export function anchorTextFor(
  contents: FileContents | undefined,
  side: "additions" | "deletions",
  lineNumber: number,
): string | undefined {
  const text = side === "deletions" ? contents?.oldContents : contents?.newContents;
  return text?.split("\n")[lineNumber - 1];
}

// Sørensen–Dice similarity on character bigrams (whitespace-normalized), 0..1. Cheap and good
// at "same line, lightly edited" — the case a comment loses its exact anchor to.
function lineSimilarity(a: string, b: string): number {
  const na = a.trim().replace(/\s+/g, " ");
  const nb = b.trim().replace(/\s+/g, " ");
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = grams(na);
  const B = grams(nb);
  let inter = 0;
  let total = na.length - 1 + (nb.length - 1);
  for (const [g, ca] of A) {
    const cb = B.get(g);
    if (cb) inter += Math.min(ca, cb);
  }
  return total > 0 ? (2 * inter) / total : 0;
}

// Best-effort fallback when a comment's anchor text no longer appears verbatim: the most similar
// surviving line (Dice ≥ 0.6), preferring the closest to the old position on a near-tie. Returns
// the 1-based line, or undefined when nothing is similar enough (then the thread detaches cleanly).
function nearestSimilarLine(
  lines: string[],
  anchorText: string,
  oldLine: number,
): number | undefined {
  if (anchorText.trim() === "") return undefined;
  let best: { line: number; sim: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const sim = lineSimilarity(lines[i]!, anchorText);
    if (sim < 0.6) continue;
    const line = i + 1;
    if (
      !best ||
      sim > best.sim + 0.05 ||
      (Math.abs(sim - best.sim) <= 0.05 && Math.abs(line - oldLine) < Math.abs(best.line - oldLine))
    )
      best = { line, sim };
  }
  return best?.line;
}

// Recover comment anchors after the diff is rebuilt. Open comments only (resolved threads
// are done — they only render if their line still does). Exact text at the recorded line →
// anchored; else the unique nearest line with exactly that text → move the anchor there; else a
// best-effort fuzzy match keeps a lightly-edited line's thread near its old spot; only when
// nothing is similar enough do we flag `unanchored` so the desk shows the thread in its
// file-level strip rather than silently dropping it (an open change request blocks approval, so
// it must stay reachable). Legacy comments without anchorText can only be flagged when their
// line is provably out of range.
//
// `contentsOf` resolves a present file's on-demand contents (the state no longer embeds them). The
// caller fetches only the files carrying an open comment — the same set this processes — so a file
// with no resolved contents is treated as empty (matching a missing embedded side before issue 04).
export function reanchorComments(
  comments: ReviewComment[],
  files: ReviewFile[],
  contentsOf: (path: string) => FileContents | undefined,
) {
  for (const c of comments) {
    if (c.status !== "open") continue;
    const file = files.find((f) => f.path === c.path);
    if (!file) continue; // file-level staleness is handled by the caller
    const co = contentsOf(c.path);
    const contents = c.side === "deletions" ? co?.oldContents : co?.newContents;
    const lines = (contents ?? "").split("\n");
    if (!c.anchorText) {
      c.unanchored = c.lineNumber > lines.length;
      continue;
    }
    if (lines[c.lineNumber - 1] === c.anchorText) {
      c.unanchored = false;
      continue;
    }
    const matches: number[] = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] === c.anchorText) matches.push(i + 1);
    let best: number | undefined;
    if (matches.length === 1) best = matches[0];
    else if (matches.length > 1) {
      matches.sort((a, b) => Math.abs(a - c.lineNumber) - Math.abs(b - c.lineNumber));
      // A tie between equally-near lines is ambiguous — don't guess.
      if (Math.abs(matches[0] - c.lineNumber) !== Math.abs(matches[1] - c.lineNumber))
        best = matches[0];
    }
    // Best-effort: the anchor text appears NOWHERE now (the line was edited, not merely moved), so
    // try the nearest similar surviving line before giving up — a comment on a line the agent only
    // tweaked should stay put, not fall to the strip. (An ambiguous exact-match tie stays
    // unanchored: the text still exists verbatim, just in >1 equally-near places — don't guess.)
    if (best === undefined && matches.length === 0)
      best = nearestSimilarLine(lines, c.anchorText, c.lineNumber);
    if (best !== undefined && c.anchorText.trim() !== "") {
      const delta = best - c.lineNumber;
      c.lineNumber = best;
      if (c.endLine !== undefined) c.endLine += delta;
      c.unanchored = false;
    } else {
      c.unanchored = true;
    }
  }
  return comments;
}

export async function mergeReviewState(base: ReviewState, saved: ReviewState | null) {
  if (!saved) return base;
  const currentFiles = new Set(base.files.map((file) => file.path));
  // A file that became a git-native rename on THIS reload arrives at its new path, but every
  // decision/comment/sign-off the reviewer recorded before the rename is keyed to the old path.
  // That mismatch is guaranteed on every rename (unlike ordinary content staleness), so without
  // remapping, those records silently drop (comment path miss) or reset to pending (decision key
  // miss) the moment the rename appears. Remap old→new up front; the stableKey/contentHash/anchor
  // checks below then judge staleness on the real content as usual. (Reused by issues 02/03 for
  // working-mode move pairing and guide-declared merges.)
  const renameMap = new Map<string, string>();
  for (const f of base.files)
    if (f.oldPath && f.newPath && f.oldPath !== f.newPath) renameMap.set(f.oldPath, f.newPath);
  const migratePath = (p: string) => renameMap.get(p) ?? p;
  // A `path:stableKey` key whose path prefix was renamed — swap the prefix, keep the stableKey.
  const migrateKey = (key: string) => {
    for (const [oldP, newP] of renameMap)
      if (key.startsWith(`${oldP}:`)) return `${newP}:${key.slice(oldP.length + 1)}`;
    return key;
  };
  // Decisions are explicit and durable: carry them forward as the source of truth.
  // A decision whose change is gone from the rebuilt diff (e.g. accepting it staged
  // the hunk out of the working tree) is *kept* — that's the whole point. A decision
  // whose change is still visible but whose content changed is dropped as stale.
  let decisions = effectiveDecisions(saved).map((d) => {
    const newPath = renameMap.get(d.path);
    // key is `${path}:${stableKey}` — swap the path prefix, keep the stableKey intact.
    if (!newPath) return d;
    return { ...d, path: newPath, key: `${newPath}:${d.key.slice(d.path.length + 1)}` };
  });
  const decisionByKey = new Map(decisions.map((d) => [d.key, d]));
  const stale = new Set<string>();
  for (const change of base.changes) {
    const key = `${change.path}:${change.stableKey}`;
    const d = decisionByKey.get(key);
    if (!d) continue;
    if (d.reviewedHash && change.contentHash && d.reviewedHash === change.contentHash) {
      change.status = d.status;
      change.reviewedHash = d.reviewedHash;
    } else {
      stale.add(key); // agent rewrote this block since it was reviewed → re-review
    }
  }
  // An accepted decision whose change vanished is kept (accepting may have staged the
  // hunk out of the diff). A REJECTED decision whose change vanished means the agent
  // reworked the block away — the rejection was honored, and keeping it would leave an
  // invisible objection that blocks approval forever. Drop it; whatever replaced the
  // block shows up as a fresh pending change anyway.
  const presentKeys = new Set(base.changes.map((c) => `${c.path}:${c.stableKey}`));
  decisions = decisions.filter(
    (d) => !stale.has(d.key) && (d.status !== "rejected" || presentKeys.has(d.key)),
  );
  // A file's approval/sign-off survives reload only if the file is still present AND its
  // content hash is unchanged. A file whose content the agent rewrote (or that has no
  // recorded hash — e.g. an old "viewed" session) drops back to pending for re-review.
  const fileHashes = new Map(base.files.map((file) => [file.path, file.contentHash]));
  // Sign-off + its hash also migrate old→new (a pure rename keeps the content hash, so approval
  // survives; a rename+edit fails the hash check below and re-reviews, as any content change does).
  const savedHashes = Object.fromEntries(
    Object.entries(saved.reviewedFileHashes ?? {}).map(([p, h]) => [migratePath(p), h]),
  );
  const reviewedFiles = saved.reviewedFiles
    .map(migratePath)
    .filter(
      (file) =>
        currentFiles.has(file) && savedHashes[file] && savedHashes[file] === fileHashes.get(file),
    );
  const reviewedFileHashes = Object.fromEntries(
    reviewedFiles.map((file) => [file, savedHashes[file]!]),
  );
  const comments = saved.comments
    .map((comment) =>
      renameMap.has(comment.path) ? { ...comment, path: migratePath(comment.path) } : comment,
    )
    .map((comment) =>
      currentFiles.has(comment.path) ? comment : { ...comment, status: "stale" as const },
    )
    .filter((comment) => currentFiles.has(comment.path) || comment.intent === "action");
  // Re-anchoring reads each commented file's contents on demand (the state embeds none). Fetch only
  // the files carrying an OPEN comment — the set reanchorComments actually processes — so a reload
  // spawns at most one content read per commented file, not per file in the diff. A read that fails
  // (a git object dropped mid-reload) is swallowed to no-contents: the thread just falls to the
  // file-level unanchored strip rather than crashing the whole reload.
  const openPaths = new Set(comments.filter((c) => c.status === "open").map((c) => c.path));
  const contentsByPath = new Map<string, FileContents>();
  for (const f of base.files)
    if (openPaths.has(f.path)) {
      const resolved = await readFileContents(base, f).catch(() => undefined);
      if (resolved) contentsByPath.set(f.path, resolved);
    }
  return {
    ...base,
    id: saved.id,
    createdAt: saved.createdAt,
    comments: reanchorComments(comments, base.files, (p) => contentsByPath.get(p)),
    reviewedFiles,
    reviewedFileHashes,
    stagedFiles: saved.stagedFiles,
    // Migrate staged-hunk keys old→new too, so a working-mode pair's pre-rename key doesn't linger
    // stale after the rename appears (syncGitState later prunes keys whose file isn't staged).
    stagedChangeKeys: (saved.stagedChangeKeys ?? []).map(migrateKey),
    decisionFiles: (saved.decisionFiles ?? []).map(migratePath),
    decisions,
    // Carry the attached guide forward across reload/restart (the rebuilt base has none).
    guide: saved.guide ?? base.guide,
    persistFile: saved.persistFile,
  } satisfies ReviewState;
}

export async function syncGitState(state: ReviewState) {
  const staged = await git(["diff", "--cached", "--name-only"], state.root).catch(() => "");
  const stagedFiles = new Set(staged.split(/\r?\n/).filter(Boolean));
  const reviewFiles = new Set(state.files.map((file) => file.path));
  state.stagedFiles = [...stagedFiles].filter((file) => reviewFiles.has(file));
  state.stagedChangeKeys = (state.stagedChangeKeys ?? []).filter((key) =>
    stagedFiles.has(key.split(":")[0]),
  );
}

// Files the reviewer signed off as-is: finished (in reviewedFiles, content hash still current)
// AND with no objections — no rejected hunk and no open requested-change comment (questions and
// agent replies don't count). Guarantees approvedFiles is disjoint from rejected/requestedChanges.
export function computeApprovedFiles(state: ReviewState): string[] {
  const hashes = state.reviewedFileHashes ?? {};
  const fileHash = new Map(state.files.map((f) => [f.path, f.contentHash]));
  const decisions = effectiveDecisions(state);
  const hasReject = (p: string) => decisions.some((d) => d.path === p && d.status === "rejected");
  const hasOpenChange = (p: string) =>
    state.comments.some(
      (c) => c.path === p && c.status === "open" && c.role !== "agent" && c.intent !== "question",
    );
  return (state.reviewedFiles ?? []).filter(
    (p) => hashes[p] && hashes[p] === fileHash.get(p) && !hasReject(p) && !hasOpenChange(p),
  );
}

export async function appendComment(
  root: string,
  session: string,
  input: {
    path: string;
    side: "additions" | "deletions";
    lineNumber: number;
    body: string;
    role: "user" | "agent";
  },
): Promise<ReviewComment> {
  const saved = await loadLatestReview(root, session);
  if (!saved)
    throw new Error(`No saved review for session "${session}" in ${root}. Open the desk first.`);
  const now = nowIso();
  // Fetch just this file's contents (the state embeds none) to capture the anchor line.
  const file = saved.files.find((f) => f.path === input.path);
  const contents = file ? await readFileContents(saved, file) : undefined;
  const comment: ReviewComment = {
    id: crypto.randomUUID(),
    path: input.path,
    side: input.side,
    lineNumber: input.lineNumber,
    body: input.body,
    createdAt: now,
    updatedAt: now,
    status: "open",
    intent: "note",
    role: input.role,
    anchorText: anchorTextFor(contents, input.side, input.lineNumber),
  };
  saved.comments.push(comment);
  await persistReview(saved);
  return comment;
}

// The single QuestionPayload constructor — shared by /api/ask (live question event) and
// computeOpenQuestions (questions folded into a Send) so the two payload shapes can't drift.
export function questionPayload(
  state: Pick<ReviewState, "mode" | "session">,
  q: { path: string; lineNumber: number; side: "additions" | "deletions"; body: string },
): QuestionPayload {
  return {
    path: q.path,
    lineNumber: q.lineNumber,
    side: q.side,
    body: q.body,
    mode: state.mode,
    session: state.session,
  };
}

// Questions the reviewer asked but the agent hasn't answered yet. Mirrors the UI's "answered"
// heuristic (src/ui/annotations.ts): an open question comment is unanswered until a later agent
// reply lands in the same thread (same path/side/line). These ride out on the Send's ReviewResult
// so an agent that never saw the live await still owes each an answer.
export function computeOpenQuestions(state: ReviewState): QuestionPayload[] {
  return state.comments
    .filter(
      (c) =>
        c.intent === "question" &&
        c.status === "open" &&
        c.role !== "agent" &&
        !state.comments.some(
          (r) =>
            r.role === "agent" &&
            r.path === c.path &&
            r.side === c.side &&
            r.lineNumber === c.lineNumber &&
            +new Date(r.createdAt) > +new Date(c.createdAt),
        ),
    )
    .map((c) => questionPayload(state, c));
}

export function buildReviewResult(
  state: ReviewState,
  artifacts: { resultJson: string; sessionDir: string },
  overallNote?: string,
): ReviewResult {
  const decisions = effectiveDecisions(state);
  const pick = (status: Decision["status"]) =>
    decisions
      .filter((d) => d.status === status)
      .map((d) => ({ path: d.path, lineNumber: d.lineNumber, side: d.side, title: d.title }));
  const note = overallNote?.trim();
  return {
    session: state.session,
    repoRoot: state.root,
    mode: state.mode,
    target: state.target,
    base: state.base,
    staged: state.staged,
    head: state.head,
    baseDiffHash: state.baseDiffHash,
    accepted: pick("accepted"),
    rejected: pick("rejected"),
    requestedChanges: state.comments
      .filter((c) => c.status === "open" && c.role !== "agent" && c.intent !== "question")
      .map((c) => ({ path: c.path, lineNumber: c.lineNumber, side: c.side, body: c.body })),
    overallNote: note || undefined,
    stagedFiles: state.stagedFiles,
    approvedFiles: computeApprovedFiles(state),
    openQuestions: computeOpenQuestions(state),
    artifacts,
  };
}
