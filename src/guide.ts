import type { Guide, GuideFile } from "./types.js";

export type GuideValidation = { ok: true; guide: Guide } | { ok: false; reason: string };

// Validate + normalize an agent-supplied guide. Required: a non-empty `overview` and a
// non-empty `files` array whose every entry has a `path` and an `orientation`. `order` and
// `category` are optional (default to the entry's position / "Changes"); `flag` is an
// optional note whose presence raises the file's flag. Returns the normalized guide with
// files sorted by `order`, or a reason the input was rejected. Pure — no IO — so it's the
// same check on the server and CLI.
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
    if (typeof f.orientation !== "string" || !f.orientation.trim())
      return { ok: false, reason: `guide.files[${i}].orientation must be a non-empty string` };
    const file: GuideFile = {
      path: f.path,
      order: typeof f.order === "number" && Number.isFinite(f.order) ? f.order : i,
      category: typeof f.category === "string" && f.category.trim() ? f.category : "Changes",
      orientation: f.orientation,
    };
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
    files.push(file);
  }
  files.sort((a, b) => a.order - b.order);
  const guide: Guide = { overview: g.overview, files };
  if (typeof g.title === "string" && g.title.trim()) guide.title = g.title;
  if (typeof g.prDescription === "string" && g.prDescription.trim())
    guide.prDescription = g.prDescription;
  if (typeof g.baseDiffHash === "string" && g.baseDiffHash) guide.baseDiffHash = g.baseDiffHash;
  return { ok: true, guide };
}
