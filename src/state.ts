import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  changeBlockContent,
  changeStableKeyFromBlock,
  fileAt,
  getGitRoot,
  getHead,
  git,
  parseUnifiedDiff,
  changeBlocks,
} from "./git.js";
import type {
  ChangeState,
  Decision,
  ReviewComment,
  ReviewFile,
  ReviewMode,
  ReviewResult,
  ReviewState,
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

function fileEntry(filePath: string, oldContents: string, newContents: string): ReviewFile {
  return {
    oldPath: filePath,
    newPath: filePath,
    hunks: [],
    path: filePath,
    oldFile: { name: filePath, contents: oldContents },
    newFile: { name: filePath, contents: newContents },
    contentHash: hash(newContents),
  };
}

// Parse a unified diff into review files + change blocks, fetching old/new file
// contents however the mode requires, and tagging each change as stageable or not.
async function assembleDiff(
  rawDiff: string,
  fetchOld: (p?: string) => Promise<string>,
  fetchNew: (p?: string) => Promise<string>,
  stageable: boolean,
): Promise<{ files: ReviewFile[]; changes: ChangeState[] }> {
  const files: ReviewFile[] = [];
  const changes: ChangeState[] = [];
  for (const f of parseUnifiedDiff(rawDiff)) {
    const filePath = f.newPath ?? f.oldPath ?? "unknown";
    const newContents = await fetchNew(f.newPath);
    files.push({
      ...f,
      path: filePath,
      oldFile: { name: filePath, contents: await fetchOld(f.oldPath) },
      newFile: { name: filePath, contents: newContents },
      contentHash: hash(newContents),
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
    const rawDiff = await git(["diff", "--no-ext-diff", `${base}..HEAD`], root);
    if (!rawDiff.trim()) return null;
    const { files, changes } = await assembleDiff(
      rawDiff,
      (p) => fileAt(root, p, base),
      (p) => fileAt(root, p, "HEAD"),
      false,
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
      const rawDiff = await git(["diff", "--no-ext-diff", "--", rel], root);
      if (rawDiff.trim()) {
        // Old side reads from the INDEX (:0), not HEAD — `git diff` diffs working tree vs
        // index, and the UI re-diffs old/new contents rather than rendering these hunks.
        // A HEAD baseline would resurrect already-staged changes as pending diff.
        const { files, changes } = await assembleDiff(
          rawDiff,
          (p) => fileAt(root, p, ":0"),
          (p) => fileAt(root, p),
          true,
        );
        return { files, changes, rawDiff };
      }
      return { files: [fileEntry(key, working, working)], changes: [], rawDiff: "" }; // tracked, unchanged → full file
    }
    return { files: [fileEntry(key, "", working)], changes: [], rawDiff: "" }; // untracked/new → full file as additions
  }
  // repo
  const args = ["diff", "--no-ext-diff"];
  if (opts.staged) args.push("--cached");
  if (opts.path) args.push("--", opts.path);
  const rawDiff = await git(args, root);
  if (!rawDiff.trim()) return null;
  // Each side must match what the diff was taken against, because the UI re-diffs the
  // old/new contents itself instead of rendering these hunks. Unstaged diffs working
  // tree vs INDEX, so old reads :0 — a HEAD baseline would resurrect already-staged
  // changes as pending diff on every reload. Staged (--cached) diffs index vs HEAD.
  const { files, changes } = await assembleDiff(
    rawDiff,
    (p) => fileAt(root, p, opts.staged ? "HEAD" : ":0"),
    (p) => (opts.staged ? fileAt(root, p, ":0") : fileAt(root, p)),
    true,
  );
  return { files, changes, rawDiff };
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
// await/comment/reload when --session isn't given.
export async function findLiveDesks(root: string): Promise<DeskLock[]> {
  const home = process.env.HOME || process.env.USERPROFILE || root;
  const base = path.join(home, ".galley", hash(root));
  const sessions = await fs.readdir(base).catch(() => []);
  const out: DeskLock[] = [];
  for (const s of sessions) {
    const lock = await readDeskLock(root, s);
    if (
      lock &&
      (() => {
        try {
          process.kill(lock.pid, 0);
          return true;
        } catch {
          return false;
        }
      })()
    )
      out.push(lock);
  }
  return out;
}

function reviewFileName(state: ReviewState) {
  return `${state.createdAt.replace(/[:.]/g, "-")}-${state.id}.json`;
}

export async function persistReview(state: ReviewState) {
  const dir = await reviewDir(state.root, state.session);
  state.updatedAt = nowIso();
  const file = path.join(dir, state.persistFile ?? reviewFileName(state));
  state.persistFile = path.basename(file);
  await fs.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
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

// The exact text of the line a comment anchors to, read from the review files' contents
// (additions side = new file, deletions side = old file). Captured at comment creation;
// re-anchoring matches against it after the agent's edits move things around.
export function anchorTextFor(
  files: ReviewFile[],
  filePath: string,
  side: "additions" | "deletions",
  lineNumber: number,
): string | undefined {
  const file = files.find((f) => f.path === filePath);
  if (!file) return undefined;
  const contents = side === "deletions" ? file.oldFile?.contents : file.newFile?.contents;
  return contents?.split("\n")[lineNumber - 1];
}

// Recover comment anchors after the diff is rebuilt. Open comments only (resolved threads
// are done — they only render if their line still does). Exact text at the recorded line →
// anchored; else the unique nearest line with exactly that text → move the anchor there;
// ambiguous or vanished → flag `unanchored` so the desk shows the thread in its file-level
// strip rather than silently dropping it (an open change request blocks approval, so it
// must stay reachable). Legacy comments without anchorText can only be flagged when their
// line is provably out of range.
export function reanchorComments(comments: ReviewComment[], files: ReviewFile[]) {
  for (const c of comments) {
    if (c.status !== "open") continue;
    const file = files.find((f) => f.path === c.path);
    if (!file) continue; // file-level staleness is handled by the caller
    const contents = c.side === "deletions" ? file.oldFile?.contents : file.newFile?.contents;
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

export function mergeReviewState(base: ReviewState, saved: ReviewState | null) {
  if (!saved) return base;
  const currentFiles = new Set(base.files.map((file) => file.path));
  // Decisions are explicit and durable: carry them forward as the source of truth.
  // A decision whose change is gone from the rebuilt diff (e.g. accepting it staged
  // the hunk out of the working tree) is *kept* — that's the whole point. A decision
  // whose change is still visible but whose content changed is dropped as stale.
  let decisions = effectiveDecisions(saved);
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
  const savedHashes = saved.reviewedFileHashes ?? {};
  const reviewedFiles = saved.reviewedFiles.filter(
    (file) =>
      currentFiles.has(file) && savedHashes[file] && savedHashes[file] === fileHashes.get(file),
  );
  const reviewedFileHashes = Object.fromEntries(
    reviewedFiles.map((file) => [file, savedHashes[file]!]),
  );
  return {
    ...base,
    id: saved.id,
    createdAt: saved.createdAt,
    comments: reanchorComments(
      saved.comments
        .map((comment) =>
          currentFiles.has(comment.path) ? comment : { ...comment, status: "stale" as const },
        )
        .filter((comment) => currentFiles.has(comment.path) || comment.intent === "action"),
      base.files,
    ),
    reviewedFiles,
    reviewedFileHashes,
    stagedFiles: saved.stagedFiles,
    stagedChangeKeys: saved.stagedChangeKeys ?? [],
    decisionFiles: saved.decisionFiles ?? [],
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

export function buildReviewSummary(state: ReviewState) {
  const pr = state.mode === "pr";
  const scope = pr
    ? `the PR/branch${state.target ? ` \`${state.target}\`` : ""} (committed changes)`
    : state.mode === "file"
      ? `the file${state.target ? ` \`${state.target}\`` : ""}`
      : state.staged
        ? "the staged diff"
        : "the working tree diff";
  const out = [`Please address this review for ${scope}.`, ""];
  out.push(
    pr
      ? "These are committed changes. Amend the branch to address requested changes; leave approved hunks as-is."
      : "Respect the user review decisions below: preserve accepted changes, avoid touching staged files unless necessary, and address rejected changes plus requested changes.",
    "",
  );
  if (!pr && state.stagedFiles.length) {
    out.push("## Staged files");
    for (const file of state.stagedFiles) out.push(`- ${file}`);
    out.push("");
  }
  const approved = computeApprovedFiles(state);
  if (approved.length) {
    out.push("## Approved files (signed off — leave as-is)");
    for (const file of approved) out.push(`- ${file}`);
    out.push("");
  }
  const decisions = effectiveDecisions(state);
  const accepted = decisions.filter((d) => d.status === "accepted");
  const rejected = decisions.filter((d) => d.status === "rejected");
  if (accepted.length) {
    out.push(pr ? "## Approved hunks" : "## Accepted line changes");
    for (const d of accepted) out.push(`- ${d.path}:${d.lineNumber} (${d.side}) ${d.title}`);
    out.push("");
  }
  if (rejected.length) {
    out.push(pr ? "## Hunks needing changes" : "## Rejected line changes");
    for (const d of rejected) out.push(`- ${d.path}:${d.lineNumber} (${d.side}) ${d.title}`);
    out.push("");
  }
  // Questions are answered live (the await stream), so they're not change-requests.
  const actionable = state.comments.filter(
    (c) => c.status === "open" && c.role !== "agent" && c.intent !== "question",
  );
  if (actionable.length) {
    out.push("## Requested changes");
    for (const c of actionable) {
      out.push(`- ${c.path}:${c.lineNumber} (${c.side})`);
      out.push(`  ${c.body}`);
    }
  }
  return out.join("\n");
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
    anchorText: anchorTextFor(saved.files, input.path, input.side, input.lineNumber),
  };
  saved.comments.push(comment);
  await persistReview(saved);
  return comment;
}

export function buildReviewResult(
  state: ReviewState,
  artifacts: { resultJson: string; summaryMd: string; sessionDir: string },
): ReviewResult {
  const decisions = effectiveDecisions(state);
  const pick = (status: Decision["status"]) =>
    decisions
      .filter((d) => d.status === status)
      .map((d) => ({ path: d.path, lineNumber: d.lineNumber, side: d.side, title: d.title }));
  return {
    session: state.session,
    repoRoot: state.root,
    mode: state.mode,
    target: state.target,
    base: state.base,
    staged: state.staged,
    head: state.head,
    baseDiffHash: state.baseDiffHash,
    summaryMarkdown: buildReviewSummary(state),
    accepted: pick("accepted"),
    rejected: pick("rejected"),
    requestedChanges: state.comments
      .filter((c) => c.status === "open" && c.role !== "agent" && c.intent !== "question")
      .map((c) => ({ path: c.path, lineNumber: c.lineNumber, side: c.side, body: c.body })),
    stagedFiles: state.stagedFiles,
    approvedFiles: computeApprovedFiles(state),
    artifacts,
  };
}
