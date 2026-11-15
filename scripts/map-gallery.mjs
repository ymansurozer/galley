import * as esbuild from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The map gallery: every shape of src/ui/map-corpus.ts drawn by the Overview's real layout and
// renderer, dark and light side by side, each pane marked pass or fail. Written to
// .desk/map-gallery/ (git-ignored, never shipped); serve that folder with any static server:
//   node scripts/map-gallery.mjs && python3 -m http.server 5190 --bind 0.0.0.0 -d .desk/map-gallery
const out = fileURLToPath(new URL("../.desk/map-gallery/", import.meta.url));
mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: { gallery: "src/ui/map-gallery.ts", "gallery-styles": "scripts/map-gallery.css" },
  bundle: true,
  format: "iife",
  target: "es2022",
  outdir: out,
  logLevel: "warning",
});
writeFileSync(
  `${out}index.html`,
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Map gallery · Galley</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="gallery-styles.css">
</head>
<body><script src="gallery.js"></script></body>
</html>
`,
);
console.log(`map gallery → ${out}index.html`);
