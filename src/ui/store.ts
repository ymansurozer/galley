import Alpine from "alpinejs";
import type {
  DiffHolder,
  ReviewRead,
  ReviewState,
  ReviewerDelta,
  ReviewerSave,
  SaveAnswer,
  SaveStamp,
  Store,
} from "./types";
import { loadSettings } from "./settings";
import { createSaver, reviewerSlice } from "./save";
import {
  applyReviewerChanges,
  copyOf,
  noChanges,
  reviewerChanges,
  stampDecisions,
} from "./review-delta-derive";
import { keepPlacements, mergeAgentReplies } from "./uilane-derive";

// Single reactive source of truth: the imperative diff island mutates it directly,
// and the Alpine-driven chrome (tree, toolbar, composer, modals, toast) renders from it.
// `state` is null until the initial fetch in main.ts; everything that reads it runs
// post-init (treeRows guards for the brief pre-init window the template may render in).
export const S: Store = Alpine.reactive<Store>({
  state: null as unknown as Store["state"],
  projectFiles: [],
  expandedDirs: new Set<string>(),
  collapsedDirs: new Set<string>(),
  // Display preferences come from ~/.galley/settings.json (fetched in main.ts init),
  // not localStorage — origins change with the random port, files don't.
  diffStyle: "split",
  fileIndex: 0,
  stepPart: undefined,
  preview: null,
  rendering: false,
  awaitingAgent: false,
  agentActivity: null,
  agentTrail: [],
  undeliveredAsks: new Set(),
  agentListening: false,
  agentRecentlyActive: false,
  queuedQuestions: 0,
  queuedReviews: 0,
  presence: { kind: "hidden", line: "" },
  reviewDone: false,
  requests: [],
  lastBaseDiffHash: null,
  selected: { side: "additions", lineNumber: 1 },
  // chrome UI flags (templates bind to these)
  composerOpen: false,
  toastMsg: "",
  toastAction: "",
  toastKeys: "",
  golineBuffer: "",
  composerBody: "",
  editingCommentId: null,
  settings: loadSettings(),
  settingsOpen: false,
  settingsTab: "settings",
  confirmMsg: "",
  sendOpen: false,
  sendMsg: "",
  sendNotSent: "",
  sendNote: "",
  sendFinishing: false,
  sending: false,
  sendFailed: false,
  reach: null,
  overviewOpen: false,
  sidebarTab: "tree",
  requestsOpen: false,
  openThread: null,
  treeDrawerOpen: false,
  sidebarCollapsed: false,
  fileView: "rendered",
  skimExpanded: new Set<string>(),
  loadedOversized: new Set<string>(),
  view: "code",
  ready: false,
  uiProxy: null,
  reloadGeneration: 0,
  uiRefreshGeneration: null,
  app: {
    loaded: false,
    route: "/",
    title: "",
    connected: false,
    canGoBack: null,
    canGoForward: null,
    stale: false,
  },
  viewport: "fit",
  frameLabel: "",
  appMode: "interact",
  pendingPicks: 0,
  selectedAnnotation: null,
  lookedFor: new Set<string>(),
  annotationDraft: null,
  composerAnnotation: null,
  sendLanes: null,
  shotView: null,
});

// Imperative-island objects kept OUT of the reactive store: the @pierre/diffs
// classes/instance and parsed fileDiff do internal element/identity checks that
// an Alpine reactive Proxy breaks (e.g. ResizeManager ownership). Plain object.
export const D: DiffHolder = {
  // null until difflib.ts wires them at import (before any render); cast so the
  // hot-path call sites don't each need a non-null assertion.
  FileDiff: null as unknown as DiffHolder["FileDiff"],
  parseDiffFromFile: null as unknown as DiffHolder["parseDiffFromFile"],
  processFile: null as unknown as DiffHolder["processFile"],
  diffAcceptRejectHunk: null as unknown as DiffHolder["diffAcceptRejectHunk"],
  instance: null,
  diffCache: new Map(),
  fileDiff: null,
  rawFileDiff: null,
  lineMap: null,
};

export const $ = (id: string) => document.getElementById(id) as HTMLElement;
export function show(e: Element) {
  e.classList.add("show");
}
export function hide(e: Element) {
  e.classList.remove("show");
}
let toastTimer: ReturnType<typeof setTimeout>;
let toastRun: (() => void) | null = null;
// An action toast ("Reset review · Undo") stays up long enough to reach its button, as does a
// message too long to read in the default time (`ms`). The next toast replaces it, action and all,
// so an action never outlives the moment it answers. A toast that names a shortcut passes it as
// keys, drawn as keycaps after the text.
const LONG_TOAST_MS = 6000;
export function toast(
  t: string,
  action?: { label: string; run: () => void },
  keys = "",
  ms = action ? LONG_TOAST_MS : 2800,
) {
  S.toastMsg = t;
  S.toastKeys = keys;
  S.toastAction = action?.label ?? "";
  toastRun = action?.run ?? null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(clearToast, ms);
}
function clearToast() {
  S.toastMsg = S.toastAction = S.toastKeys = "";
  toastRun = null;
}
export function runToastAction() {
  const run = toastRun;
  clearTimeout(toastTimer);
  clearToast();
  run?.();
}
export { esc } from "./html";
export const api = <T = unknown>(path: string, opts: RequestInit = {}): Promise<T> =>
  fetch(path, { headers: { "content-type": "application/json" }, ...opts }).then(
    (r) => r.json() as Promise<T>,
  );
// Open a repo-relative file at a line in the reviewer's editor (the command is a Settings
// preference). The code lane's open-in-editor and the UI lane's source links both come here.
export async function openEditorAt(path: string, lineNumber: number) {
  try {
    const res = await api<{ ok?: boolean; error?: string }>("/api/open-editor", {
      method: "POST",
      body: JSON.stringify({ path, lineNumber }),
    });
    if (!res.ok) toast(res.error || "Could not open editor");
  } catch {
    toast("Could not open editor");
  }
}
// What this tab has adopted of the desk, stamped on every save and Send (types.ts, SaveStamp).
export const saveStamp = (): SaveStamp => ({
  token: S.uiProxy?.token ?? null,
  reloadGeneration: S.reloadGeneration,
  baseDiffHash: S.state.baseDiffHash,
});
// The last time the desk answered this tab at all (a poll, a save, an error answer included): what
// tells an unreachable desk from one that answers but can't save (reach-derive.ts).
let lastAnswerAt = Date.now();
export const noteAnswer = () => {
  lastAnswerAt = Date.now();
};
export const lastAnswer = () => lastAnswerAt;
// The desk kept its own verdicts over a save or Send made on a diff it can no longer place them on
// (types.ts, SaveAnswer). The tab takes the desk's review on the next poll, as it would anyway; the
// notice says so, and that adoption leaves it up rather than replacing it with "Diff updated".
const UNPLACED_MS = 10_000;
let unplacedUntil = 0;
export const unplacedShowing = () => Date.now() < unplacedUntil;
export function noteUnplaced(answer: Partial<SaveAnswer> | null) {
  if (!answer?.unplaced) return;
  unplacedUntil = Date.now() + UNPLACED_MS;
  toast(
    "Decisions and sign-offs made on an older diff couldn't be carried over. Comments were saved; the desk's review is shown.",
    undefined,
    "",
    UNPLACED_MS,
  );
}
// Post the reviewer's work (a save or a Send) to the desk: its answer, or null when none came.
// A request can hang with no error (a network gone under a sleeping laptop) until the browser
// gives it up, minutes later; the saver would sit in flight and send nothing again meanwhile. So
// an attempt that hasn't answered within ATTEMPT_MS is given up as unanswered. A late duplicate of
// a save is harmless: the desk applies its changes by key, so twice leaves what once does.
const ATTEMPT_MS = 25_000;
export async function postToDesk(
  path: "/api/save" | "/api/send",
  payload: unknown,
): Promise<{ ok: boolean; answer: Partial<SaveAnswer> | null } | null> {
  const abort = new AbortController();
  const limit = setTimeout(() => abort.abort(), ATTEMPT_MS);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    noteAnswer();
    const answer = (await res.json().catch(() => null)) as Partial<SaveAnswer> | null;
    return { ok: res.ok, answer };
  } catch {
    return null;
  } finally {
    clearTimeout(limit);
  }
}

// The reviewer-owned fields as the desk last confirmed them, with their save number and the diff
// they're keyed to. A save sends what the tab changed since this copy (types.ts, ReviewerChanges),
// worked out when it is sent, so a save retried after an outage carries everything since. Until
// the boot sets it, it is empty: a save then sends every record as changed.
let confirmed: { saveNumber: number; review: ReviewerSave; diff: string } = {
  saveNumber: 0,
  review: { comments: [], reviewedFiles: [] },
  diff: "",
};
// The tab took the desk's review whole: at boot, a new diff's, a reset's.
export function confirmDesk(state: ReviewState) {
  confirmed = {
    saveNumber: state.saveNumber ?? 0,
    review: copyOf(reviewerSlice(state)),
    diff: state.baseDiffHash,
  };
}
// What a save or Send is out with: the copy its changes were taken from, kept until it answers.
type Outgoing = { body: ReviewerDelta; sent: ReviewerSave; diff: string };
const outgoing = new Set<Outgoing>();
// The save number of the confirmed copy: the poll reads the desk's review (/api/review) once the
// desk's is past it.
export const confirmedNumber = () => confirmed.saveNumber;
// A save or Send is out, its answer not in yet.
export const postsOut = () => outgoing.size > 0;
// Another tab's save landed and this tab, holding nothing unsaved, read the desk's review: it
// becomes the tab's reviewer-owned fields and the confirmed copy, with each block's status from its
// decision. The tab's own placements are kept over the desk's, as a new diff's adoption keeps them,
// and go out as its reports. A read for another diff, or no newer than the copy, is not taken.
// The agent's replies a newer poll brought in while the read was out (they move no save number)
// stay: the read takes them, so the confirmed copy holds them too and no save sends them back.
export function takeDeskReview(read: ReviewRead): boolean {
  if (read.baseDiffHash !== S.state.baseDiffHash) return false;
  if (confirmed.diff === read.baseDiffHash && read.saveNumber <= confirmed.saveNumber) return false;
  const have = new Set(read.review.comments.map((c) => c.id));
  read.review.comments.push(
    ...S.state.comments.filter((c) => c.role === "agent" && !have.has(c.id)),
  );
  mergeAgentReplies(read.review.annotations ?? [], S.state.annotations ?? []);
  confirmed = { saveNumber: read.saveNumber, review: copyOf(read.review), diff: read.baseDiffHash };
  keepPlacements(read.review.annotations ?? [], S.state.annotations ?? []);
  Object.assign(S.state, read.review);
  stampDecisions(S.state.changes, S.state.decisions ?? []);
  return true;
}
// The tab took records from the desk outside a save's answer (an agent reply off the poll, the
// placements a reload reset): `take` applies them to the confirmed copy and to every copy a save is
// out with, as it did to the tab's own. They're the desk's, and no save sends them back as the
// reviewer's.
export function takenFromDesk(take: (review: ReviewerSave) => void) {
  take(confirmed.review);
  for (const out of outgoing) take(out.sent);
}
function dispatch(): Outgoing {
  const sent = copyOf(reviewerSlice(S.state));
  const body = {
    base: confirmed.saveNumber,
    changes: reviewerChanges(confirmed.review, sent),
    seen: saveStamp(),
  };
  return { body, sent, diff: S.state.baseDiffHash };
}
// Set by main.ts: redraw once a save's answer replaced the tab's reviewer-owned fields.
let redraw = () => {};
export const onDeskMerge = (run: () => void) => {
  redraw = run;
};
// A save or Send landed: what it sent is what the desk has now confirmed. When other saves landed
// before it, the answer carries the desk's merged review: the tab takes it and puts back over it
// whatever the reviewer changed since the save was sent. An answer from before the copy the tab
// holds (a Send and a save out at once), or for a diff the tab has since left, changes nothing.
function landed(out: Outgoing, answer: Partial<SaveAnswer>) {
  const number = answer.saveNumber ?? confirmed.saveNumber;
  if (S.state.baseDiffHash !== out.diff) return;
  if (confirmed.diff === out.diff && number < confirmed.saveNumber) return;
  if (!answer.merged) {
    confirmed = { saveNumber: number, review: out.sent, diff: out.diff };
    return;
  }
  const since = reviewerChanges(out.sent, reviewerSlice(S.state));
  confirmed = { saveNumber: number, review: copyOf(answer.merged), diff: out.diff };
  Object.assign(S.state, applyReviewerChanges(answer.merged, since));
  // What the merged review brought in is the desk's, as a poll's records are (takenFromDesk): every
  // other copy still out takes it under the reviewer's own changes, from that copy's send to this
  // one's, so no later answer counts it as the reviewer's and puts it back over a newer desk record.
  for (const other of outgoing)
    if (other !== out)
      other.sent = applyReviewerChanges(answer.merged, reviewerChanges(out.sent, other.sent));
  stampDecisions(S.state.changes, S.state.decisions ?? []);
  redraw();
}
// Post a save or Send carrying the reviewer's changes: the desk's answer, or null when none came,
// and the confirmed copy moved on when it landed (`landedIf` says what landing takes).
async function postChanges(
  out: Outgoing,
  path: "/api/save" | "/api/send",
  extra: Record<string, unknown>,
  landedIf: (answer: Partial<SaveAnswer>) => boolean,
) {
  outgoing.add(out);
  try {
    const reply = await postToDesk(path, { ...out.body, ...extra });
    if (reply?.ok && reply.answer && landedIf(reply.answer)) landed(out, reply.answer);
    return reply;
  } finally {
    outgoing.delete(out);
  }
}
// Send takes the same changes as a save, with the note, and always posts (send.ts).
export const postSend = (overallNote: string) =>
  postChanges(dispatch(), "/api/send", { overallNote }, (answer) => answer.sent === true);
// A save has landed only on a 2xx answer whose body says ok; anything else, no answer included,
// leaves it unsaved and the saver retries (save.ts). Nothing changed since the confirmed copy
// sends nothing, and has landed.
async function postSave(out: Outgoing): Promise<boolean> {
  if (noChanges(out.body.changes)) return true;
  const reply = await postChanges(out, "/api/save", {}, (answer) => answer.ok === true);
  if (!reply?.ok || reply.answer?.ok !== true) return false;
  noteUnplaced(reply.answer);
  return true;
}
// Saves coalesce so rapid approvals don't saturate connections; each attempt works out its changes
// as it goes out (save.ts calls dispatch at send time).
export const saver = createSaver(dispatch, postSave);
// Instant auto-save: there is no manual Save button, so every state mutation
// (decision, comment, stage/unstage, approval) MUST call persist() to write the
// review to ~/.galley/<repoHash>/<session>/. Saves coalesce (see save.ts): at most one
// in flight, rapid triggers collapse into a single trailing save.
export const persist = () => saver.trigger();
// What the app page reports (where it found the annotations) saves at most once a second, or with
// the reviewer's next save if that comes first (save.ts, triggerSoon).
export const persistSoon = () => saver.triggerSoon();
// Display preferences (settings panel + the Split/Stacked toggle) save to the global
// ~/.galley/settings.json so they survive port/session changes. Last write wins.
export const persistPrefs = () =>
  api("/api/settings", {
    method: "POST",
    body: JSON.stringify({ settings: S.settings, diffStyle: S.diffStyle }),
  }).catch(() => {});
