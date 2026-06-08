import * as esbuild from "esbuild";

const options = {
  entryPoints: ["src/ui/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/ui.js",
  loader: { ".wasm": "binary" },
  minify: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.error("esbuild: watching src/ui → dist/ui.js");
} else {
  await esbuild.build(options);
}
