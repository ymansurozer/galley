import { S, $, openEditorAt, toast, persist, persistSoon, saver } from "./store";
import { buildCommentThread, type ThreadControls } from "./annotations";
import {
  buildComposer,
  closeComposer,
  composerInUi,
  composerTargetsAnnotation,
  openComposer,
  restoreComposerFocus,
} from "./composer";
import { appGo, appViewport, captureApp, fromAppViewport, postToApp } from "./appview";
import { settledWithin } from "./appnav";
import {
  annotationSource,
  askStamp,
  draftAnchor,
  isOpenChange,
  marksFor,
  markTarget,
  nextNumber,
  pageMarks,
  placeComposer,
  sendSummary,
  sourcePlace,
  stepFrom,
  stepOrder,
  targetLabel,
  trayPins,
  turnAnnotationInto,
  turnsInto,
} from "./uilane-derive";
import { composerHead, quoteLine, shotLink, sourceLink, type ShotStatus } from "./uilane-dom";
import { uuid } from "./uuid";
import type {
  AnnotationDraft,
  AppMode,
  PickedTarget,
  PinRect,
  Rect,
  UiAnnotationRecord,
  UiPage,
  UiPlacement,
  UiTarget,
} from "./types";

// The UI lane's annotations: Annotate mode, the floating composer on a picked target or the page,
// and the pins (the bridge's on the page, the desk's in the address bar and the Unplaced tray), the
// selected one's thread opening as a card beside its pin. Annotations live on S.state.annotations
// and save through the reviewer slice like comments do. Threads render through the code lane's own
// thread component, keyed by annotation id. The lane gates nothing: no approval, blockers or
// progress.

const annotationsOf = () => S.state?.annotations ?? [];
const find = (id: string | null) => annotationsOf().find((a) => a.id === id);
// Past every number given so far, deleted annotations' included (lastAnnotationNumber).
const upcomingNumber = () => nextNumber(annotationsOf(), S.state.lastAnnotationNumber ?? 0);

// Composer text the reviewer walked away from without Esc: a reply or edit in a thread they
// closed or left for another card, and the floating composer on a pick when they switched to the
// code view. The composer closes, so nothing hidden holds it (code hotkeys and the poll's diff
// adoption both wait on an open composer), and it comes back with its text when they return.
// Esc discards, as it does in the code lane.
const threadDrafts = new Map<string, { editing: string | null; body: string }>();
let pickDraft: { draft: AnnotationDraft; body: string } | null = null;

export function setUiComposerAside() {
  if (!S.composerOpen || !composerInUi()) return;
  const body = S.composerBody;
  if (S.annotationDraft) pickDraft = { draft: S.annotationDraft, body };
  else if (S.composerAnnotation && body.trim())
    threadDrafts.set(S.composerAnnotation, { editing: S.editingCommentId, body });
  closeComposer();
}

// Reopen a thread's set-aside reply or edit, if it has one and its message is still there.
function resumeThreadDraft(id: string) {
  const d = threadDrafts.get(id);
  threadDrafts.delete(id);
  const a = find(id);
  if (!d || !a || (d.editing && !a.comments.some((m) => m.id === d.editing))) return false;
  openComposer(id, d.body, d.editing);
  return true;
}

// Back in the UI view: the set-aside floating composer, else the selected card's draft.
export function resumeUiComposer() {
  if (S.composerOpen) return;
  const p = pickDraft;
  pickDraft = null;
  if (p) {
    S.annotationDraft = p.draft;
    openComposer(null, p.body);
  } else if (S.selectedAnnotation) resumeThreadDraft(S.selectedAnnotation);
}

// The mode the app is in: Interact whenever the code view hides it.
export const appModeNow = (): AppMode => (S.view === "ui" ? S.appMode : "interact");

export function setAppMode(mode: AppMode) {
  S.appMode = mode;
  syncBridge();
}
export const toggleAppMode = () => setAppMode(S.appMode === "annotate" ? "interact" : "annotate");

// The annotation selected on another page, until that page says whether its target is there: if
// it isn't, the reviewer is told why nothing is outlined.
let revealing: string | null = null;

// Whether the selected annotation's card is showing: it shows only while the app is on its page,
// so a selection left behind on another page is invisible and Esc passes it by.
export function pinCardShowing() {
  const a = find(S.selectedAnnotation);
  return !!a && S.view === "ui" && a.page.route === S.app.route;
}

// Select an annotation, opening its card and outlining its target, taking the app to its page
// first. Null closes the card. A reply or edit open in another thread is set aside with its text.
export function selectAnnotation(id: string | null) {
  const a = find(id);
  if (S.composerAnnotation && S.composerAnnotation !== a?.id) setUiComposerAside();
  S.selectedAnnotation = a?.id ?? null;
  revealing = null;
  if (a && S.view === "ui" && a.page.route !== S.app.route) {
    if (a.target.kind !== "page") revealing = a.id;
    appGo(a.page.route);
  }
  if (!a || S.composerOpen || !resumeThreadDraft(a.id)) renderUiLane();
}

// ⇧↓ / ⇧↑: the next or previous annotation by number, on whichever page, resolved or not.
export function stepAnnotation(dir: 1 | -1) {
  const next = stepFrom(stepOrder(annotationsOf()), S.selectedAnnotation, dir);
  if (next) selectAnnotation(next);
}

// Open the floating composer on a new target. Picking again while composing moves the composer to
// the new target and keeps the text.
function openDraft(page: Omit<UiPage, "url">, target: UiTarget) {
  const ui = S.state.ui;
  if (!ui) return;
  const carried = S.annotationDraft ? S.composerBody : "";
  // A reply or edit elsewhere (or a code comment left open) gives way: one composer at a time.
  if (S.composerOpen && !S.annotationDraft) closeComposer();
  S.annotationDraft = {
    // The dev server's own URL for the page, not the proxy's.
    page: { url: new URL(page.route, ui.target).href, ...page },
    target,
    anchor: draftAnchor(target),
  };
  openComposer(null, carried);
}

// The reviewer picked something in Annotate mode: an element (or several), a box, or text.
export const pickedInApp = (page: Omit<UiPage, "url">, target: PickedTarget) =>
  openDraft(page, target);

// Annotate the page in the app as a whole (the chrome bar's button, ⌥P). It needs a page with a
// bridge on it, which reported its route: not the waiting page, not a non-HTML one.
export function annotatePage() {
  const viewport = appViewport();
  if (S.view !== "ui" || !S.app.connected || !viewport) return;
  openDraft(
    { route: S.app.route, ...(S.app.title && { title: S.app.title }), viewport },
    { kind: "page" },
  );
}

export function movedInApp(rect: Rect) {
  const draft = S.annotationDraft;
  if (!draft || draft.target.kind === "page") return;
  draft.anchor = rect;
  placeFloatingComposer();
}

// How many ⇧-clicked elements wait in the app for ⇧'s release, and dropping them (Esc).
export function pendingInApp(count: number) {
  S.pendingPicks = count;
}
// Posted whether or not the desk counts the page's bridge as connected: a bridge that is still
// there (its handshake not yet seen again) keeps its picks otherwise.
export function clearPendingPicks() {
  S.pendingPicks = 0;
  if (S.uiProxy) postToApp({ type: "clearPicks", token: S.uiProxy.token });
}

// The current page's page annotations, as pins in the address bar.
export const pagePins = () => pageMarks(annotationsOf(), S.app.route, S.selectedAnnotation);
// The current page's annotations not found on it, as pins in the stage's Unplaced tray: only once
// this visit's bridge has looked for them, not on what an earlier visit found.
export const unplacedPins = () =>
  trayPins(
    annotationsOf().filter((a) => S.lookedFor.has(a.id)),
    S.app.route,
    S.selectedAnnotation,
  );

// The page annotations of the page the app shows are placed: their target is the page, and here it
// is. Whether any of them changed.
function placePageAnnotations(): boolean {
  const pages = annotationsOf().filter(
    (a) => a.target.kind === "page" && a.page.route === S.app.route && a.placement !== "placed",
  );
  for (const a of pages) a.placement = "placed";
  return pages.length > 0;
}

// The app loaded a page (`fresh`: a new document, whose bridge has drawn nothing) or moved to
// another route in-page. The pick it was composing on is gone with the old page.
let sentMode = "";
let sentMarks = "";
export function appPageChanged(fresh: boolean) {
  if (fresh) {
    sentMode = sentMarks = "";
    S.pendingPicks = 0;
  }
  pickDraft = null;
  pinRects = new Map();
  S.lookedFor.clear();
  const placed = placePageAnnotations();
  if (S.annotationDraft) closeComposer();
  else renderUiLane();
  if (placed) persistSoon();
}

// Where the bridge found this page's marks: each one's first answer once the page settled, then
// its changes. Only annotations on the page the app shows take an answer, so a late one from a page
// the app has since left changes nothing.
export function placedInApp(placements: ReadonlyArray<{ id: string; placement: UiPlacement }>) {
  let changed = placePageAnnotations();
  for (const { id, placement } of placements) {
    const a = find(id);
    if (!a || a.page.route !== S.app.route) continue;
    S.lookedFor.add(id);
    if (id === revealing) {
      revealing = null;
      if (placement === "unplaced")
        toast(`Couldn't find #${a.number} on this page — it's still sent`);
    }
    if (a.placement === placement) continue;
    a.placement = placement;
    changed = true;
  }
  if (!changed) return;
  renderUiLane();
  persistSoon();
}

// `galley reload` ran or the desk restarted: no annotation has been looked for since. The desk
// marked its own copy; this keeps the tab's in step. The page on screen, while its bridge is still
// trusted, is looked at again at once, so its own pins go back to placed or unplaced; the others
// wait for their page to load.
export function annotationsUnvisited() {
  for (const a of annotationsOf()) a.placement = "unvisited";
  S.lookedFor.clear();
  if (S.uiProxy && S.app.connected) {
    placePageAnnotations();
    postToApp({ type: "relook", token: S.uiProxy.token });
  }
  renderUiLane();
}

// Tell the bridge the mode and this page's pins, when they changed since it was last told.
export function syncBridge() {
  if (!S.uiProxy || !S.app.connected) return;
  const token = S.uiProxy.token;
  const mode = appModeNow();
  if (mode !== sentMode) {
    sentMode = mode;
    // Out of Annotate, the bridge drops its ⇧-picks.
    if (mode !== "annotate") S.pendingPicks = 0;
    postToApp({ type: "mode", token, mode });
  }
  const marks = {
    marks: marksFor(annotationsOf(), S.app.route),
    selected: S.selectedAnnotation,
    // The composer is on the bridge's last pick (a page draft is the desk's own): the number its
    // draft pin shows.
    picking:
      S.annotationDraft && S.annotationDraft.target.kind !== "page" ? upcomingNumber() : null,
  };
  const key = JSON.stringify(marks);
  if (key !== sentMarks) {
    sentMarks = key;
    postToApp({ type: "marks", token, ...marks });
  }
}

// Screenshots of new annotations still being captured or uploaded (by annotation id, each until it
// has stored both or failed), and why a capture failed. Both are this tab's alone: after a reload,
// an annotation without stored screenshots reads as failed.
const capturing = new Map<string, Promise<void>>();
const captureErrors = new Map<string, string>();

const shotStatus = (a: UiAnnotationRecord): ShotStatus =>
  capturing.has(a.id) ? "capturing" : a.screenshots ? "stored" : "failed";

// Whether Send has screenshots to wait for, and the wait: until each is stored or has failed, or
// `ms` has passed.
export const screenshotsInFlight = () => capturing.size > 0;
export const screenshotsSettled = (ms: number) => settledWithin(capturing.values(), ms);

// Screenshot the page for a new annotation, as the reviewer marked it: the bridge renders the
// viewport and a crop around the target, with the annotation's mark drawn on, and the tab uploads
// both once the annotation's save has landed (the desk takes screenshots only for a saved
// annotation). A page annotation's target is the whole page: its crop is the viewport, unmarked.
// Only Send waits on it, and only for so long. The card reads "capturing…" until both are stored,
// else "capture failed", and the annotation stands either way: it's sent without screenshots.
function captureScreenshots(a: UiAnnotationRecord) {
  const done = storeScreenshots(a)
    .catch((err: unknown) => {
      captureErrors.set(a.id, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      capturing.delete(a.id);
      renderUiLane();
    });
  capturing.set(a.id, done);
}
async function storeScreenshots(a: UiAnnotationRecord) {
  // Two frames first, so the closed composer and the new card are painted before the render,
  // which can keep the page busy for seconds.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const target = markTarget(a.target);
  const shot = await captureApp(
    target ? { target, mark: { number: a.number, question: a.intent === "question" } } : {},
  );
  const crop = target ? shot.crop : shot.viewport;
  if (!crop) throw new Error("the annotated target wasn't on screen");
  await saver.settled();
  for (const [kind, png] of [
    ["crop", crop],
    ["viewport", shot.viewport],
  ] as const) {
    if (!find(a.id)) return; // deleted meanwhile, and its files with it
    const res = await fetch(`/api/ui-shot?annotation=${encodeURIComponent(a.id)}&kind=${kind}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    });
    if (!res.ok) throw new Error(`the desk didn't store the ${kind} (${res.status})`);
  }
  const stored = find(a.id);
  if (stored) stored.screenshots = true;
}

// The enlarged screenshot view: the stored crop or viewport of an annotation.
export function openShot(id: string) {
  S.shotView = { id, kind: "crop" };
}
export function closeShot() {
  S.shotView = null;
}
export const shotSrc = () =>
  S.shotView
    ? `/api/ui-shot?annotation=${encodeURIComponent(S.shotView.id)}&kind=${S.shotView.kind}`
    : "";
export const shotTitle = () => {
  const a = find(S.shotView?.id ?? null);
  return a ? `#${a.number} · screenshot` : "Screenshot";
};

// Hand a question to the agent now, once the save carrying it has landed: the desk builds the
// question event from its stored copy of the annotation. A turn made while the save drained
// supersedes this ask (askStamp).
async function askAgent(annotationId: string, messageId: string) {
  const message = () => find(annotationId)?.comments.find((m) => m.id === messageId);
  const asked = askStamp(message());
  await saver.settled();
  if (askStamp(message()) !== asked) return;
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ annotationId, messageId }),
  }).catch(() => null);
  if (!res?.ok) toast("Couldn't reach the agent — the question goes with the next Send");
}

// Submit the UI lane's open composer, as a change request ("action") or a question: a new
// annotation from the floating composer, a reply in a thread, or an edited message (which keeps
// its intent, as in the code lane).
export function submitUiComposer(intent: "action" | "question") {
  const body = S.composerBody.trim();
  if (!body) return;
  const now = new Date().toISOString();
  const draft = S.annotationDraft;
  const a = find(S.composerAnnotation);
  let created: UiAnnotationRecord | null = null;
  let asked: { annotation: string; message: string } | null = null;
  const message = {
    id: uuid(),
    role: "user" as const,
    intent,
    body,
    createdAt: now,
    updatedAt: now,
  };
  if (S.editingCommentId) {
    const m = a?.comments.find((x) => x.id === S.editingCommentId);
    if (m) {
      m.body = body;
      m.updatedAt = now;
    }
  } else if (draft) {
    const list = (S.state.annotations ??= []);
    created = {
      id: uuid(),
      number: upcomingNumber(),
      intent: intent === "question" ? "question" : "change",
      status: "open",
      placement: "placed",
      page: draft.page,
      target: draft.target,
      comments: [message],
    };
    list.push(created);
    S.state.lastAnnotationNumber = created.number;
    // Its card opens on its new pin.
    S.selectedAnnotation = created.id;
    if (intent === "question") asked = { annotation: created.id, message: message.id };
  } else if (a) {
    a.comments.push(message);
    if (intent === "question") asked = { annotation: a.id, message: message.id };
  }
  // Started before the composer closes, so the card it renders already reads "capturing…".
  if (created) captureScreenshots(created);
  closeComposer();
  persist();
  if (asked) void askAgent(asked.annotation, asked.message);
}

// An annotation's thread controls: the code lane's thread component, keyed by annotation id.
function threadControls(a: UiAnnotationRecord): ThreadControls {
  return {
    replying: composerTargetsAnnotation(a.id),
    reply: () => openComposer(a.id),
    setStatus: (status) => {
      if (S.composerAnnotation === a.id) closeComposer();
      a.status = status;
      renderUiLane();
      persist();
    },
    edit: (messageId) => {
      const m = a.comments.find((x) => x.id === messageId);
      if (!m || m.role === "agent") return;
      if (S.composerOpen) closeComposer();
      openComposer(a.id, m.body, m.id);
    },
    turn: (messageId) => {
      const opener = a.comments[0];
      const intent = opener?.id === messageId ? turnsInto(opener) : null;
      if (!opener || !intent) return;
      turnAnnotationInto(a, intent, new Date().toISOString());
      renderUiLane();
      persist();
      if (intent === "question") void askAgent(a.id, opener.id);
    },
    // The opening message is the annotation's body: deleting it deletes the annotation. Later
    // messages delete like code comments.
    remove: (messageId) => {
      if (S.composerAnnotation === a.id) closeComposer();
      if (a.comments[0]?.id === messageId) {
        S.state.annotations = annotationsOf().filter((x) => x.id !== a.id);
        if (S.selectedAnnotation === a.id) S.selectedAnnotation = null;
      } else a.comments = a.comments.filter((m) => m.id !== messageId);
      renderUiLane();
      persist();
    },
  };
}

// Everything the lane draws from the store: the pin card, the floating composer, and the pins.
export function renderUiLane() {
  renderPinCard();
  renderFloatingComposer();
  restoreComposerFocus();
  syncBridge();
}

// The pin card's line of detail under its header: what was annotated (and how many more elements),
// the screenshot, where the element came from, and whether it was found on its page.
function annotationDetails(a: UiAnnotationRecord): HTMLElement {
  const ctx = document.createElement("div");
  ctx.className = "ann-ctx";
  const sep = () => Object.assign(document.createElement("span"), { textContent: "·" });
  const target = document.createElement("span");
  target.className = "ann-target";
  target.textContent = targetLabel(a.target);
  ctx.append(target);
  const more = a.target.kind === "element" ? a.target.elements.length - 1 : 0;
  if (more > 0)
    ctx.append(Object.assign(document.createElement("span"), { textContent: `+${more} more` }));
  ctx.append(
    sep(),
    shotLink(document, shotStatus(a), captureErrors.get(a.id), () => openShot(a.id)),
  );
  const source = annotationSource(a.target);
  if (source)
    ctx.append(
      sep(),
      sourceLink(document, sourcePlace(source, S.state.root), "ann-src", openEditorAt),
    );
  if (a.placement === "unplaced") {
    const note = document.createElement("span");
    note.className = "ann-unplaced";
    note.textContent = "Unplaced";
    note.title = "Couldn't find it on its page when the page last loaded. It's still sent.";
    ctx.append(sep(), note);
  }
  return ctx;
}

// The selected annotation's thread as a card beside its pin, in the code lane's card language: its
// kind and number, the line of detail, then the thread. It shows while the app is on the
// annotation's page; picking elsewhere, Esc, or its pin again closes it.
let cardFor: string | null = null;
let cardOpenedAt = 0;
function renderPinCard() {
  const host = $("pinCard");
  const a = find(S.selectedAnnotation);
  if (!a || S.view !== "ui" || a.page.route !== S.app.route) {
    cardFor = null;
    host.classList.remove("show");
    host.replaceChildren();
    return;
  }
  if (cardFor !== a.id) {
    cardFor = a.id;
    cardOpenedAt = performance.now();
    host.style.visibility = "hidden";
  }
  const head = {
    kind: a.intent === "question" ? ("question" as const) : ("change" as const),
    loc: `#${a.number}`,
    held: isOpenChange(a),
  };
  const card = buildCommentThread({ ...a, head }, threadControls(a), "chrome");
  const details = annotationDetails(a);
  const top = card.querySelector(".tc-head, .thread-summary");
  if (top) top.after(details);
  else card.prepend(details);
  host.replaceChildren(inAnnotation(card));
  host.classList.add("show");
  placePinCard();
}

// A card in the wrapper the thread styles (and the composer's buttons) are scoped to.
function inAnnotation(card: HTMLElement) {
  const wrap = document.createElement("div");
  wrap.className = "annotation";
  wrap.append(card);
  return wrap;
}

// Keep the card beside its pin as the app scrolls, resizes or changes preset. A page annotation's
// pin is in the address bar, and an unplaced one's in the stage's tray. A pin the bridge hasn't reported yet (its page settling, or scrolling
// it into view) gets a moment before the card settles at the stage's corner; a pin that scrolled
// out of sight leaves the card where it was. Narrow screens show it as a bottom sheet (CSS).
const PIN_WAIT_MS = 600;
let pinWait = 0;
export function placePinCard() {
  const host = $("pinCard");
  const a = find(cardFor);
  if (!a || !host.classList.contains("show") || matchMedia("(max-width: 700px)").matches) {
    host.style.visibility = "";
    return;
  }
  const pin = pinRects.get(a.id);
  const id = CSS.escape(a.id);
  // A desk pin that isn't laid out (its tray still hidden) has no box to anchor to.
  const deskPin = document
    .querySelector(`.pagepin[data-id="${id}"], .traypin[data-id="${id}"]`)
    ?.getBoundingClientRect();
  const anchor = pin ? fromAppViewport(pin) : deskPin?.width ? deskPin : null;
  const placed = host.style.visibility !== "hidden";
  if (!anchor) {
    if (placed) return;
    const wait = PIN_WAIT_MS - (performance.now() - cardOpenedAt);
    if (a.placement !== "unplaced" && wait > 0) {
      clearTimeout(pinWait);
      pinWait = window.setTimeout(placePinCard, wait);
      return;
    }
  }
  const stage = $("appStage").getBoundingClientRect();
  if (!stage.width) return;
  const { left, top } = placeComposer(
    anchor,
    { width: host.offsetWidth, height: host.offsetHeight },
    stage,
  );
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
  host.style.visibility = "";
}

// Where the bridge drew this page's pins (in the app's viewport), and a click on one or off them.
// A click on a pin opens its card, or closes it when it's the open one; a press on the page closes
// it.
let pinRects = new Map<string, Rect>();
export function pinsInApp(pins: readonly PinRect[], clicked?: string | null) {
  pinRects = new Map(pins.map((p) => [p.id, p.rect]));
  if (clicked === undefined) return placePinCard();
  if (clicked === null) {
    if (S.selectedAnnotation) selectAnnotation(null);
    return;
  }
  const opening = clicked !== S.selectedAnnotation;
  selectAnnotation(opening ? clicked : null);
  // The click left the tab's focus in the app, where the desk's keys (Esc to close) don't reach. A
  // pin "click" only the bridge reported never takes it from a field the reviewer is typing in.
  const typing = document.activeElement?.matches("textarea, input, select, [contenteditable]");
  if (opening && !S.composerOpen && !typing) $("pinCard").focus({ preventScroll: true });
}

function renderFloatingComposer() {
  const host = $("uiComposer");
  const draft = S.annotationDraft;
  if (!draft) {
    host.classList.remove("show");
    host.replaceChildren();
    return;
  }
  const { target } = draft;
  const head = composerHead(document, target, draft.page.route, upcomingNumber(), () =>
    closeComposer(),
  );
  const parts: HTMLElement[] = [head];
  if (target.kind === "text") parts.push(quoteLine(document, target.quote));
  // The source chip, when the bridge resolved one.
  const source = annotationSource(draft.target);
  if (source) {
    const chips = document.createElement("div");
    chips.className = "uc-src";
    const chip = sourceLink(document, sourcePlace(source, S.state.root), "src-chip", openEditorAt);
    chip.insertAdjacentHTML("afterbegin", '<svg class="ic"><use href="#gly-code"></use></svg>');
    chips.append(chip);
    parts.push(chips);
  }
  // The code lane's composer card: what will be annotated, then the composer.
  const card = document.createElement("div");
  card.className = "comment-box thread-card k-new";
  card.append(...parts, buildComposer());
  host.replaceChildren(inAnnotation(card));
  host.classList.add("show");
  placeFloatingComposer();
}

// Keep the floating composer beside its target as the app scrolls, resizes or changes preset.
// Narrow screens show it as a bottom sheet (CSS), so it isn't placed there.
export function placeFloatingComposer() {
  const host = $("uiComposer");
  const draft = S.annotationDraft;
  if (!draft || matchMedia("(max-width: 700px)").matches) return;
  const target = draft.anchor && fromAppViewport(draft.anchor);
  const stage = $("appStage").getBoundingClientRect();
  if ((draft.anchor && !target) || !stage.width) return;
  const { left, top } = placeComposer(
    target,
    { width: host.offsetWidth, height: host.offsetHeight },
    stage,
  );
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

export const uiSendSummary = () => sendSummary(annotationsOf());

export function installUiLane() {
  // The tray shows a pin once this visit's page reports it unplaced, seconds after a step may have
  // opened its card at the stage's corner: as the tray appears or changes, the card moves onto it.
  const tray = document.querySelector(".unplaced-tray");
  if (tray) new ResizeObserver(() => placePinCard()).observe(tray);
  // A primary press outside the open pin card closes it: not on the card, a composer, a pin in the
  // tray (it opens and closes the card itself), the browser chrome (a preset or a reload keeps it on
  // its pin; leaving the page hides it), or the screenshot it opened. A press in the app reaches the
  // desk from the bridge instead (pinsInApp).
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const own = t?.closest(".ucomposer, .chrome, .unplaced-tray, .modal-backdrop");
      if (!cardFor || e.button !== 0 || own) return;
      selectAnnotation(null);
    },
    true,
  );
}
