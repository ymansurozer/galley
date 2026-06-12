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
  summary: string; // guide markdown ("" for files the guide didn't list)
  critical: boolean;
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

// Guide categories in first-occurrence order, files in guide order within each. Guide
// entries absent from the diff are skipped (same rule as guideOrder); diff files absent
// from the guide land in a trailing "Other" group — so these surfaces always cover
// everything the progress strip counts and the two can never disagree.
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
      summary: g?.summary ?? "",
      critical: !!g?.critical,
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
  const at = new Map<string, WalkGroup>();
  const listed = new Set<string>();
  for (const g of guideFiles) {
    listed.add(g.path);
    const i = index.get(g.path);
    if (i === undefined) continue;
    let grp = at.get(g.category);
    if (!grp) {
      grp = mkGroup(g.category, false);
      at.set(g.category, grp);
      groups.push(grp);
    }
    add(grp, mkFile(g.path, i, g));
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
    }
  | (WalkFile & { kind: "file"; key: string; cls: string; style: string });

export function walkRows(groups: WalkGroup[], activePath: string | null): WalkRow[] {
  const rows: WalkRow[] = [];
  for (const g of groups) {
    rows.push({
      kind: "cat",
      // "·other" can't collide with a guide category named "Other" (categories are
      // free-form agent text; the marker isn't).
      key: `cat:${g.other ? "·other" : g.category}`,
      category: g.category,
      other: g.other,
      total: g.total,
      done: g.done,
      added: g.added,
      removed: g.removed,
      complete: g.done === g.total,
    });
    for (const f of g.files)
      rows.push({
        ...f,
        kind: "file",
        key: `file:${f.path}`,
        cls: f.path === activePath ? "active" : "",
        style: "--depth:1",
      });
  }
  return rows;
}
