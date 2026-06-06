// A small line-icon sprite for the file tree (@pierre's sprite is diff-only — no folder /
// file / comment / check glyphs). Symbols use currentColor so each icon inherits its row's
// color; 16-unit viewBox, injected into the document once so `<use href="#gly-…">` resolves.
const ICONS: Record<string, string> = {
  "gly-chevron": `<path d="M6.5 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  "gly-folder": `<path d="M2 5.25a1 1 0 0 1 1-1h2.8a1 1 0 0 1 .7.3l.9.9H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>`,
  "gly-file": `<path d="M4.5 2.5h4L12 6v7a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13V3a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8.25 2.6V6.1H11.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>`,
  "gly-comment": `<path d="M2.75 4a1 1 0 0 1 1-1h8.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1H6.5L4 12V9.5h-.25a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>`,
  "gly-check": `<path d="M3.25 8.5l3 3 6.5-7.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
  "gly-dot": `<circle cx="8" cy="8" r="2.7" fill="currentColor"/>`,
  "gly-plus": `<path d="M8 3.75v8.5M3.75 8h8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  "gly-minus": `<path d="M3.75 8h8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  "gly-collapse-all": `<path d="M4.5 6.5L8 3l3.5 3.5M4.5 13L8 9.5l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  "gly-expand-all": `<path d="M4.5 3L8 6.5 11.5 3M4.5 9.5L8 13l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
};

export const ICON_SPRITE =
  `<svg data-galley-icons aria-hidden="true" width="0" height="0" style="position:absolute">` +
  Object.entries(ICONS).map(([id, body]) => `<symbol id="${id}" viewBox="0 0 16 16">${body}</symbol>`).join("") +
  `</svg>`;

let injected = false;
export function ensureIcons() {
  if (injected) return;
  const holder = document.createElement("div");
  holder.innerHTML = ICON_SPRITE;
  const svg = holder.firstElementChild;
  if (svg) document.body.appendChild(svg);
  injected = true;
}
