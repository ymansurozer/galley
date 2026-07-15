import { S, $, esc } from "./store";
import { currentFile, fileFinished, fileObjections, fileReviewState } from "./changes";
import { approveCurrentFile, resetReview, rejectFile } from "./decisions";
import { deferRender } from "./render";
import { currentGuideEntry } from "./guide";
import { isFileSkim, fileSkimReason, movedFrom } from "./skim";
import type { ReviewState } from "./types";

type ReviewFile = ReviewState["files"][number];

// ── Oversized-file placeholder card (issue 05) ───────────────────────────────
// A file whose diff would freeze the tab (server-stamped `oversized`, see state.ts) renders as a
// verdict-capable summary card INSTEAD of fetching + rendering its diff — so opening it never
// blocks on a multi-MB tokenization pass. The card carries the file's stats, its guide badges, the
// same whole-file verdict controls a rendered file has, and a "Load diff anyway" escape hatch. Once
// loaded, the file behaves like any rendered file for the rest of the session (S.loadedOversized).

// Whether `f` (default: the current file) should paint the placeholder card right now: it's stamped
// oversized and the reviewer hasn't chosen to load its real diff this session.
export function isOversizedPlaceholder(f: ReviewFile = currentFile()): boolean {
  return !!f?.oversized && !S.loadedOversized.has(f.path);
}

// "Load diff anyway": remember the choice and re-render. render() now falls through the placeholder
// branch to the normal diff path, which fetches contents via the existing per-file endpoint and
// shows the large-file "Rendering…" indicator (deferRender(true) forces it for any big file).
export function loadOversizedDiff() {
  const f = currentFile();
  if (!f) return;
  S.loadedOversized.add(f.path);
  deferRender(true);
}

// Human-readable byte size (the card's focal stat — the file is large). Binary units, one decimal
// past KB so a 1.4 MB file doesn't round to "1 MB".
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Change-kind → the accent color language the diff header uses (ctColor in render.ts).
function kindClass(kind: ReviewFile["changeKind"]): string {
  switch (kind) {
    case "added":
      return "new";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

// The whole-file verdict controls — identical semantics to a rendered file's header:
// finished → a state pill + Reset; otherwise Reject file (when there are blocks to reject) +
// Approve / Mark Reviewed.
function verdictControls(path: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ovsz-verdict";
  if (fileFinished(path)) {
    const state = fileReviewState(path);
    const pill = document.createElement("span");
    pill.className = "ovsz-pill " + (state === "approved" ? "ok" : "warn");
    pill.textContent = state === "approved" ? "Approved" : "Changes requested";
    wrap.appendChild(pill);
    const reset = document.createElement("button");
    reset.className = "ovsz-btn ghost";
    reset.textContent = "Reset";
    reset.onclick = () => resetReview(path);
    wrap.appendChild(reset);
    return wrap;
  }
  // Reject file only makes sense when the file actually has change blocks (a hunk-less added file
  // has none — nothing to reject block-by-block).
  const hasBlocks = S.state.changes.some((c) => c.path === path);
  if (hasBlocks) {
    const reject = document.createElement("button");
    reject.className = "ovsz-btn danger";
    reject.textContent = "Reject file";
    reject.onclick = () => rejectFile(path);
    wrap.appendChild(reject);
  }
  const objections = fileObjections(path);
  const approve = document.createElement("button");
  approve.className = "ovsz-btn primary" + (objections ? " warn" : "");
  approve.innerHTML = `${objections ? "Mark Reviewed" : "Approve"} <kbd>⇧A</kbd>`;
  approve.onclick = () => approveCurrentFile();
  wrap.appendChild(approve);
  return wrap;
}

// Render the summary card into #diff. Called from renderCenter in place of the diff, BEFORE any
// contents fetch — so an oversized file costs nothing to open.
export function renderOversizedCard() {
  const file = currentFile();
  const path = file.path;
  const entry = currentGuideEntry();
  const from = movedFrom(path);

  const card = document.createElement("div");
  card.className = "oversized-card ct-" + kindClass(file.changeKind);

  // Row 1: change-type icon + path (+ rename arrow) + a kind badge.
  const head = document.createElement("div");
  head.className = "ovsz-head";
  head.innerHTML = `<svg class="ovsz-icon ic"><use href="#gly-file"></use></svg>`;
  const name = document.createElement("span");
  name.className = "ovsz-path";
  name.textContent = path;
  head.appendChild(name);
  if (from) {
    const moved = document.createElement("span");
    moved.className = "ovsz-moved";
    moved.innerHTML = `<svg class="ic"><use href="#gly-arrow-right"></use></svg><span>from ${esc(from)}</span>`;
    head.appendChild(moved);
  }
  const kind = document.createElement("span");
  kind.className = "ovsz-kind";
  kind.textContent = file.changeKind ?? "modified";
  head.appendChild(kind);
  card.appendChild(head);

  // Guide badges the file would normally show: category chip, skim note, flag callout.
  if (entry || isFileSkim(path)) {
    const badges = document.createElement("div");
    badges.className = "ovsz-badges";
    if (entry) {
      const cat = document.createElement("span");
      cat.className = "ovsz-cat" + (entry.flag ? " crit" : "");
      cat.textContent = entry.category;
      badges.appendChild(cat);
    }
    if (isFileSkim(path)) {
      const skim = document.createElement("span");
      skim.className = "ovsz-skim";
      const reason = fileSkimReason(path);
      skim.innerHTML = `<svg class="ic"><use href="#gly-collapse-all"></use></svg><span>${reason ? `skimmed · ${esc(reason)}` : "skimmed"}</span>`;
      badges.appendChild(skim);
    }
    card.appendChild(badges);
  }

  // Stats: byte size is the focal number (why this is a card), with the churn counts beside it.
  const stats = document.createElement("div");
  stats.className = "ovsz-stats";
  if (typeof file.size === "number") {
    const size = document.createElement("span");
    size.className = "ovsz-size";
    size.textContent = formatBytes(file.size);
    stats.appendChild(size);
  }
  const counts = document.createElement("span");
  counts.className = "ovsz-counts";
  counts.innerHTML = `<span class="a">+${file.added ?? 0}</span><span class="d">−${file.removed ?? 0}</span>`;
  stats.appendChild(counts);
  card.appendChild(stats);

  const note = document.createElement("p");
  note.className = "ovsz-note";
  note.textContent = "This file is large. Its diff is hidden to keep the desk responsive.";
  card.appendChild(note);

  // The flag reads as a callout below the note (same amber-box idiom as the guide header's flag).
  if (entry?.flag) {
    const flag = document.createElement("div");
    flag.className = "ovsz-flag";
    flag.innerHTML = `<svg class="ic"><use href="#gly-flag"></use></svg><div>${esc(entry.flag)}</div>`;
    card.appendChild(flag);
  }

  // Actions: whole-file verdict controls + Load diff anyway.
  const actions = document.createElement("div");
  actions.className = "ovsz-actions";
  actions.appendChild(verdictControls(path));
  const load = document.createElement("button");
  load.className = "ovsz-load";
  load.innerHTML = `Load diff anyway <kbd>↵</kbd>`;
  load.onclick = () => loadOversizedDiff();
  actions.appendChild(load);
  card.appendChild(actions);

  $("diff").replaceChildren(card);
}
