// Pure fully-skimmed derivation (store-free, so it's unit-testable). A file is *fully skimmed* —
// it rides along on the agent's skim and needs no eyes — when the guide flags the whole file
// (file-level skim) OR it has change blocks and every one is skim-stamped. A file with any
// unskimmed block stays a normal file. Callers derive this per-render off current state, so a
// reload that drops a block's stamp (rewritten code → new change id → no carried skim) flips
// this back to false and the file rejoins the main review flow, progress, and navigation.
export function isFullySkimmed(fileSkim: boolean, blockSkims: boolean[]): boolean {
  return fileSkim || (blockSkims.length > 0 && blockSkims.every(Boolean));
}
