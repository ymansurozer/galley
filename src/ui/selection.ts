import { S, $ } from "./store";
import type { Side } from "./types";
import { cursorSyncTo } from "./cursor";
import { openComposer, closeComposer } from "./composer";
import { sideFromLineType } from "./selection-derive";

// Payload shapes coming out of @pierre/diffs' line callbacks are loosely
// documented, so the extraction below is deliberately duck-typed.
type LinePayload = { lineNumber: number; side?: unknown; endLine?: number; event?: PointerEvent };

let dragSelectionStart: LinePayload | null = null;
let suppressSelectionUntil = 0;
let ignoreNextLineClick = false;

// A line click/drag opens an inline composer anchored under the selected line (option B —
// no intermediate action pop). The composer is a `composer` annotation the diff render
// injects at S.selected, so there's nothing to position at the pointer.
export function openCommentComposer() {
  openComposer();
}

function selectedEndpoint(range: any) {
  return range?.end || range?.start || range?.anchor || range?.focus || range;
}
function extractLinePayload(value: any): LinePayload | null {
  if (!value || typeof value !== "object") return null;
  const lineNumber =
    value.lineNumber ?? value.line?.number ?? value.lineInfo?.number ?? value.number;
  const side =
    value.annotationSide ?? value.side ?? value.line?.side ?? value.lineInfo?.side ?? value.type;
  const event = value.event;
  return Number.isFinite(lineNumber) ? { lineNumber, side, event } : null;
}
export function normalizeSide(side: unknown): Side {
  return side === "deletions" || side === "old" ? "deletions" : "additions";
}
function linePayloadFromPointerEvent(e: PointerEvent): LinePayload | null {
  for (const el of (e.composedPath?.() || []) as HTMLElement[]) {
    if (!el || el.nodeType !== 1) continue;
    const text = (el.innerText || el.textContent || "").trim();
    if (/^\d+$/.test(text)) {
      // Prefer the row's own side (@pierre's data-line-type on this cell or an ancestor): in
      // Stacked (unified) view one column carries both sides, so a drag ending on a deletion's
      // right half is mis-tagged by horizontal geometry. Fall back to geometry only when no row
      // type is found (Split view, where the geometric split is correct).
      const lineType = el.closest?.("[data-line-type]")?.getAttribute("data-line-type");
      const box = $("diff").getBoundingClientRect();
      return {
        lineNumber: Number(text),
        side:
          sideFromLineType(lineType) ??
          (e.clientX < box.left + box.width / 2 ? "deletions" : "additions"),
        event: e,
      };
    }
  }
  return null;
}
export function showForDiffLine(payload: LinePayload) {
  S.selected = {
    side: normalizeSide(payload.side),
    lineNumber: payload.lineNumber,
    endLine: payload.endLine,
  };
  // The pointer selection becomes the keyboard cursor too (one highlight, one position),
  // so the arrows continue from the clicked line — the end of the range for a drag.
  cursorSyncTo(normalizeSide(payload.side), payload.endLine ?? payload.lineNumber);
  openCommentComposer();
}
export function composerHasText() {
  return S.composerOpen && S.composerBody.trim().length > 0;
}
export function closeComposerIfEmpty(deferRender = false) {
  if (S.composerOpen && !composerHasText()) closeComposer(deferRender);
}
export function handleDiffSelection(range: any) {
  if (Date.now() < suppressSelectionUntil) return;
  if (!range) {
    closeComposerIfEmpty();
    ignoreNextLineClick = true;
    setTimeout(() => (ignoreNextLineClick = false), 0);
    return;
  }
  const payload = extractLinePayload(selectedEndpoint(range));
  if (payload) showForDiffLine(payload);
}
export function handleLineNumberClick(...args: any[]) {
  if (ignoreNextLineClick) {
    ignoreNextLineClick = false;
    return;
  }
  const payload = args.map(extractLinePayload).find(Boolean);
  if (!payload) return;
  const side = normalizeSide(payload.side);
  // Re-clicking the composer's own line closes it (when empty) instead of reopening.
  if (S.composerOpen && S.selected.lineNumber === payload.lineNumber && S.selected.side === side) {
    if (!composerHasText()) closeComposer();
    suppressSelectionUntil = Date.now() + 350;
    return;
  }
  showForDiffLine(payload);
}
export function attachDiffSelectionHandlers() {
  const root = $("diff");
  root.onpointerdown = (e: PointerEvent) => {
    dragSelectionStart = linePayloadFromPointerEvent(e);
  };
  root.onpointerup = (e: PointerEvent) => {
    const end = linePayloadFromPointerEvent(e);
    if (!dragSelectionStart || !end) return;
    const same =
      dragSelectionStart.lineNumber === end.lineNumber &&
      normalizeSide(dragSelectionStart.side) === normalizeSide(end.side);
    if (same) return;
    showForDiffLine({ ...dragSelectionStart, endLine: end.lineNumber });
    dragSelectionStart = null;
  };
}
