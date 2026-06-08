import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  lineDiffType: "word-alt",
  diffIndicators: "bars",
  hunkSeparators: "line-info",
  overflow: "wrap",
  lineHighlight: "full",
  // Diff defaults to Pierre Dark (a @pierre/diffs theme). Pierre isn't a Shiki bundled
  // theme, so comment/markdown code blocks fall back to github-dark (see markdown.ts).
  theme: "pierre-dark",
  font: "jetbrains-mono",
  uiFont: "geist",
  fontSize: 12.5,
  showUnchanged: true,
  unchangedLines: "collapse",
  progressBy: "lines",
  stageOnAccept: false,
};

type FontDef = { label: string; stack: string; google: string | null };

// Curated mono fonts for code — the diff and comment/markdown code (loaded from Google Fonts
// on selection, like JetBrains Mono today).
export const FONTS: Record<string, FontDef> = {
  "jetbrains-mono": { label: "JetBrains Mono", stack: "'JetBrains Mono'", google: "JetBrains+Mono:wght@400;500;600;700" },
  "geist-mono": { label: "Geist Mono", stack: "'Geist Mono'", google: "Geist+Mono:wght@400;500;600" },
  "fira-code": { label: "Fira Code", stack: "'Fira Code'", google: "Fira+Code:wght@400;500;600;700" },
  "ibm-plex-mono": { label: "IBM Plex Mono", stack: "'IBM Plex Mono'", google: "IBM+Plex+Mono:wght@400;500;600;700" },
  "source-code-pro": { label: "Source Code Pro", stack: "'Source Code Pro'", google: "Source+Code+Pro:wght@400;500;600;700" },
  "roboto-mono": { label: "Roboto Mono", stack: "'Roboto Mono'", google: "Roboto+Mono:wght@400;500;600;700" },
};

// Curated sans fonts for the UI chrome (everything that isn't code). "system" loads nothing.
export const SANS_FONTS: Record<string, FontDef> = {
  "inter": { label: "Inter", stack: "'Inter'", google: "Inter:wght@400;500;600;700" },
  "geist": { label: "Geist", stack: "'Geist'", google: "Geist:wght@400;500;600;700" },
  "ibm-plex-sans": { label: "IBM Plex Sans", stack: "'IBM Plex Sans'", google: "IBM+Plex+Sans:wght@400;500;600;700" },
  "system": { label: "System", stack: "system-ui, -apple-system, 'Segoe UI', Roboto", google: null },
};

export function loadSettings(): Settings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("galley.settings") || "{}") }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

export function persistSettings(s: Settings) {
  try { localStorage.setItem("galley.settings", JSON.stringify(s)); } catch { /* ignore quota */ }
}

function ensureFont(key: string, google: string | null) {
  if (!google || document.getElementById(`font-${key}`)) return;
  const link = document.createElement("link");
  link.id = `font-${key}`;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${google}&display=swap`;
  document.head.appendChild(link);
}

// @pierre/diffs colors rows via CSS custom props with `…-override` hooks; these inherit
// into its shadow DOM and resolve at the use-site (where --diffs-*-base is defined), so we
// can dim the whole-row tint while keeping the word-level emphasis — theme-aware.
// @pierre registers these via @property (<color>), so the override must be a concrete
// color at :root — a value referencing @pierre's own --diffs-*-base (only defined inside
// its shadow) is invalid there and reverts. Fixed diff green/red read fine on all themes.
const DIFF_VARS = ["--diffs-bg-addition-override", "--diffs-bg-deletion-override", "--diffs-bg-addition-emphasis-override", "--diffs-bg-deletion-emphasis-override"];
const ADD = "56,160,90", DEL = "229,83,75";
function applyLineHighlight(level: Settings["lineHighlight"]) {
  const root = document.documentElement.style;
  if (level === "full") { for (const v of DIFF_VARS) root.removeProperty(v); return; }
  // The row bg is color-mix(~80% page-bg, 20% of this target), so a low-alpha target reads as
  // fully gone. ~0.5 lands Subtle clearly between Full and Off; Off = transparent (flat).
  const rowA = level === "off" ? 0 : 0.5;
  root.setProperty("--diffs-bg-addition-override", rowA ? `rgba(${ADD},${rowA})` : "transparent");
  root.setProperty("--diffs-bg-deletion-override", rowA ? `rgba(${DEL},${rowA})` : "transparent");
  // keep the changed words prominent once the row is quiet
  root.setProperty("--diffs-bg-addition-emphasis-override", `rgba(${ADD},0.34)`);
  root.setProperty("--diffs-bg-deletion-emphasis-override", `rgba(${DEL},0.34)`);
}

// Fonts + size are ours (CSS vars). Two families: --mono (code) and --sans (UI chrome). We also
// drive @pierre/diffs' own --diffs-font-* vars from the code font/size so the diff matches the
// Code font setting (the lib has no font option, but reads these custom props in its shadow DOM).
export function applyAppearance(s: Settings) {
  const f = FONTS[s.font] ?? FONTS["jetbrains-mono"]!;
  const sf = SANS_FONTS[s.uiFont] ?? SANS_FONTS["geist"]!;
  ensureFont(s.font, f.google);
  ensureFont(s.uiFont, sf.google);
  const monoStack = `${f.stack}, ui-monospace, monospace`;
  const root = document.documentElement.style;
  root.setProperty("--mono", monoStack);
  root.setProperty("--sans", `${sf.stack}, system-ui, -apple-system, sans-serif`);
  root.setProperty("--code-size", `${s.fontSize}px`);
  root.setProperty("--diffs-font-family", monoStack);
  root.setProperty("--diffs-font-size", `${s.fontSize}px`);
  applyLineHighlight(s.lineHighlight);
}
