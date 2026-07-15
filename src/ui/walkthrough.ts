import type { DiffHunk, GuideFile } from "../types";
import type { FileReviewState } from "./types";

// Pure data for the Walkthrough sidebar tab and the Overview file list — no store import
// (these are parameterized like linemap.ts so they stay testable under node:test).

export type LineStat = { added: number; removed: number };
type FileLike = {
  path: string;
  hunks?: DiffHunk[];
  // The lean builder's +added/−removed stamps (issue 04), including a hunk-less full-file add's
  // whole-content count. Preferred when present; falls back to summing hunks (test fixtures).
  added?: number;
  removed?: number;
  // Distinct on a git rename (issue 01) — drives the "← old path" arrow on a pure-rename row.
  oldPath?: string;
  newPath?: string;
};

// Per-file +added/−removed. Reads the lean builder's stamps (issue 04) — which already count a
// hunk-less full-file add's whole content — and falls back to summing the parsed hunks when a
// fixture supplies none. Distinct from guide.ts's progress weighting (one min-1 count): display numbers.
export function lineStats(files: FileLike[]): Map<string, LineStat> {
  const m = new Map<string, LineStat>();
  for (const f of files) {
    if (typeof f.added === "number" && typeof f.removed === "number") {
      m.set(f.path, { added: f.added, removed: f.removed });
      continue;
    }
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
  skim: boolean; // the guide marked the whole file skimmable → a muted indicator
  movedFrom: string; // pure rename (issue 01): the old path, "" when not a rename
  added: number;
  removed: number;
  state: FileReviewState;
};

export type WalkGroup = {
  category: string;
  other: boolean; // the trailing group of diff files the guide didn't list
  skimmed: boolean; // the trailing collapsed group of fully-skimmed files (issue 07)
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
  fullySkimmed: (path: string) => boolean = () => false,
): WalkGroup[] {
  const stats = lineStats(files);
  const index = new Map(files.map((f, i) => [f.path, i] as const));
  const mkFile = (path: string, fileIndex: number, g?: GuideFile): WalkFile => {
    const name = path.split("/").pop() || path;
    const s = stats.get(path) ?? { added: 0, removed: 0 };
    const fl = files[fileIndex];
    const moved = fl?.oldPath && fl?.newPath && fl.oldPath !== fl.newPath ? fl.oldPath : "";
    return {
      path,
      dir: path.slice(0, path.length - name.length),
      name,
      fileIndex,
      orientation: g?.orientation ?? "",
      flag: g?.flag ?? "",
      skim: !!g?.skim,
      movedFrom: moved,
      added: s.added,
      removed: s.removed,
      state: stateOf(path),
    };
  };
  const mkGroup = (category: string, other: boolean, skimmed = false): WalkGroup => ({
    category,
    other,
    skimmed,
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
  // Fully-skimmed files leave their normal group (guide category or Other) and gather in one
  // trailing collapsed "Skimmed" group (issue 07). Collected here, appended last.
  const skimmed = mkGroup("Skimmed", false, true);
  // Track only the current group: a skipped file (not in the diff) leaves no visible gap, so
  // it must not split a run — hence the category compare happens against the last *shown* file.
  let cur: WalkGroup | null = null;
  for (const g of guideFiles) {
    listed.add(g.path);
    const i = index.get(g.path);
    if (i === undefined) continue;
    if (fullySkimmed(g.path)) {
      add(skimmed, mkFile(g.path, i, g));
      continue;
    }
    // A skimmed file must not carry the run forward — compare/open the category off shown,
    // in-flow files only, so a skimmed file between two same-category files can't split them.
    if (!cur || cur.category !== g.category) {
      cur = mkGroup(g.category, false);
      groups.push(cur);
    }
    add(cur, mkFile(g.path, i, g));
  }
  const other = mkGroup("Other", true);
  files.forEach((f, i) => {
    if (listed.has(f.path)) return;
    if (fullySkimmed(f.path)) add(skimmed, mkFile(f.path, i));
    else add(other, mkFile(f.path, i));
  });
  if (other.total) groups.push(other);
  if (skimmed.total) groups.push(skimmed);
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
      // The trailing collapsed "Skimmed" group's header (issue 07): a toggle, not a jump target;
      // `open` drives its caret, and its file rows are emitted only while open.
      skimmed: boolean;
      open: boolean;
      total: number;
      done: number;
      added: number;
      removed: number;
      complete: boolean;
      jumpIndex: number; // diff index a header click selects (first pending in the group, else its first)
    }
  | (WalkFile & { kind: "file"; key: string; cls: string; style: string });

export function walkRows(
  groups: WalkGroup[],
  activePath: string | null,
  skimGroupExpanded = false,
): WalkRow[] {
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
      key: `cat:${gi}:${g.skimmed ? "·skimmed" : g.other ? "·other" : g.category}`,
      category: g.category,
      other: g.other,
      skimmed: g.skimmed,
      open: g.skimmed ? skimGroupExpanded : true,
      total: g.total,
      done: g.done,
      added: g.added,
      removed: g.removed,
      complete: g.done === g.total,
      jumpIndex: target.fileIndex,
    });
    // A collapsed Skimmed group hides its file rows until expanded; every other group is
    // always open.
    if (g.skimmed && !skimGroupExpanded) return;
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
