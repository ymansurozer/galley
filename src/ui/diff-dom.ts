import { $ } from "./store";

// @pierre/diffs mounts the rendered diff into a shadow root hung off some descendant of #diff, so
// every read of the rendered rows (overview ruler, line cursor, skim collapse) has to locate that
// shadow first. A `#diff *` walk isn't free on a large diff and three call sites re-ran it every
// render, so the found root is cached across calls and invalidated structurally: it's only reused
// while its host still lives under #diff. A file switch (render's LRU swaps in another cached
// wrapper via replaceChildren) or a remount detaches the old host, so `#diff.contains(host)` flips
// to false and we re-walk — a stale root can never be handed back to the cursor or skim.
let cached: ShadowRoot | null = null;

export function diffShadowRoot(): ShadowRoot | null {
  if (cached && $("diff").contains(cached.host)) return cached;
  let shadow: ShadowRoot | null = null;
  $("diff")
    .querySelectorAll("*")
    .forEach((el) => {
      if ((el as HTMLElement).shadowRoot) shadow = (el as HTMLElement).shadowRoot;
    });
  cached = shadow;
  return shadow;
}
