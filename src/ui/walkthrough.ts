import type { ChangeState, DiffHunk, GuideFile } from "../types";
import { slotOutOfFlow, stepPlan, type Step, type StepSlot } from "./steps";
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

// One change block's +added/−removed, read off its stableKey. The key is
// `side:line:deletions:additions` — built the same way server-side (git.ts
// changeStableKeyFromBlock) and in the tab (decisions-derive.ts changeStableKey) — so a part's
// counts come from blocks the tab already holds, with no diff walk. This couples the counts to
// that key format: a key of any other shape counts nothing.
export function blockLineStat(c: Pick<ChangeState, "stableKey">): LineStat {
  const m = c.stableKey?.match(/^(?:additions|deletions):\d+:(\d+):(\d+)$/);
  return m ? { added: Number(m[2]), removed: Number(m[1]) } : { added: 0, removed: 0 };
}

export type WalkFile = {
  path: string;
  // dir + name === path; the templates dim the dir and emphasize the basename.
  dir: string;
  name: string;
  fileIndex: number;
  // The step this row opens (steps.ts): a part's guide-entry index, "rest" for the blocks no part
  // claims, absent for the whole file. partTitle is the part's title ("" otherwise).
  part?: Step["part"];
  partTitle: string;
  orientation: string; // guide markdown ("" for unlisted files and orientation-less skims)
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
  done: number; // rows (steps) no longer pending
  total: number;
};

// Run-length grouping: categories and steps in guide order, with a new section started each
// time the category changes from the previous *shown* row — so a category the agent lists
// non-contiguously yields separate sections instead of folding back up, and these surfaces
// mirror the guided step order (stepPlan) exactly. A split file gives a row per part, each under
// its own entry's category. Guide entries absent from the diff are skipped; diff files absent
// from the guide, and each split file's Rest, land in a trailing "Other" group — so these
// surfaces always cover everything the progress strip counts and the two can never disagree.
// `changesOf` supplies a path's change blocks (with their server-stamped `part`/`skim`); `stateOf`
// gives each row its step's review state, so a part is approved on its own sign-off.
export function walkthroughGroups(
  guideFiles: GuideFile[],
  files: FileLike[],
  stateOf: (slot: StepSlot) => FileReviewState,
  fullySkimmed: (path: string) => boolean = () => false,
  changesOf: (path: string) => ChangeState[] = () => [],
): WalkGroup[] {
  const stats = lineStats(files);
  const mkFile = (slot: StepSlot): WalkFile => {
    const { step, path, entry: g, blocks } = slot;
    const name = path.split("/").pop() || path;
    let s = stats.get(path) ?? { added: 0, removed: 0 };
    if (blocks) {
      s = { added: 0, removed: 0 };
      for (const b of blocks) {
        const bs = blockLineStat(b);
        s.added += bs.added;
        s.removed += bs.removed;
      }
    }
    const fl = files[step.fileIndex];
    const moved = fl?.oldPath && fl?.newPath && fl.oldPath !== fl.newPath ? fl.oldPath : "";
    return {
      path,
      dir: path.slice(0, path.length - name.length),
      name,
      fileIndex: step.fileIndex,
      part: step.part,
      partTitle: g?.part?.title ?? "",
      orientation: g?.orientation ?? "",
      flag: g?.flag ?? "",
      skim: !!g?.skim,
      movedFrom: moved,
      added: s.added,
      removed: s.removed,
      state: stateOf(slot),
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
  const plan = stepPlan(guideFiles, files, changesOf);
  // Fully-skimmed steps leave their normal group (guide category or Other) and gather in one
  // trailing collapsed "Skimmed" group (issue 07) — per step, so an all-skimmed part goes while
  // its file's other parts stay. Collected here, appended last.
  const skimmed = mkGroup("Skimmed", false, true);
  // Track only the current group: a skipped entry (not in the diff) leaves no visible gap, so
  // it must not split a run — hence the category compare happens against the last *shown* row.
  let cur: WalkGroup | null = null;
  for (const slot of plan.listed) {
    if (slotOutOfFlow(slot, fullySkimmed)) {
      add(skimmed, mkFile(slot));
      continue;
    }
    // A skimmed row must not carry the run forward — compare/open the category off shown,
    // in-flow rows only, so a skimmed file between two same-category files can't split them.
    // Every listed slot carries its guide entry.
    const category = slot.entry!.category;
    if (!cur || cur.category !== category) {
      cur = mkGroup(category, false);
      groups.push(cur);
    }
    add(cur, mkFile(slot));
  }
  const other = mkGroup("Other", true);
  for (const slot of plan.other)
    add(slotOutOfFlow(slot, fullySkimmed) ? skimmed : other, mkFile(slot));
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
      // "N files", or "N steps" once a row is a part or a Rest step: the noun names what it counts.
      count: string;
      done: number;
      added: number;
      removed: number;
      complete: boolean;
      jump: Step; // the step a header click opens (first pending in the group, else its first)
    }
  | (WalkFile & { kind: "file"; key: string; cls: string });

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
    const noun = g.files.every((f) => f.part === undefined) ? "file" : "step";
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
      count: `${g.total} ${noun}${g.total === 1 ? "" : "s"}`,
      done: g.done,
      added: g.added,
      removed: g.removed,
      complete: g.done === g.total,
      jump: { fileIndex: target.fileIndex, part: target.part },
    });
    // A collapsed Skimmed group hides its file rows until expanded; every other group is
    // always open.
    if (g.skimmed && !skimGroupExpanded) return;
    for (const f of g.files)
      rows.push({
        ...f,
        kind: "file",
        key: walkKey(f.path, f.part),
        cls: f.path === activePath ? "active" : "",
      });
  });
  return rows;
}

// A Walkthrough row's key, one per step: `file:<path>` for a whole file, `part:<entry>:<path>`
// for a part, `rest:<path>` for a split file's Rest. applyActiveRow (tree.ts) finds rows by it.
export function walkKey(path: string, part: Step["part"]): string {
  return part === undefined
    ? `file:${path}`
    : part === "rest"
      ? `rest:${path}`
      : `part:${part}:${path}`;
}
