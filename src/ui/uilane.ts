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
  draftAnchor,
  marksFor,
  markTarget,
  nextNumber,
  openChangeCount,
  pageGroups,
  pageMarks,
  placeComposer,
  sendSummary,
  sourcePlace,
  stepFrom,
  stepOrder,
  turnAnnotationInto,
  turnsInto,
  waitingCount,
} from "./uilane-derive";
import {
  composerHead,
  pageHead,
  quoteLine,
  rowLine,
  shotLink,
  sourceLink,
  type ShotStatus,
} from "./uilane-dom";
import { uuid } from "./uuid";
import type {
  AnnotationDraft,
  AppMode,
  PickedTarget,
  Rect,
  UiAnnotationRecord,
  UiPage,
  UiPlacement,
  UiTarget,
} from "./types";

// The UI lane's annotations: Annotate mode, the floating composer on a picked target or the page,
// the sidebar (the "Quiet" list: page groups, one-line rows, a row expands to its thread), and the
// pins the bridge draws. Annotations live on S.state.annotations and save through the reviewer
// slice like comments do. Threads render through the code lane's own thread component, keyed by
// annotation id. The lane gates nothing: no approval, blockers or progress.

const annotationsOf = () => S.state?.annotations ?? [];
const find = (id: string | null) => annotationsOf().find((a) => a.id === id);
const narrow = () => matchMedia("(max-width: 1100px)").matches;
// Past every number given so far, deleted annotations' included (lastAnnotationNumber).
const upcomingNumber = () => nextNumber(annotationsOf(), S.state.lastAnnotationNumber ?? 0);

export const openChanges = () => openChangeCount(annotationsOf());
export const waitingQuestions = () => waitingCount(annotationsOf());

// Composer text the reviewer walked away from without Esc: a reply or edit in a thread they
// collapsed or left for another row, and the floating composer on a pick when they switched to the
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

// Back in the UI view: the set-aside floating composer, else the selected row's draft.
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

export function toggleAnnotations() {
  S.annotationsOpen = !S.annotationsOpen;
}

// The annotation selected on another page, until that page says whether its target is there: if
// it isn't, the reviewer is told why nothing is outlined.
let revealing: string | null = null;

// Space left where a thread closed above the row being selected, so that row and every row above
// it stay where they were, keyed by the row it follows. A gap goes once it's out of sight above
// (the list scrolls up by as much, so nothing in sight moves), and when the pointer leaves the list.
const gaps = new Map<string, number>();

const rowIn = (list: HTMLElement, id: string) =>
  list.querySelector<HTMLElement>(`[data-annotation="${CSS.escape(id)}"]`);

// Draw the gaps after their rows. A gap whose row has gone goes with it.
function placeGaps(list: HTMLElement) {
  for (const el of list.querySelectorAll(".ann-gap")) el.remove();
  for (const [id, height] of gaps) {
    const row = rowIn(list, id);
    if (!row) {
      gaps.delete(id);
      continue;
    }
    const gap = document.createElement("div");
    gap.className = "ann-gap";
    gap.dataset.gap = id;
    gap.style.height = `${height}px`;
    (row.closest(".ann-item") ?? row).after(gap);
  }
}

// Take out the part of each gap that's scrolled out of sight above, scrolling up by as much.
function trimGaps(list: HTMLElement) {
  for (const el of list.querySelectorAll<HTMLElement>(".ann-gap")) {
    const id = el.dataset.gap;
    const r = el.getBoundingClientRect();
    const hidden = Math.min(r.height, list.getBoundingClientRect().top - r.top);
    if (!id || hidden <= 0) continue;
    const before = list.scrollTop;
    list.scrollTop = before - hidden;
    const left = r.height - (before - list.scrollTop);
    if (left > 0.5) {
      gaps.set(id, left);
      el.style.height = `${left}px`;
    } else {
      gaps.delete(id);
      el.remove();
    }
  }
}

// Where the list's content ends, in its scroll coordinates. scrollHeight can't say once the content
// fits: it never reads less than the list's own height.
function contentEnd(list: HTMLElement) {
  const last = list.lastElementChild;
  if (!last) return 0;
  const bottom = last.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
  return bottom + list.scrollTop + parseFloat(getComputedStyle(list).paddingBottom);
}

function dropGaps(list: HTMLElement) {
  if (!gaps.size) return;
  gaps.clear();
  placeGaps(list);
}

// Expand an annotation's row and outline its target, taking the app to its page first. Null
// collapses the row. A reply or edit open in another thread is set aside with its text.
export function selectAnnotation(id: string | null, fromList = false) {
  const a = find(id);
  const list = $("annotationList");
  const open = S.selectedAnnotation;
  // Only a click in the list holds rows in place, since the pointer is on them. A step from the
  // keyboard or a pin in the app scrolls its row into view instead, and leaves no gaps behind:
  // with no pointer in the list, nothing would take them out again.
  if (!fromList) dropGaps(list);
  // A row in sight stays where it is: the one clicked, or the one collapsing. Gaps under it may
  // close: only what's below a row moves.
  const held = fromList ? (a?.id ?? open) : null;
  const row = held ? rowIn(list, held) : null;
  const was = row?.getBoundingClientRect().top;
  const sight = list.getBoundingClientRect();
  const scrolled = list.scrollTop;
  const keep = was !== undefined && was >= sight.top && was < sight.bottom;
  if (row)
    for (const gid of gaps.keys()) {
      const after = rowIn(list, gid);
      if (
        after &&
        (after === row || row.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING)
      )
        gaps.delete(gid);
    }
  if (S.composerAnnotation && S.composerAnnotation !== a?.id) setUiComposerAside();
  S.selectedAnnotation = a?.id ?? null;
  revealing = null;
  if (a) {
    if (a.status === "resolved") S.shownResolved.add(a.page.route);
    S.annotationsOpen = true;
    if (S.view === "ui" && a.page.route !== S.app.route) {
      if (a.target.kind !== "page") revealing = a.id;
      appGo(a.page.route);
    }
  }
  if (!a || S.composerOpen || !resumeThreadDraft(a.id)) renderUiLane();
  const now = keep && held ? rowIn(list, held)?.getBoundingClientRect().top : undefined;
  if (now !== undefined && was !== undefined) {
    if (a && open && open !== a.id && was - now > 0.5) {
      // A thread that closed above the row pulled it up: leave its space where it was.
      gaps.set(open, (gaps.get(open) ?? 0) + was - now);
      placeGaps(list);
      trimGaps(list);
    } else if (now - was > 0.5) {
      // Space closed below the row while the list was scrolled to its end, and the scroll fell
      // back: put back at the end what it takes to scroll where it was, then scroll there.
      const rows = list.querySelectorAll<HTMLElement>("[data-annotation]");
      const last = rows[rows.length - 1]?.dataset.annotation;
      const short = scrolled + list.clientHeight - contentEnd(list);
      if (last && short > 0.5) {
        gaps.set(last, (gaps.get(last) ?? 0) + short);
        placeGaps(list);
        list.scrollTop = scrolled;
      }
    }
  }
  if (!a) return;
  requestAnimationFrame(() => rowIn(list, a.id)?.scrollIntoView({ block: "nearest" }));
}

// `only` narrows the walk: `]` / `[` step through the open change requests alone.
export function stepAnnotation(dir: 1 | -1, only?: (a: UiAnnotationRecord) => boolean) {
  const list = annotationsOf();
  const order = stepOrder(pageGroups(list), S.shownResolved);
  const kept = only && new Set(list.filter(only).map((a) => a.id));
  const next = stepFrom(order, S.selectedAnnotation, dir, kept ? (id) => kept.has(id) : undefined);
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
// trusted, is looked at again at once, so its own rows go back to placed or unplaced; the others
// wait for their page to load.
export function annotationsUnvisited() {
  for (const a of annotationsOf()) a.placement = "unvisited";
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
    marks: marksFor(annotationsOf(), S.app.route, S.selectedAnnotation),
    selected: S.selectedAnnotation,
    // The composer is on the bridge's last pick (a page draft is the desk's own).
    picking: !!S.annotationDraft && S.annotationDraft.target.kind !== "page",
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
// Only Send waits on it, and only for so long. The row reads "capturing…" until both are stored,
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
  // Two frames first, so the closed composer and the new row are painted before the render,
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
// question event from its stored copy of the annotation.
async function askAgent(annotationId: string, messageId: string) {
  await saver.settled();
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
    toast("Comment updated");
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
    S.selectedAnnotation = created.id;
    if (!narrow()) S.annotationsOpen = true;
    if (intent === "question") asked = { annotation: created.id, message: message.id };
    toast(`#${created.number} ${intent === "question" ? "asked — waiting for answer" : "added"}`);
  } else if (a) {
    a.comments.push(message);
    if (intent === "question") asked = { annotation: a.id, message: message.id };
    toast(intent === "question" ? "Asked — waiting for answer" : "Comment saved");
  }
  // Started before the composer closes, so the row it renders already reads "capturing…".
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
      // A resolved row leaves the list, unless its page is showing resolved ones.
      if (status === "resolved" && !S.shownResolved.has(a.page.route)) S.selectedAnnotation = null;
      renderUiLane();
      toast(status === "resolved" ? "Resolved" : "Reopened");
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
      if (intent === "question") {
        void askAgent(a.id, opener.id);
        toast(`#${a.number} turned into an ask — waiting for answer`);
      } else toast(`#${a.number} turned into a change request — it goes with the next Send`);
    },
    // The opening message is the annotation's body: deleting it deletes the annotation. Later
    // messages delete like code comments.
    remove: (messageId) => {
      if (S.composerAnnotation === a.id) closeComposer();
      if (a.comments[0]?.id === messageId) {
        S.state.annotations = annotationsOf().filter((x) => x.id !== a.id);
        if (S.selectedAnnotation === a.id) S.selectedAnnotation = null;
        toast(`Deleted #${a.number}`);
      } else {
        a.comments = a.comments.filter((m) => m.id !== messageId);
        toast("Comment deleted");
      }
      renderUiLane();
      persist();
    },
  };
}

// Everything the lane draws from the store: the sidebar list, the floating composer, and the pins.
export function renderUiLane() {
  renderList();
  renderFloatingComposer();
  restoreComposerFocus();
  syncBridge();
}

function renderList() {
  const host = $("annotationList");
  const groups = pageGroups(annotationsOf());
  if (!groups.length) {
    gaps.clear();
    host.innerHTML = `<p class="ann-empty">No annotations yet. Annotate (⌥A), then click, drag across or select anything in the app, or press ⌥P for the whole page.</p>`;
    return;
  }
  host.replaceChildren(
    ...groups.map((g) => {
      const section = document.createElement("section");
      section.className = `ann-page${g.route === S.app.route ? " here" : ""}`;
      const shown = S.shownResolved.has(g.route);
      section.append(pageHead(document, g), ...g.open.map(row));
      if (g.resolved.length) {
        const toggle = document.createElement("button");
        toggle.className = "ann-show-resolved";
        toggle.dataset.resolved = g.route;
        toggle.setAttribute("aria-expanded", String(shown));
        toggle.textContent = shown ? "Hide resolved" : `${g.resolved.length} resolved`;
        section.append(toggle);
        if (shown) section.append(...g.resolved.map(row));
      }
      return section;
    }),
  );
  placeGaps(host);
}

// One row: the number (tinted by kind) and the body's first line. Selected, it expands to the
// thread, through the code lane's thread component.
function row(a: UiAnnotationRecord): HTMLElement {
  const selected = a.id === S.selectedAnnotation;
  const line = rowLine(document, a, selected);
  if (!selected) return line;
  const item = document.createElement("div");
  item.className = `ann-item k-${a.intent}${a.status === "resolved" ? " resolved" : ""}`;
  item.append(line);
  // One muted line of context: the screenshot, then where the element came from.
  const ctx = document.createElement("div");
  ctx.className = "ann-ctx";
  ctx.append(shotLink(document, shotStatus(a), captureErrors.get(a.id), () => openShot(a.id)));
  const source = annotationSource(a.target);
  if (source) {
    const sep = document.createElement("span");
    sep.textContent = "·";
    ctx.append(
      sep,
      sourceLink(document, sourcePlace(source, S.state.root), "ann-src", openEditorAt),
    );
  }
  if (a.placement === "unplaced") {
    const sep = document.createElement("span");
    sep.textContent = "·";
    const note = document.createElement("span");
    note.className = "ann-unplaced";
    note.textContent = "Unplaced";
    note.title = "Couldn't find it on its page when the page last loaded. It's still sent.";
    ctx.append(sep, note);
  }
  item.append(ctx);
  const thread = document.createElement("div");
  thread.className = `annotation${a.status === "resolved" ? " resolved" : ""}`;
  thread.append(buildCommentThread(a, threadControls(a)));
  item.append(thread);
  return item;
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
  const card = document.createElement("div");
  card.className = "annotation";
  card.append(buildComposer());
  host.replaceChildren(...parts, card);
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
  const list = $("annotationList");
  // Gaps go once the list has settled: what's scrolled out of sight above when a scroll ends (not
  // during one, which would fight its momentum), and the rest when the pointer leaves.
  let settling = 0;
  list.addEventListener("scroll", () => {
    clearTimeout(settling);
    if (gaps.size) settling = window.setTimeout(() => trimGaps(list), 150);
  });
  list.addEventListener("mouseleave", () => dropGaps(list));
  list.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    // The thread's own buttons are wired by the thread component.
    if (!t || t.closest(".comment-box")) return;
    const rowEl = t.closest<HTMLElement>("[data-annotation]");
    if (rowEl) {
      const id = rowEl.dataset.annotation ?? null;
      selectAnnotation(id === S.selectedAnnotation ? null : id, true);
      return;
    }
    const head = t.closest<HTMLElement>("[data-route]");
    if (head?.dataset.route) {
      appGo(head.dataset.route);
      return;
    }
    const toggle = t.closest<HTMLElement>("[data-resolved]");
    const route = toggle?.dataset.resolved;
    if (route) {
      if (S.shownResolved.has(route)) S.shownResolved.delete(route);
      else S.shownResolved.add(route);
      const selected = find(S.selectedAnnotation);
      if (selected?.status === "resolved" && !S.shownResolved.has(selected.page.route))
        S.selectedAnnotation = null;
      renderUiLane();
    }
  });
}
