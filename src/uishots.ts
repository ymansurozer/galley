import { promises as fs } from "node:fs";
import path from "node:path";

// An annotation's screenshots on disk: a crop and a viewport PNG per annotation, in ui-shots/ under
// the review's session directory. Never inside the state: images would ride every save, poll and
// state fetch. The tab uploads them once the bridge has rendered them (POST /api/ui-shot), the
// desk serves them back for its enlarged view (GET /api/ui-shot), and the Send hands the agent
// their absolute paths.

export const SHOT_KINDS = ["crop", "viewport"] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

// Per image. A 1440 × 900 page at 2× encodes to a few MB at most, so only junk reaches this.
export const SHOT_CAP = 8 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const isPng = (bytes: Buffer) => bytes.subarray(0, 8).equals(PNG_SIGNATURE);

export const shotDir = (sessionDir: string) => path.join(sessionDir, "ui-shots");

export const shotFile = (dir: string, id: string, kind: ShotKind) =>
  path.join(dir, `${id}-${kind}.png`);

// The annotation id and kind a request names. The id is the same word-character id the save
// accepts, so a file name built from it stays inside the directory. Null for anything else.
export function readShotName(id: unknown, kind: unknown): { id: string; kind: ShotKind } | null {
  if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) return null;
  const k = SHOT_KINDS.find((s) => s === kind);
  return k ? { id, kind: k } : null;
}

// Delete every file in the directory that isn't a screenshot of an annotation in `keep`: those of
// annotations a save dropped, and leftovers such as an interrupted write's temp file.
export async function pruneShots(dir: string, keep: ReadonlySet<string>) {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const orphan = (name: string) => {
    const m = /^([\w-]+)-(?:crop|viewport)\.png$/.exec(name);
    return !m || !keep.has(m[1]!);
  };
  await Promise.all(
    names.filter(orphan).map((name) => fs.rm(path.join(dir, name), { force: true })),
  );
}
