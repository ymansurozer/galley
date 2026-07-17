// Pure guide-staleness check (store-free, so it's unit-testable — see skim-derive.ts for the
// pattern). A guide is stale when it carries a baseDiffHash that no longer matches the diff now
// loaded (the agent rewrote code and the desk reloaded onto a newer diff). A guide with no
// baseDiffHash predates the field and is never flagged stale. guide.ts's guideStale() is the
// thin store-reading wrapper.
export function isGuideBaseStale(
  baseDiffHash: string,
  guideBaseDiffHash: string | undefined,
): boolean {
  return !!guideBaseDiffHash && guideBaseDiffHash !== baseDiffHash;
}
