import { S, $, openEditorAt, toast, persist, saver } from "./store";
import { buildCommentThread, type ThreadControls } from "./annotations";
import {
  buildComposer,
  closeComposer,
  composerInUi,
  composerTargetsAnnotation,
  openComposer,
  restoreComposerFocus,
} from "./composer";
import { appGo, captureApp, fromAppViewport, postToApp } from "./appview";
import {
  annotationSource,
  isWaiting,
  marksFor,
  nextNumber,
  openChangeCount,
  pageGroups,
  placeComposer,
  sourcePlace,
  stepFrom,
  stepOrder,
  waitingCount,
} from "./uilane-derive";
import {
  composerHead,
  pageHead,
  rowLine,
  shotLink,
  sourceLink,
  type ShotStatus,
} from "./uilane-dom";
import { uuid } from "./uuid";
import type { AnnotationDraft, AppMode, Rect, UiAnnotationRecord, UiPage, UiTarget } from "./types";

// The UI lane's annotations: Annotate mode, the floating composer on a picked element, the
// sidebar (the "Quiet" list: page groups, one-line rows, a row expands to its thread), and the
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

// Expand an annotation's row and outline its target, taking the app to its page first. Null
// collapses the row. A reply or edit open in another thread is set aside with its text.
export function selectAnnotation(id: string | null) {
  const a = find(id);
  if (S.composerAnnotation && S.composerAnnotation !== a?.id) setUiComposerAside();
  S.selectedAnnotation = a?.id ?? null;
  if (a) {
    if (a.status === "resolved") S.shownResolved.add(a.page.route);
    S.annotationsOpen = true;
    if (S.view === "ui" && a.page.route !== S.app.route) appGo(a.page.route);
  }
  if (!a || S.composerOpen || !resumeThreadDraft(a.id)) renderUiLane();
  if (a)
    requestAnimationFrame(() =>
      $("annotationList")
        .querySelector(`[data-annotation="${CSS.escape(a.id)}"]`)
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
  pickDraft = null;
  if (S.annotationDraft) closeComposer();
  else renderUiLane();
}

// Tell the bridge the mode and this page's pins, when they changed since it was last told.
export function syncBridge() {
  if (!S.uiProxy || !S.app.connected) return;
  const token = S.uiProxy.token;
  const mode = appModeNow();
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

// Screenshots of new annotations still being captured or uploaded, and why a capture failed. Both
// are this tab's alone: after a reload, an annotation without stored screenshots reads as failed.
const capturing = new Set<string>();
const captureErrors = new Map<string, string>();

const shotStatus = (a: UiAnnotationRecord): ShotStatus =>
  capturing.has(a.id) ? "capturing" : a.screenshots ? "stored" : "failed";

// Screenshot the page for a new annotation, as the reviewer marked it: the bridge renders the
// viewport and a crop around the target, with the annotation's mark drawn on, and the tab uploads
// both once the annotation's save has landed (the desk takes screenshots only for a saved
// annotation). Nothing waits on it. The row reads "capturing…" until both are stored, else
// "capture failed", and the annotation stands either way: it's sent without screenshots.
async function captureScreenshots(a: UiAnnotationRecord) {
  capturing.add(a.id);
  try {
    // Two frames first, so the closed composer and the new row are painted before the render,
    // which can keep the page busy for seconds.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const shot = await captureApp({
      selector: a.target.elements[0]!.selector, // an annotation always has an element (readPicked)
      mark: { number: a.number, question: a.intent === "question" },
    });
    if (!shot.crop) throw new Error("the annotated element wasn't on screen");
    await saver.settled();
    for (const [kind, png] of [
      ["crop", shot.crop],
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
  } catch (err) {
    captureErrors.set(a.id, err instanceof Error ? err.message : String(err));
  } finally {
    capturing.delete(a.id);
    renderUiLane();
  }
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
  if (created) void captureScreenshots(created);
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
}

// One row: the number (tinted by kind) and the body's first line. Selected, it expands to the
// thread, through the code lane's thread component.
function row(a: UiAnnotationRecord): HTMLElement {
  const selected = a.id === S.selectedAnnotation;
  const line = rowLine(document, a, selected);
  if (!selected) return line;
  const item = document.createElement("div");
  item.className = "ann-item";
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
  item.append(ctx);
  const thread = document.createElement("div");
  thread.className = `annotation md-thread${a.status === "resolved" ? " resolved" : ""}`;
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
  const el = draft.target.elements[0]!; // a pick always carries its element (readBridgeMessage)
  const head = composerHead(document, el, upcomingNumber(), () => closeComposer());
  const parts: HTMLElement[] = [head];
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

// The Send dialog's UI line: what goes (open change requests, and questions still waiting, which go
// as openQuestions), and what doesn't (resolved annotations, answered questions).
export function uiSendSummary() {
  const list = annotationsOf();
  const open = list.filter((a) => a.status === "open" && a.intent === "change");
  const pages = new Set(open.map((a) => a.page.route)).size;
  const waiting = waitingCount(list);
  const answered = list.filter(
    (a) => a.status === "open" && a.intent === "question" && !isWaiting(a),
  ).length;
  const resolved = list.filter((a) => a.status === "resolved").length;
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? "" : "s"}`;
  const notSent = [
    resolved ? `${resolved} resolved` : "",
    answered ? n(answered, "answered question") : "",
  ].filter(Boolean);
  return {
    ui:
      [
        open.length ? `${n(open.length, "change request")} on ${n(pages, "page")}` : "",
        waiting ? n(waiting, "open question") : "",
      ]
        .filter(Boolean)
        .join(" · ") || "No change requests",
    uiNotSent: notSent.length ? `Not sent: ${notSent.join(" · ")}` : "",
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
