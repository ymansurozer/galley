import * as esbuild from "esbuild";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// dist/ui.js is a single un-split bundle served to the tab. Gate it so an accidental fat
// dependency (e.g. shiki's full bundle — see the plugin below) can't silently balloon it back.
// The floor is the curated grammars themselves (~2 MB of @shikijs/langs, bundled once — cpp alone
// is ~650 KB); the total sits near 3 MB. This gate still catches a re-introduced fat barrel (that
// regression is +9 MB) or the oniguruma wasm (+600 KB). Reaching "hundreds of KB" would require
// lazy-loading grammar chunks (a code-split + a server route to serve them) — out of scope here.
const SIZE_LIMIT = 3_200_000;

const shimPath = fileURLToPath(new URL("../src/ui/shiki-shim.ts", import.meta.url));
const emptyModule = "export default {}; export {};";

// @pierre/diffs imports shiki v3's full barrel (`from "shiki"`), which statically pulls ~180
// grammars + a 607 KB inlined oniguruma wasm — a second, near-complete shiki alongside the lean
// one markdown.ts builds from shiki/core. Reroute ONLY @pierre/diffs' bare `shiki` specifier to a
// local shim backed by the curated set; Galley's own deep imports (shiki/core, shiki/engine/*,
// shiki/dist/*) are left untouched so they keep resolving to the real v4 package. `shiki/wasm`
// (referenced by @pierre's never-taken oniguruma path) resolves to an empty stub so the wasm
// engine can't be bundled — the shim forces the JS regex engine regardless.
const shikiShimPlugin = {
  name: "shiki-shim",
  setup(build) {
    const fromPierre = (importer) => importer.includes("@pierre/diffs");
    build.onResolve({ filter: /^shiki$/ }, (args) =>
      fromPierre(args.importer) ? { path: shimPath } : undefined,
    );
    build.onResolve({ filter: /^shiki\/wasm$/ }, (args) =>
      fromPierre(args.importer)
        ? { path: "shiki-wasm-stub", namespace: "shiki-wasm-stub" }
        : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "shiki-wasm-stub" }, () => ({ contents: emptyModule }));
  },
};

const options = {
  entryPoints: ["src/ui/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/ui.js",
  loader: { ".wasm": "binary" },
  minify: true,
  logLevel: "info",
  plugins: [shikiShimPlugin],
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.error("esbuild: watching src/ui → dist/ui.js");
} else {
  await esbuild.build(options);
  const bytes = statSync(options.outfile).size;
  const kb = (bytes / 1000).toFixed(0);
  if (bytes > SIZE_LIMIT) {
    console.error(
      `esbuild: ${options.outfile} is ${kb} KB, over the ${SIZE_LIMIT / 1000} KB limit. ` +
        `A fat dependency likely leaked into the bundle (see the shiki-shim plugin).`,
    );
    process.exit(1);
  }
  console.error(`esbuild: ${options.outfile} is ${kb} KB (limit ${SIZE_LIMIT / 1000} KB)`);
}
