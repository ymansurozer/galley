import type { Guide, GuideFile } from "./types.js";

export type GuideValidation = { ok: true; guide: Guide } | { ok: false; reason: string };

type PartLines = NonNullable<GuideFile["part"]>["lines"];

// A part's `lines`: a non-empty array of single line numbers and [start, end] pairs, a reversed
// pair ordered ascending (as skimBlocks spans are). null when the shape is wrong.
function partLines(raw: unknown): PartLines | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: PartLines = [];
  for (const span of raw) {
    if (typeof span === "number" && Number.isFinite(span)) lines.push(span);
    else if (
      Array.isArray(span) &&
      span.length === 2 &&
      span.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      const [a, b] = span as [number, number];
      lines.push(a <= b ? [a, b] : [b, a]);
    } else return null;
  }
  return lines;
}

// Validate + normalize an agent-supplied guide. Required: a non-empty `overview` and a
// non-empty `files` array whose every entry has a `path` and (unless `skim: true`) an
// `orientation`. `order` and `category` are optional (default to the entry's position /
// "Changes"); `flag` is an optional note whose presence raises the file's flag. Returns the
// normalized guide with files sorted by `order`, or a reason the input was rejected. Pure —
// no IO — so it's the same check on the server and CLI.
export function validateGuide(input: unknown): GuideValidation {
  if (!input || typeof input !== "object") return { ok: false, reason: "guide must be an object" };
  const g = input as Record<string, unknown>;
  if (typeof g.overview !== "string" || !g.overview.trim())
    return { ok: false, reason: "guide.overview must be a non-empty string" };
  if (!Array.isArray(g.files)) return { ok: false, reason: "guide.files must be an array" };
  if (g.files.length === 0) return { ok: false, reason: "guide.files must not be empty" };
  const files: GuideFile[] = [];
  for (let i = 0; i < g.files.length; i++) {
    const raw = g.files[i];
    if (!raw || typeof raw !== "object")
      return { ok: false, reason: `guide.files[${i}] must be an object` };
    const f = raw as Record<string, unknown>;
    if (typeof f.path !== "string" || !f.path.trim())
      return { ok: false, reason: `guide.files[${i}].path must be a non-empty string` };
    // A whole-file skim leaves the review flow, so the reviewer never reads its orientation —
    // optional there (skimReason says why). Partial skims (skimBlocks) stay in the flow and
    // keep it required. Present or not, an orientation is never blank.
    if (
      (f.orientation !== undefined || f.skim !== true) &&
      (typeof f.orientation !== "string" || !f.orientation.trim())
    )
      return { ok: false, reason: `guide.files[${i}].orientation must be a non-empty string` };
    const file: GuideFile = {
      path: f.path,
      order: typeof f.order === "number" && Number.isFinite(f.order) ? f.order : i,
      category: typeof f.category === "string" && f.category.trim() ? f.category : "Changes",
    };
    if (typeof f.orientation === "string") file.orientation = f.orientation;
    if (typeof f.flag === "string" && f.flag.trim()) file.flag = f.flag;
    // Skim fields (focused review). File-level `skim`/`skimReason` collapse the whole file;
    // `skimBlocks` are new-side line spans. This is SHAPE validation only — whether a span
    // actually resolves to a change block is diff-aware and checked later (resolveSkim in
    // state.ts), because validateGuide is pure (no diff in hand).
    if (f.skim === true) file.skim = true;
    if (typeof f.skimReason === "string" && f.skimReason.trim()) file.skimReason = f.skimReason;
    if (f.skimBlocks !== undefined) {
      if (!Array.isArray(f.skimBlocks))
        return { ok: false, reason: `guide.files[${i}].skimBlocks must be an array` };
      const blocks: NonNullable<GuideFile["skimBlocks"]> = [];
      for (let j = 0; j < f.skimBlocks.length; j++) {
        const rawBlock = f.skimBlocks[j] as Record<string, unknown> | null | undefined;
        if (!rawBlock || typeof rawBlock !== "object")
          return { ok: false, reason: `guide.files[${i}].skimBlocks[${j}] must be an object` };
        // `lines` is a [start, end] span or a bare number (a single line, normalized to [n, n]).
        const raw = rawBlock.lines;
        let span: [number, number] | null = null;
        if (typeof raw === "number" && Number.isFinite(raw)) span = [raw, raw];
        else if (
          Array.isArray(raw) &&
          raw.length === 2 &&
          typeof raw[0] === "number" &&
          typeof raw[1] === "number" &&
          Number.isFinite(raw[0]) &&
          Number.isFinite(raw[1])
        )
          span = raw[0] <= raw[1] ? [raw[0], raw[1]] : [raw[1], raw[0]];
        if (!span)
          return {
            ok: false,
            reason: `guide.files[${i}].skimBlocks[${j}].lines must be a line number or a [start, end] pair`,
          };
        const block: { lines: [number, number]; reason?: string } = { lines: span };
        if (typeof rawBlock.reason === "string" && rawBlock.reason.trim())
          block.reason = rawBlock.reason;
        blocks.push(block);
      }
      if (blocks.length) file.skimBlocks = blocks;
    }
    // Guide-declared move (issue 03): `movedFrom` is the OLD path a moved+edited file came from.
    // Shape-only here (non-empty string) — whether it resolves to a full deletion + untracked
    // addition is diff-aware (resolveMovedFrom in state.ts). Rejecting movedFrom+skimBlocks on one
    // entry is a real check, not shape: the merge collapses the pair into one section with no
    // rawDiff, so a skimBlocks span (which resolves against rawDiff) could never match. Whole-file
    // `skim` stays allowed (a client-side flag needing no resolution).
    if (f.movedFrom !== undefined) {
      if (typeof f.movedFrom !== "string" || !f.movedFrom.trim())
        return { ok: false, reason: `guide.files[${i}].movedFrom must be a non-empty string` };
      if (file.skimBlocks?.length)
        return {
          ok: false,
          reason: `guide.files[${i}] cannot set both movedFrom and skimBlocks`,
        };
      file.movedFrom = f.movedFrom;
    }
    // Guide parts: shape only here — whether each span claims a change block, and whether two
    // parts claim the same one, is diff-aware (resolveParts in state.ts). A part narrows the
    // entry to some of the file's blocks, so it can't sit with a whole-file skim, nor with
    // movedFrom (a merged move has no rawDiff section for the spans to resolve against).
    if (f.part !== undefined) {
      const part = f.part as Record<string, unknown> | null;
      if (!part || typeof part !== "object" || Array.isArray(part))
        return {
          ok: false,
          reason: `guide.files[${i}].part must be an object with a title and lines`,
        };
      if (typeof part.title !== "string" || !part.title.trim())
        return { ok: false, reason: `guide.files[${i}].part.title must be a non-empty string` };
      const lines = partLines(part.lines);
      if (!lines)
        return {
          ok: false,
          reason: `guide.files[${i}].part.lines must be a non-empty array of line numbers and [start, end] pairs`,
        };
      for (const field of ["skim", "movedFrom"] as const)
        if (file[field] !== undefined)
          return { ok: false, reason: `guide.files[${i}] cannot set both part and ${field}` };
      file.part = { title: part.title, lines };
    }
    files.push(file);
  }
  // A path listed more than once is a split file, and a split file is split all the way: an entry
  // without a part would claim the whole file a second time, and two steps for one path would
  // collide in the walkthrough and navigation.
  const partless = new Map<string, number>();
  const seen = new Set<string>();
  for (const [i, file] of files.entries()) {
    if (!file.part && !partless.has(file.path)) partless.set(file.path, i);
    if (seen.has(file.path) && partless.has(file.path))
      return {
        ok: false,
        reason: `guide lists "${file.path}" more than once, so every entry for it needs a part (guide.files[${partless.get(file.path)}] has none)`,
      };
    seen.add(file.path);
  }
  files.sort((a, b) => a.order - b.order);
  const guide: Guide = { overview: g.overview, files };
  // Focused-review flag (issue 04) — display-only, badges the overview. A boolean or absent;
  // any other type is a schema violation (consistent with the field-shape checks above).
  if (g.focused !== undefined) {
    if (typeof g.focused !== "boolean")
      return { ok: false, reason: "guide.focused must be a boolean" };
    guide.focused = g.focused;
  }
  if (typeof g.title === "string" && g.title.trim()) guide.title = g.title;
  if (typeof g.prDescription === "string" && g.prDescription.trim())
    guide.prDescription = g.prDescription;
  if (typeof g.baseDiffHash === "string" && g.baseDiffHash) guide.baseDiffHash = g.baseDiffHash;
  return { ok: true, guide };
}
