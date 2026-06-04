import { S } from "./store";

// Loaded from the CDN at runtime; the esbuild build keeps this import external.
export async function loadDiffLib() {
  const mod: any = await import("https://esm.sh/@pierre/diffs@1.2.4");
  S.FileDiff = mod.FileDiff;
  S.parseDiffFromFile = mod.parseDiffFromFile;
  S.diffAcceptRejectHunk = mod.diffAcceptRejectHunk;
}
