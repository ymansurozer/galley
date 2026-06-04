import { S, $ } from "./store";
import type { Side } from "./types";

// Payload shapes coming out of @pierre/diffs' line callbacks are loosely
// documented, so the extraction below is deliberately duck-typed.
type LinePayload = { lineNumber: number; side?: unknown; endLine?: number; event?: PointerEvent };

let lastSelectionPointer: { clientX: number; clientY: number } | null = null;
let dragSelectionStart: LinePayload | null = null;
let suppressSelectionUntil = 0;
let ignoreNextLineClick = false;

export function placePopoverFromPoint(clientX: number, clientY: number) {
  const box = (document.querySelector(".main") as HTMLElement).getBoundingClientRect();
  const pop = $("actionPop");
  pop.style.left = `${Math.max(292, Math.min(box.width - 320, clientX - box.left + 12))}px`;
  pop.style.top = `${Math.max(58, Math.min(box.height - 220, clientY - box.top + 8))}px`;
}

export function placeNearActionPop(el: HTMLElement) {
  const pop = $("actionPop");
  if (pop.style.left && pop.style.top) { el.style.left = pop.style.left; el.style.top = pop.style.top; }
  else if (lastSelectionPointer) { placePopoverFromPoint(lastSelectionPointer.clientX, lastSelectionPointer.clientY); el.style.left = pop.style.left; el.style.top = pop.style.top; }
}

export function openCommentComposer() {
  placeNearActionPop($("composer"));
  S.popoverOpen = false;
  S.composerBody = "";
  S.composerTitle = selectionLabel();
  S.composerOpen = true;
  setTimeout(() => $("commentBody").focus(), 0); // after Alpine shows it
}

function selectedEndpoint(range: any) { return range?.end || range?.start || range?.anchor || range?.focus || range; }
function extractLinePayload(value: any): LinePayload | null {
  if (!value || typeof value !== "object") return null;
  const lineNumber = value.lineNumber ?? value.line?.number ?? value.lineInfo?.number ?? value.number;
  const side = value.annotationSide ?? value.side ?? value.line?.side ?? value.lineInfo?.side ?? value.type;
  const event = value.event;
  return Number.isFinite(lineNumber) ? { lineNumber, side, event } : null;
}
export function normalizeSide(side: unknown): Side { return side === "deletions" || side === "old" ? "deletions" : "additions"; }
function linePayloadFromPointerEvent(e: PointerEvent): LinePayload | null {
  for (const el of (e.composedPath?.() || []) as HTMLElement[]) {
    if (!el || el.nodeType !== 1) continue;
    const text = (el.innerText || el.textContent || "").trim();
    if (/^\d+$/.test(text)) { const box = $("diff").getBoundingClientRect(); return { lineNumber: Number(text), side: e.clientX < box.left + box.width / 2 ? "deletions" : "additions", event: e }; }
  }
  return null;
}
export function selectionLabel() {
  const side = S.selected.side === "deletions" ? "Old" : "New";
  const a = S.selected.lineNumber, b = S.selected.endLine;
  return b && b !== a ? `${side} lines ${Math.min(a, b)}–${Math.max(a, b)}` : `${side} line ${a}`;
}
export function showForDiffLine(payload: LinePayload, event?: PointerEvent) {
  S.selected = { side: normalizeSide(payload.side), lineNumber: payload.lineNumber, endLine: payload.endLine };
  $("popContext").textContent = selectionLabel();
  const e = event || payload.event;
  if (e?.clientX) placePopoverFromPoint(e.clientX, e.clientY);
  else if (lastSelectionPointer) placePopoverFromPoint(lastSelectionPointer.clientX, lastSelectionPointer.clientY);
  openCommentComposer();
}
export function composerHasText() { return S.composerOpen && S.composerBody.trim().length > 0; }
export function closeComposerIfEmpty() { if (S.composerOpen && !composerHasText()) S.composerOpen = false; }
export function handleDiffSelection(range: any) {
  if (Date.now() < suppressSelectionUntil) return;
  if (!range) { S.popoverOpen = false; closeComposerIfEmpty(); ignoreNextLineClick = true; setTimeout(() => (ignoreNextLineClick = false), 0); return; }
  const payload = extractLinePayload(selectedEndpoint(range));
  if (payload) showForDiffLine(payload);
}
export function handleLineNumberClick(...args: any[]) {
  if (ignoreNextLineClick) { ignoreNextLineClick = false; return; }
  const payload = args.map(extractLinePayload).find(Boolean);
  if (!payload) return;
  const side = normalizeSide(payload.side);
  if (S.composerOpen && S.selected.lineNumber === payload.lineNumber && S.selected.side === side) {
    if (!composerHasText()) S.composerOpen = false;
    suppressSelectionUntil = Date.now() + 350;
    return;
  }
  showForDiffLine(payload, args.find((a) => a && typeof a === "object" && "clientX" in a));
}
export function attachDiffSelectionHandlers() {
  const root = $("diff");
  root.onpointerdown = (e: PointerEvent) => { lastSelectionPointer = { clientX: e.clientX, clientY: e.clientY }; dragSelectionStart = linePayloadFromPointerEvent(e); };
  root.onpointerup = (e: PointerEvent) => {
    const end = linePayloadFromPointerEvent(e);
    if (!dragSelectionStart || !end) return;
    const same = dragSelectionStart.lineNumber === end.lineNumber && normalizeSide(dragSelectionStart.side) === normalizeSide(end.side);
    if (same) return;
    showForDiffLine({ ...dragSelectionStart, endLine: end.lineNumber }, e);
    dragSelectionStart = null;
  };
}
