import type { DiffHunk, GuideFile } from "../types";
import type { FileReviewState } from "./types";

// Pure data for the Walkthrough sidebar tab and the Overview file list — no store import
// (these are parameterized like linemap.ts so they stay testable under node:test).

export type LineStat = { added: number; removed: number };
type FileLike = { path: string; hunks?: DiffHunk[] };

// Per-file +added/−removed from the parsed hunks. Distinct from guide.ts's progress
// weighting (which collapses both sides into one min-1 count): these are display numbers.
export function lineStats(files: FileLike[]): Map<string, LineStat> {
  const m = new Map<string, LineStat>();
  for (const f of files) {
    let added = 0,
      removed = 0;
    for (const h of f.hunks ?? [])
      for (const l of h.lines) {
        if (l.kind === "add") added++;
        else if (l.kind === "delete") removed++;
      }
    m.set(f.path, { added, removed });
  }
  return m;
}

export type WalkFile = {
  path: string;
  // dir + name === path; the templates dim the dir and emphasize the basename.
  dir: string;
  name: string;
  fileIndex: number;
  orientation: string; // guide markdown ("" for files the guide didn't list)
  flag: string; // flag note ("" = not flagged); presence raises the flag icon
  added: number;
  removed: number;
  state: FileReviewState;
};

export type WalkGroup = {
  category: string;
  other: boolean; // the trailing group of diff files the guide didn't list
  files: WalkFile[];
  added: number;
  removed: number;
  done: number; // files no longer pending
  total: number;
};

// Run-length grouping: categories and files in guide order, with a new section started each
// time the category changes from the previous *shown* file — so a category the agent lists
// non-contiguously yields separate sections instead of folding back up, and these surfaces
// mirror guideOrder() exactly. Guide entries absent from the diff are skipped (same rule as
// guideOrder); diff files absent from the guide land in a trailing "Other" group — so these
// surfaces always cover everything the progress strip counts and the two can never disagree.
export function walkthroughGroups(
  guideFiles: GuideFile[],
  files: FileLike[],
  stateOf: (path: string) => FileReviewState,
): WalkGroup[] {
  const stats = lineStats(files);
  const index = new Map(files.map((f, i) => [f.path, i] as const));
  const mkFile = (path: string, fileIndex: number, g?: GuideFile): WalkFile => {
    const name = path.split("/").pop() || path;
    const s = stats.get(path) ?? { added: 0, removed: 0 };
    return {
      path,
      dir: path.slice(0, path.length - name.length),
      name,
      fileIndex,
      orientation: g?.orientation ?? "",
      flag: g?.flag ?? "",
      added: s.added,
      removed: s.removed,
      state: stateOf(path),
    };
  };
  const mkGroup = (category: string, other: boolean): WalkGroup => ({
    category,
    other,
    files: [],
    added: 0,
    removed: 0,
    done: 0,
    total: 0,
  });
  const add = (grp: WalkGroup, f: WalkFile) => {
    grp.files.push(f);
    grp.added += f.added;
    grp.removed += f.removed;
    grp.total++;
    if (f.state !== "pending") grp.done++;
  };
  const groups: WalkGroup[] = [];
  const listed = new Set<string>();
  // Track only the current group: a skipped file (not in the diff) leaves no visible gap, so
  // it must not split a run — hence the category compare happens against the last *shown* file.
  let cur: WalkGroup | null = null;
  for (const g of guideFiles) {
    listed.add(g.path);
    const i = index.get(g.path);
    if (i === undefined) continue;
    if (!cur || cur.category !== g.category) {
      cur = mkGroup(g.category, false);
      groups.push(cur);
    }
    add(cur, mkFile(g.path, i, g));
  }
  const other = mkGroup("Other", true);
  files.forEach((f, i) => {
    if (!listed.has(f.path)) add(other, mkFile(f.path, i));
  });
  if (other.total) groups.push(other);
  return groups;
}

// Flat row list the sidebar template renders with x-for (the treeRows pattern): a header
// row per category, then its file rows. activePath marks the file being viewed (null on
// the Overview page — nothing is active there).
export type WalkRow =
  | {
      kind: "cat";
      key: string;
      category: string;
      other: boolean;
      total: number;
      done: number;
      added: number;
      removed: number;
      complete: boolean;
      jumpIndex: number; // diff index a header click selects (first pending in the group, else its first)
    }
  | (WalkFile & { kind: "file"; key: string; cls: string; style: string });

export function walkRows(groups: WalkGroup[], activePath: string | null): WalkRow[] {
  const rows: WalkRow[] = [];
  groups.forEach((g, gi) => {
    // First not-yet-finished file in THIS group, else its first — the rule the old
    // firstFileOfCategory used, but scoped to the clicked occurrence, not the category name.
    // Groups always carry ≥1 file (guide groups get one per add; Other is only pushed if it has any).
    const target = g.files.find((f) => f.state === "pending") ?? g.files[0]!;
    rows.push({
      kind: "cat",
      // The group index keeps the key unique when a category label repeats across runs;
      // "·other" still distinguishes the synthetic trailer from a guide category named "Other".
      key: `cat:${gi}:${g.other ? "·other" : g.category}`,
      category: g.category,
      other: g.other,
      total: g.total,
      done: g.done,
      added: g.added,
      removed: g.removed,
      complete: g.done === g.total,
      jumpIndex: target.fileIndex,
    });
    for (const f of g.files)
      rows.push({
        ...f,
        kind: "file",
        key: `file:${f.path}`,
        cls: f.path === activePath ? "active" : "",
        style: "--depth:1",
      });
  });
  return rows;
}
