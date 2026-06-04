import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  lineDiffType: "word-alt",
  diffIndicators: "bars",
  hunkSeparators: "line-info",
  overflow: "scroll",
  lineHighlight: "full",
  theme: "material-theme-palenight",
  font: "jetbrains-mono",
  fontSize: 12.5,
  showUnchanged: true,
  stageOnAccept: true,
};

// Curated mono fonts (loaded from Google Fonts on selection, like JetBrains Mono today).
export const FONTS: Record<string, { label: string; stack: string; google: string }> = {
  "jetbrains-mono": { label: "JetBrains Mono", stack: "'JetBrains Mono'", google: "JetBrains+Mono:wght@400;500;600;700" },
  "geist-mono": { label: "Geist Mono", stack: "'Geist Mono'", google: "Geist+Mono:wght@400;500;600" },
  "fira-code": { label: "Fira Code", stack: "'Fira Code'", google: "Fira+Code:wght@400;500;600;700" },
  "ibm-plex-mono": { label: "IBM Plex Mono", stack: "'IBM Plex Mono'", google: "IBM+Plex+Mono:wght@400;500;600;700" },
  "source-code-pro": { label: "Source Code Pro", stack: "'Source Code Pro'", google: "Source+Code+Pro:wght@400;500;600;700" },
  "roboto-mono": { label: "Roboto Mono", stack: "'Roboto Mono'", google: "Roboto+Mono:wght@400;500;600;700" },
};

export function loadSettings(): Settings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("galley.settings") || "{}") }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

export function persistSettings(s: Settings) {
  try { localStorage.setItem("galley.settings", JSON.stringify(s)); } catch { /* ignore quota */ }
}

function ensureFont(key: string) {
  const f = FONTS[key];
  if (!f || document.getElementById(`font-${key}`)) return;
  const link = document.createElement("link");
  link.id = `font-${key}`;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
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

// Font family + size are ours (CSS vars); @pierre/diffs has no font option.
export function applyAppearance(s: Settings) {
  const f = FONTS[s.font] ?? FONTS["jetbrains-mono"]!;
  ensureFont(s.font);
  document.documentElement.style.setProperty("--mono", `${f.stack}, ui-monospace, monospace`);
  document.documentElement.style.setProperty("--code-size", `${s.fontSize}px`);
  applyLineHighlight(s.lineHighlight);
}
