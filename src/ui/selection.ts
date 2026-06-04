import { S, $, show, hide } from "./store";

let lastSelectionPointer: any = null;
let dragSelectionStart: any = null;
let suppressSelectionUntil = 0;
let ignoreNextLineClick = false;

export function placePopoverFromPoint(clientX: number, clientY: number) {
  const box = (document.querySelector(".main") as any).getBoundingClientRect();
  const pop = $("actionPop");
  pop.style.left = `${Math.max(292, Math.min(box.width - 320, clientX - box.left + 12))}px`;
  pop.style.top = `${Math.max(58, Math.min(box.height - 220, clientY - box.top + 8))}px`;
}

export function placeNearActionPop(el: any) {
  const pop = $("actionPop");
  if (pop.style.left && pop.style.top) { el.style.left = pop.style.left; el.style.top = pop.style.top; }
  else if (lastSelectionPointer) { placePopoverFromPoint(lastSelectionPointer.clientX, lastSelectionPointer.clientY); el.style.left = pop.style.left; el.style.top = pop.style.top; }
}

export function openCommentComposer() {
  placeNearActionPop($("composer"));
  hide($("actionPop"));
  $("commentBody").value = "";
  $("composerTitle").textContent = selectionLabel();
  show($("composer"));
  $("commentBody").focus();
}

function selectedEndpoint(range: any) { return range?.end || range?.start || range?.anchor || range?.focus || range; }
function extractLinePayload(value: any) {
  if (!value || typeof value !== "object") return null;
  const lineNumber = value.lineNumber ?? value.line?.number ?? value.lineInfo?.number ?? value.number;
  const side = value.annotationSide ?? value.side ?? value.line?.side ?? value.lineInfo?.side ?? value.type;
  const event = value.event;
  return Number.isFinite(lineNumber) ? { lineNumber, side, event } : null;
}
export function normalizeSide(side: any) { return side === "deletions" || side === "old" ? "deletions" : "additions"; }
function linePayloadFromPointerEvent(e: any) {
  for (const el of (e.composedPath?.() || []) as any[]) {
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
export function showForDiffLine(payload: any, event?: any) {
  S.selected = { side: normalizeSide(payload.side), lineNumber: payload.lineNumber, endLine: payload.endLine };
  $("popContext").textContent = selectionLabel();
  const e = event || payload.event;
  if (e?.clientX) placePopoverFromPoint(e.clientX, e.clientY);
  else if (lastSelectionPointer) placePopoverFromPoint(lastSelectionPointer.clientX, lastSelectionPointer.clientY);
  openCommentComposer();
}
export function composerHasText() { return $("composer").classList.contains("show") && $("commentBody").value.trim().length > 0; }
export function closeComposerIfEmpty() { if ($("composer").classList.contains("show") && !composerHasText()) hide($("composer")); }
export function handleDiffSelection(range: any) {
  if (Date.now() < suppressSelectionUntil) return;
  if (!range) { hide($("actionPop")); closeComposerIfEmpty(); ignoreNextLineClick = true; setTimeout(() => (ignoreNextLineClick = false), 0); return; }
  const payload = extractLinePayload(selectedEndpoint(range));
  if (payload) showForDiffLine(payload);
}
export function handleLineNumberClick(...args: any[]) {
  if (ignoreNextLineClick) { ignoreNextLineClick = false; return; }
  const payload: any = args.map(extractLinePayload).find(Boolean);
  if (!payload) return;
  const side = normalizeSide(payload.side);
  if ($("composer").classList.contains("show") && S.selected.lineNumber === payload.lineNumber && S.selected.side === side) {
    if (!composerHasText()) hide($("composer"));
    suppressSelectionUntil = Date.now() + 350;
    return;
  }
  showForDiffLine(payload, args.find((a) => a && typeof a === "object" && "clientX" in a));
}
export function attachDiffSelectionHandlers() {
  const root = $("diff");
  root.onpointerdown = (e: any) => { lastSelectionPointer = { clientX: e.clientX, clientY: e.clientY }; dragSelectionStart = linePayloadFromPointerEvent(e); };
  root.onpointerup = (e: any) => {
    const end = linePayloadFromPointerEvent(e);
    if (!dragSelectionStart || !end) return;
    const same = dragSelectionStart.lineNumber === end.lineNumber && normalizeSide(dragSelectionStart.side) === normalizeSide(end.side);
    if (same) return;
    showForDiffLine({ ...dragSelectionStart, endLine: end.lineNumber }, e);
    dragSelectionStart = null;
  };
}
