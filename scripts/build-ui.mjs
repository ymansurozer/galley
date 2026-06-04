import * as esbuild from "esbuild";

// Keep CDN imports (e.g. https://esm.sh/@pierre/diffs) as runtime browser
// imports instead of trying to bundle them.
const externalUrls = {
  name: "external-urls",
  setup(build) {
    build.onResolve({ filter: /^https?:\/\// }, (args) => ({ path: args.path, external: true }));
  },
};

const options = {
  entryPoints: ["src/ui/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/ui.js",
  plugins: [externalUrls],
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.error("esbuild: watching src/ui → dist/ui.js");
} else {
  await esbuild.build(options);
}
