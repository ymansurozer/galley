import type { ChangeState, GuideFile } from "../types";

// ── Review steps ─────────────────────────────────────────────────────────────
// Guided navigation moves through steps, not files. A step is a whole file or, when the guide
// splits a file into parts (GuideFile.part), one part of it — or the file's Rest: the change
// blocks no part claims. `part` is the owning entry's index in guide.files (what the server stamps
// on ChangeState.part), "rest", or absent for the whole file. Without a guide, or for an unsplit
// file, a step is exactly a file, so every file-based order maps one-to-one. Pure (no store) like
// seek.ts, so the orders are unit-testable; guide.ts holds the store-reading wrappers.

export type Step = { fileIndex: number; part?: number | "rest" };

// One string per step, for the seek helpers (which compare order entries with ===) and cache keys.
export const stepKey = (s: Step): string =>
  s.part === undefined ? String(s.fileIndex) : `${s.fileIndex}:${s.part}`;

// A step at its walkthrough position: its path, the guide entry behind it (none for an unlisted
// file or a Rest step) and, for a part or Rest step, the change blocks it covers (null = the
// whole file).
export type StepSlot = {
  step: Step;
  path: string;
  entry?: GuideFile;
  blocks: ChangeState[] | null;
};

// Every step of a guided review in walkthrough order. `listed` follows the guide: one slot per
// entry whose file is in the diff — a part entry as its part step, any other as the whole file.
// `other` is the trailing Other group: each file the guide didn't list, whole, and each split
// file's Rest step when it has unclaimed blocks, in file-array order. A part left with no blocks
// (a carried-forward guide whose spans no longer match) has no step; a split file left with no
// step at all is listed whole in Other, so every diff file stays reachable.
export function stepPlan(
  guideFiles: GuideFile[],
  files: ReadonlyArray<{ path: string }>,
  changesOf: (path: string) => ChangeState[],
): { listed: StepSlot[]; other: StepSlot[] } {
  const index = new Map(files.map((f, i) => [f.path, i] as const));
  const listedPaths = new Set<string>();
  // Per split path, the guide indices of its part entries — a block stamped with any other index
  // (a stale stamp from a swapped guide) counts as unclaimed.
  const partsOf = new Map<string, Set<number>>();
  guideFiles.forEach((g, gi) => {
    listedPaths.add(g.path);
    if (!g.part) return;
    let parts = partsOf.get(g.path);
    if (!parts) partsOf.set(g.path, (parts = new Set()));
    parts.add(gi);
  });
  const listed: StepSlot[] = [];
  const stepped = new Set<string>();
  guideFiles.forEach((g, gi) => {
    const fileIndex = index.get(g.path);
    if (fileIndex === undefined) return;
    if (!g.part) {
      listed.push({ step: { fileIndex }, path: g.path, entry: g, blocks: null });
      stepped.add(g.path);
      return;
    }
    const blocks = changesOf(g.path).filter((c) => c.part === gi);
    if (!blocks.length) return;
    listed.push({ step: { fileIndex, part: gi }, path: g.path, entry: g, blocks });
    stepped.add(g.path);
  });
  const other: StepSlot[] = [];
  files.forEach((f, fileIndex) => {
    const parts = partsOf.get(f.path);
    if (parts) {
      const rest = changesOf(f.path).filter((c) => c.part === undefined || !parts.has(c.part));
      if (rest.length)
        other.push({ step: { fileIndex, part: "rest" }, path: f.path, blocks: rest });
      else if (!stepped.has(f.path))
        other.push({ step: { fileIndex }, path: f.path, blocks: null });
    } else if (!listedPaths.has(f.path))
      other.push({ step: { fileIndex }, path: f.path, blocks: null });
  });
  return { listed, other };
}

// A step that has left the review flow: a part or Rest step whose blocks are all skimmed, else a
// whole file the caller classifies (fully skimmed or a pure rename — flow-index's outOfFlow). Per
// step, so a fully skimmed part leaves the flow even while the rest of its file stays in it.
export function slotOutOfFlow(slot: StepSlot, fileOutOfFlow: (path: string) => boolean): boolean {
  return slot.blocks ? slot.blocks.every((c) => !!c.skim) : fileOutOfFlow(slot.path);
}

// The order the wrap and approve-advance seeks walk: every step in walkthrough order (the guide's,
// then Other) that `keep` admits — in-flow ones for the seeks, all of them for the change-request
// walk.
export function planSteps(
  plan: { listed: StepSlot[]; other: StepSlot[] },
  keep: (slot: StepSlot) => boolean,
): Step[] {
  return [...plan.listed, ...plan.other].filter(keep).map((s) => s.step);
}

// The guide entry a step shows in the diff header: a part step's own entry, an unsplit file's
// entry, and none for a Rest step or the whole-file view of a split file — no single part's
// orientation speaks for those.
export function stepEntry(
  guideFiles: GuideFile[],
  path: string,
  part: Step["part"],
): GuideFile | null {
  if (part === "rest") return null;
  if (typeof part === "number") {
    const g = guideFiles[part];
    return g?.path === path ? g : null;
  }
  const g = guideFiles.find((x) => x.path === path);
  return g && !g.part ? g : null;
}

// Where `cur` sits in guided stepping and seeking, and which band it walks (out of the flow or
// in it). A part, a Rest step or an unsplit file is its own position and band. A split file opened
// whole (from the Files tree) sits at its first step in walkthrough order but walks the in-flow
// band unless every one of its steps left the flow — so a fully skimmed first part doesn't
// strand it in the Skimmed band.
export function anchorStep(
  slots: StepSlot[],
  cur: Step,
  outOfFlow: (s: Step) => boolean,
): { at: Step; band: boolean } {
  const own = cur.part === undefined ? slots.filter((s) => s.step.fileIndex === cur.fileIndex) : [];
  if (!own.length) return { at: cur, band: outOfFlow(cur) };
  return { at: own[0]!.step, band: own.every((s) => outOfFlow(s.step)) };
}

// Plain next (dir 1) / prev (dir -1) in a guided review: one order — the walkthrough's, guide
// steps then the Other group's (unlisted files and Rest steps) — so the two are exact inverses,
// passing over steps in the other band. null off either end; the caller wraps or opens the
// Overview.
export function neighborStep(
  plan: { listed: StepSlot[]; other: StepSlot[] },
  cur: Step,
  dir: 1 | -1,
  outOfFlow: (s: Step) => boolean,
): Step | null {
  const slots = [...plan.listed, ...plan.other];
  const { at, band } = anchorStep(slots, cur, outOfFlow);
  return adjacentStep(
    slots.map((s) => s.step),
    at,
    dir,
    (s) => outOfFlow(s) !== band,
  );
}

// The step before (dir -1) or after (dir 1) `cur` in `order`, passing over steps `skip` rejects.
// null off either end — the caller wraps. With `cur` absent from the order, next scans from the
// top and prev finds nothing.
export function adjacentStep(
  order: Step[],
  cur: Step,
  dir: 1 | -1,
  skip: (s: Step) => boolean,
): Step | null {
  const key = stepKey(cur);
  for (
    let p = order.findIndex((s) => stepKey(s) === key) + dir;
    p >= 0 && p < order.length;
    p += dir
  )
    if (!skip(order[p]!)) return order[p]!;
  return null;
}

// The step to stay on after a reload or a guide swap moved the guide indices under it: the same
// part re-found by path + title while it still has blocks, Rest while the file still has
// unclaimed blocks, else the file whole. `fileIndex` is the file's index in the new state.
export function carryStep(
  plan: { listed: StepSlot[]; other: StepSlot[] },
  fileIndex: number,
  part: Step["part"],
  title: string | undefined,
): Step {
  if (part === undefined) return { fileIndex };
  const slot =
    part === "rest"
      ? plan.other.find((s) => s.step.fileIndex === fileIndex && s.step.part === "rest")
      : plan.listed.find(
          (s) => s.step.fileIndex === fileIndex && s.entry?.part && s.entry.part.title === title,
        );
  return slot?.step ?? { fileIndex };
}
