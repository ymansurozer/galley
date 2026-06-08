import type { Guide, GuideFile } from "./types.js";

export type GuideValidation = { ok: true; guide: Guide } | { ok: false; reason: string };

// Validate + normalize an agent-supplied guide. Required: a non-empty `overview` and a
// non-empty `files` array whose every entry has a `path` and a `summary`. `order` and
// `category` are optional (default to the entry's position / "Changes"); `critical`/`why`
// are optional flags. Returns the normalized guide with files sorted by `order`, or a
// reason the input was rejected. Pure — no IO — so it's the same check on the server and CLI.
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
    if (typeof f.summary !== "string" || !f.summary.trim())
      return { ok: false, reason: `guide.files[${i}].summary must be a non-empty string` };
    const file: GuideFile = {
      path: f.path,
      order: typeof f.order === "number" && Number.isFinite(f.order) ? f.order : i,
      category: typeof f.category === "string" && f.category.trim() ? f.category : "Changes",
      summary: f.summary,
    };
    if (f.critical === true) file.critical = true;
    if (typeof f.why === "string" && f.why.trim()) file.why = f.why;
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
