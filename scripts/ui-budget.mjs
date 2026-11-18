// dist/ui.js's size limit, in bytes: the build's gate (build-ui.mjs) and the perf gate
// (perf-smoke.mjs) both read it here, so the two can't drift apart. Side-effect free, so importing
// it runs nothing.
//
// dist/ui.js is a single un-split bundle served to the tab. The limit keeps an accidental fat
// dependency (e.g. shiki's full bundle — see build-ui.mjs's shiki-shim plugin) from silently
// ballooning it back. The floor is the curated grammars themselves (~2 MB of @shikijs/langs,
// bundled once — cpp alone is ~650 KB); the total sits near 3 MB. The limit still catches a
// re-introduced fat barrel (that regression is +9 MB) or the oniguruma wasm (+600 KB). Reaching
// "hundreds of KB" would require lazy-loading grammar chunks (a code-split + a server route to
// serve them) — out of scope here.
// 3.2 → 3.3 MB when light mode added six curated light themes (~170 KB of theme JSON).
// 3.3 → 3.35 MB when the desk redesign met guide parts (#97): the redesign's surfaces plus #97's
// step UI (steps, folds, replay) pushed ui.js just past 3.3 MB. The limit stays a tripwire for
// accidental bloat, not a budget to fill.
// 3.35 → 3.4 MB when Decisions mode's Overview map (its layout and drawing) met coverage and
// settling across rounds: real feature code took ui.js just past 3.35 MB.
export const UI_BUNDLE_LIMIT = 3_400_000;
