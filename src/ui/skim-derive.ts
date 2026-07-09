// Pure fully-skimmed derivation (store-free, so it's unit-testable). A file is *fully skimmed* —
// it rides along on the agent's skim and needs no eyes — when the guide flags the whole file
// (file-level skim) OR it has change blocks and every one is skim-stamped. A file with any
// unskimmed block stays a normal file. Callers derive this per-render off current state, so a
// reload that drops a block's stamp (rewritten code → new change id → no carried skim) flips
// this back to false and the file rejoins the main review flow, progress, and navigation.
export function isFullySkimmed(fileSkim: boolean, blockSkims: boolean[]): boolean {
  return fileSkim || (blockSkims.length > 0 && blockSkims.every(Boolean));
}

// A file classified as a PURE rename: moved (distinct old/new paths) with byte-identical content.
// Classified by CONTENT equality, NOT "zero change blocks". A guide-declared moved+edited merge
// (issue 03) carries no SERVER change blocks — its blocks are derived client-side only when the
// file is opened — so a zero-changes test would misclassify an unopened rename-CHANGED file as
// pure (folding it into the Skimmed group, muting it, zeroing its progress weight) until first
// opened. Old/new content is in state up front, so this classifies correctly before any open.
export function isMovedPure(
  oldPath: string | undefined,
  newPath: string | undefined,
  oldContents: string,
  newContents: string,
): boolean {
  return !!oldPath && !!newPath && oldPath !== newPath && oldContents === newContents;
}
