import { S, $, esc, toast, persist } from "./store";
import { buildCommentThread, type ThreadControls } from "./annotations";
import {
  buildComposer,
  closeComposer,
  composerTargetsAnnotation,
  openComposer,
  restoreComposerFocus,
} from "./composer";
import { appGo, fromAppViewport, postToApp } from "./appview";
import {
  firstLine,
  marksFor,
  nextNumber,
  openChangeCount,
  pageGroups,
  pageName,
  placeComposer,
  rowTitle,
  stepFrom,
  stepOrder,
} from "./uilane-derive";
import { uuid } from "./uuid";
import type { AppMode, Rect, UiAnnotationRecord, UiPage, UiTarget } from "./types";

// The UI lane's annotations: Annotate mode, the floating composer on a picked element, the
// sidebar (the "Quiet" list: page groups, one-line rows, a row expands to its thread), and the
// pins the bridge draws. Annotations live on S.state.annotations and save through the reviewer
// slice like comments do. Threads render through the code lane's own thread component, keyed by
// annotation id. The lane gates nothing: no approval, blockers or progress.

const annotationsOf = () => S.state?.annotations ?? [];
const find = (id: string | null) => annotationsOf().find((a) => a.id === id);
const narrow = () => matchMedia("(max-width: 1100px)").matches;

export const openChanges = () => openChangeCount(annotationsOf());

export function setAppMode(mode: AppMode) {
  S.appMode = mode;
  syncBridge();
}
export const toggleAppMode = () => setAppMode(S.appMode === "annotate" ? "interact" : "annotate");

export function toggleAnnotations() {
  S.annotationsOpen = !S.annotationsOpen;
}

// Expand an annotation's row and outline its target, taking the app to its page first. Null
// collapses the row. A reply or edit open in another thread closes.
export function selectAnnotation(id: string | null) {
  const a = find(id);
  if (S.composerAnnotation && S.composerAnnotation !== a?.id) closeComposer();
  S.selectedAnnotation = a?.id ?? null;
  if (a) {
    if (a.status === "resolved") S.shownResolved.add(a.page.route);
    S.annotationsOpen = true;
    if (S.view === "ui" && a.page.route !== S.app.route) appGo(a.page.route);
  }
  renderUiLane();
  if (a)
    requestAnimationFrame(() =>
      $("annotationList")
        .querySelector(`[data-annotation="${a.id}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
}

export function stepAnnotation(dir: 1 | -1) {
  const order = stepOrder(pageGroups(annotationsOf()), S.shownResolved);
  const next = stepFrom(order, S.selectedAnnotation, dir);
  if (next) selectAnnotation(next);
}

// The reviewer clicked an element in Annotate mode: open the floating composer on it. Picking
// again while composing moves the composer to the new element and keeps the text.
export function pickedInApp(page: Omit<UiPage, "url">, target: UiTarget) {
  const ui = S.state.ui;
  if (!ui) return;
  const carried = S.annotationDraft ? S.composerBody : "";
  // A reply or edit elsewhere (or a code comment left open) gives way: one composer at a time.
  if (S.composerOpen && !S.annotationDraft) closeComposer();
  S.annotationDraft = {
    // The dev server's own URL for the page, not the proxy's.
    page: { url: new URL(page.route, ui.target).href, ...page },
    target,
    anchor: target.elements[0]!.rect, // a pick always carries its element (readBridgeMessage)
  };
  openComposer(null, carried);
}

export function movedInApp(rect: Rect) {
  if (!S.annotationDraft) return;
  S.annotationDraft.anchor = rect;
  placeFloatingComposer();
}

// The app loaded a page (`fresh`: a new document, whose bridge has drawn nothing) or moved to
// another route in-page. The pick it was composing on is gone with the old page.
let sentMode = "";
let sentMarks = "";
export function appPageChanged(fresh: boolean) {
  if (fresh) sentMode = sentMarks = "";
  if (S.annotationDraft) closeComposer();
  else renderUiLane();
}

// Tell the bridge the mode and this page's pins, when they changed since it was last told.
export function syncBridge() {
  if (!S.uiProxy || !S.app.connected) return;
  const token = S.uiProxy.token;
  const mode = S.view === "ui" ? S.appMode : "interact";
  if (mode !== sentMode) {
    sentMode = mode;
    postToApp({ type: "mode", token, mode });
  }
  const marks = {
    marks: marksFor(annotationsOf(), S.app.route, S.selectedAnnotation),
    selected: S.selectedAnnotation,
    picking: !!S.annotationDraft,
  };
  const key = JSON.stringify(marks);
  if (key !== sentMarks) {
    sentMarks = key;
    postToApp({ type: "marks", token, ...marks });
  }
}

// Submit the UI lane's open composer (Request change): a new annotation from the floating
// composer, a reply in a thread, or an edited message.
export function submitUiComposer() {
  const body = S.composerBody.trim();
  if (!body) return;
  const now = new Date().toISOString();
  const draft = S.annotationDraft;
  const a = find(S.composerAnnotation);
  if (S.editingCommentId) {
    const m = a?.comments.find((x) => x.id === S.editingCommentId);
    if (m) {
      m.body = body;
      m.updatedAt = now;
    }
    toast("Comment updated");
  } else if (draft) {
    const list = (S.state.annotations ??= []);
    const created: UiAnnotationRecord = {
      id: uuid(),
      number: nextNumber(list),
      intent: "change",
      status: "open",
      placement: "placed",
      page: draft.page,
      target: draft.target,
      comments: [
        { id: uuid(), role: "user", intent: "action", body, createdAt: now, updatedAt: now },
      ],
    };
    list.push(created);
    S.selectedAnnotation = created.id;
    if (!narrow()) S.annotationsOpen = true;
    toast(`#${created.number} added`);
  } else if (a) {
    a.comments.push({
      id: uuid(),
      role: "user",
      intent: "action",
      body,
      createdAt: now,
      updatedAt: now,
    });
    toast("Comment saved");
  }
  closeComposer();
  persist();
}

// An annotation's thread controls: the code lane's thread component, keyed by annotation id.
function threadControls(a: UiAnnotationRecord): ThreadControls {
  return {
    replying: composerTargetsAnnotation(a.id),
    ask: false,
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
      S.composerAnnotation = a.id;
      S.editingCommentId = m.id;
      S.composerBody = m.body;
      S.composerOpen = true;
      renderUiLane();
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
    host.innerHTML = `<p class="ann-empty">No annotations yet. Annotate (⌥A) and click anything in the app.</p>`;
    return;
  }
  host.replaceChildren(
    ...groups.map((g) => {
      const section = document.createElement("section");
      section.className = `ann-page${g.route === S.app.route ? " here" : ""}`;
      const shown = S.shownResolved.has(g.route);
      section.innerHTML =
        `<button class="ann-head" data-route="${esc(g.route)}" title="${esc(g.title ? `${g.title}\n${g.route}` : g.route)}">` +
        `<span class="ann-page-name">${esc(pageName(g.title, g.route))}</span><span class="ann-count">${g.open.length || ""}</span></button>`;
      section.append(...g.open.map(row));
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
}

// One row: the number (tinted by kind) and the body's first line. Selected, it expands to the
// thread, through the code lane's thread component.
function row(a: UiAnnotationRecord): HTMLElement {
  const line = document.createElement("div");
  const selected = a.id === S.selectedAnnotation;
  line.className = `ann-row k-change${a.status === "resolved" ? " resolved" : ""}${selected ? " sel" : ""}`;
  line.dataset.annotation = a.id;
  line.title = rowTitle(a);
  line.innerHTML = `<span class="ann-num">${a.number}</span><span class="ann-body">${esc(firstLine(a.comments[0]?.body ?? ""))}</span>`;
  if (!selected) return line;
  const item = document.createElement("div");
  item.className = "ann-item";
  const thread = document.createElement("div");
  thread.className = `annotation md-thread${a.status === "resolved" ? " resolved" : ""}`;
  thread.append(buildCommentThread(a, threadControls(a)));
  item.append(line, thread);
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
  const el = draft.target.elements[0]!; // a pick always carries its element (readBridgeMessage)
  const label = el.name ? `${el.role ?? el.tag} · "${el.name}"` : (el.role ?? el.tag);
  const head = document.createElement("div");
  head.className = "uc-head";
  head.innerHTML =
    `<span class="uc-num" title="The number it will get">${nextNumber(annotationsOf())}</span>` +
    `<span class="uc-target" title="${esc(el.selector)}">${esc(label)}</span>`;
  const cancel = document.createElement("button");
  cancel.className = "uc-close";
  cancel.title = "Cancel (Esc)";
  cancel.innerHTML = "<kbd>Esc</kbd>";
  cancel.onclick = () => closeComposer();
  head.append(cancel);
  const card = document.createElement("div");
  card.className = "annotation";
  card.append(buildComposer({ ask: false }));
  host.replaceChildren(head, card);
  host.classList.add("show");
  placeFloatingComposer();
}

// Keep the floating composer beside its target as the app scrolls, resizes or changes preset.
// Narrow screens show it as a bottom sheet (CSS), so it isn't placed there.
export function placeFloatingComposer() {
  const host = $("uiComposer");
  const draft = S.annotationDraft;
  if (!draft || matchMedia("(max-width: 700px)").matches) return;
  const target = fromAppViewport(draft.anchor);
  const stage = $("appStage").getBoundingClientRect();
  if (!target || !stage.width) return;
  const { left, top } = placeComposer(
    target,
    { width: host.offsetWidth, height: host.offsetHeight },
    stage,
  );
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

// The Send dialog's UI line: what goes, and what doesn't.
export function uiSendSummary() {
  const list = annotationsOf();
  const open = list.filter((a) => a.status === "open" && a.intent === "change");
  const pages = new Set(open.map((a) => a.page.route)).size;
  const resolved = list.filter((a) => a.status === "resolved").length;
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  return {
    ui: open.length
      ? `${n(open.length, "change request")} on ${n(pages, "page")}`
      : "No change requests",
    uiNotSent: resolved ? `Not sent: ${resolved} resolved` : "",
  };
}

export function installUiLane() {
  $("annotationList").addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    // The thread's own buttons are wired by the thread component.
    if (!t || t.closest(".comment-box")) return;
    const rowEl = t.closest<HTMLElement>("[data-annotation]");
    if (rowEl) {
      const id = rowEl.dataset.annotation ?? null;
      selectAnnotation(id === S.selectedAnnotation ? null : id);
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
