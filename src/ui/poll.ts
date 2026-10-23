import { S, D, api, toast, saver } from "./store";
import { render } from "./render";
import { currentPartTitle, reseatStep } from "./guide";
import { refreshBaseTitle, updateProgress } from "./progress";
import { updateAwaitingDom } from "./annotations";
import { adoptUiStatus, adoptUiTarget, applyPendingUiRefresh, syncView } from "./appview";
import { renderUiLane } from "./uilane";
import { keepPlacements, mergeAgentReplies } from "./uilane-derive";
import { recordActivity } from "./thread-derive";
import type { DeskStatus, PollPayload, ReviewState } from "./types";

// Pull the transient DeskStatus fields off a server payload into the store and
// return the rest. They must never enter S.state: persist() posts S.state back
// to /api/save, and the persisted review must not carry desk liveness.
export function adoptDeskStatus<T>(payload: T & Partial<DeskStatus>): T {
  const {
    agentActivity,
    agentListening,
    agentRecentlyActive,
    queuedQuestions,
    queuedReviews,
    uiProxy,
    reloadGeneration,
    uiRefreshGeneration,
    ...server
  } = payload;
  S.agentActivity = agentActivity?.body ?? null;
  S.agentTrail = recordActivity(S.agentTrail, agentActivity ?? null, new Date().toISOString());
  S.agentListening = agentListening ?? false;
  S.agentRecentlyActive = agentRecentlyActive ?? false;
  S.queuedQuestions = queuedQuestions ?? 0;
  S.queuedReviews = queuedReviews ?? 0;
  // `galley reload` is the agent back from a Send, even when the diff didn't move (a UI-only desk
  // has none), so Send is open again.
  if (adoptUiStatus(uiProxy ?? null, reloadGeneration ?? 0, uiRefreshGeneration ?? 0))
    S.awaitingAgent = false;
  return server as T;
}

// The 1.5s tick hits /api/poll — a slice of hash + guide + comments + names + liveness. The
// full ReviewState (file contents for the whole diff; >100 MB on a big monorepo PR)
// is fetched from /api/state only when baseDiffHash moves: polling it every tick kept
// the desk process pinned serializing it and the tab pinned re-parsing it.
export async function pollState() {
  let lite: PollPayload | undefined;
  try {
    const payload = await api<PollPayload & DeskStatus>("/api/poll");
    if (payload && Array.isArray(payload.comments)) {
      lite = adoptDeskStatus(payload);
      // Activity/presence changes alone don't warrant a render — patch the
      // waiting indicators in place every tick.
      updateAwaitingDom();
    }
  } catch {
    return;
  }
  if (!lite || !Array.isArray(lite.comments)) return;
  // `galley ui <url>` on the live desk: no diff change, so it rides the lite poll.
  adoptUiTarget(lite.ui);
  applyPendingUiRefresh();
  if (lite.baseDiffHash !== S.lastBaseDiffHash) {
    // The reload branch replaces S.state wholesale and re-renders, which would clobber local
    // decisions/comments not yet persisted and rebuild the diff DOM out from under an open
    // composer (losing in-progress typing). Defer while a save is busy OR a composer is open —
    // S.lastBaseDiffHash stays put, and the next tick re-detects the changed hash and adopts
    // once the save has drained and the composer has closed. This only narrows a race that
    // already existed (fire-and-forget persist could lose the same way). Scoping the composer
    // guard here (not at the top) keeps liveness/presence and the additive agent-reply comment
    // merge running every tick while a reply box is open, so the desk never looks dead.
    if (saver.isBusy() || S.composerOpen) return;
    // The diff moved — now (and only now) pull the full state.
    let server: ReviewState | undefined;
    try {
      server = adoptDeskStatus(await api<ReviewState & DeskStatus>("/api/state"));
    } catch {
      return;
    }
    if (!server || !Array.isArray(server.comments)) return;
    S.lastBaseDiffHash = server.baseDiffHash;
    // Keep the reviewer on the same file across a reload. File order/membership can change (the
    // agent added, removed, or reordered files), so re-find the current path in the new list
    // rather than trusting the numeric index — otherwise the shown file, and guided auto-advance
    // (which resolves "next" from the current index), silently jump to whatever now sits there.
    // The part is re-found the same way, by title, since the guide's indices can move too.
    const curPath = S.state?.files?.[S.fileIndex]?.path;
    const curTitle = currentPartTitle();
    keepPlacements(server.annotations ?? [], S.state.annotations ?? []);
    S.state = server;
    refreshBaseTitle();
    D.fileDiff = D.rawFileDiff = null;
    const remapped = curPath ? S.state.files.findIndex((f) => f.path === curPath) : -1;
    if (remapped >= 0) S.fileIndex = remapped;
    else if (S.fileIndex >= S.state.files.length) S.fileIndex = 0;
    reseatStep(remapped >= 0 ? S.stepPart : undefined, curTitle);
    S.awaitingAgent = false;
    // A diff that appeared (or emptied) makes a UI-only desk combined (or back).
    syncView();
    // The diff changed (e.g. a reload added files) — refresh the project listing too so
    // the tree reflects newly tracked files, not the listing fetched at startup.
    api<{ files?: string[] }>("/api/tree")
      .then((r) => {
        if (r.files) S.projectFiles = r.files;
      })
      .catch(() => {});
    render();
    toast("Diff updated");
    return;
  }
  // A reload can swap the guide without changing the diff (agent regenerated it) —
  // adopt it even when baseDiffHash is unchanged. Guides are small; the compare is cheap.
  if (JSON.stringify(lite.guide ?? null) !== JSON.stringify(S.state.guide ?? null)) {
    // The new guide restamped which blocks its parts and skims claim, server-side; those stamps
    // ride the changes, so take them off the full state (fetched only on a swap — the diff is the
    // same). A diff that moved meanwhile waits for the next tick's full adoption above.
    let server: ReviewState | undefined;
    try {
      server = adoptDeskStatus(await api<ReviewState & DeskStatus>("/api/state"));
    } catch {
      return;
    }
    if (!server?.changes || server.baseDiffHash !== S.lastBaseDiffHash) return;
    const title = currentPartTitle();
    const stamped = new Map(server.changes.map((c) => [c.id, c]));
    for (const c of S.state.changes) {
      c.part = stamped.get(c.id)?.part;
      c.skim = stamped.get(c.id)?.skim;
    }
    S.state.guide = server.guide;
    reseatStep(S.stepPart, title);
    render();
    toast("Guide updated");
  }
  // A branch switch can leave the diff unchanged too (`git checkout -b` keeps the working tree), so
  // the names the header and tab title show ride the lite poll.
  if (lite.project !== S.state.project || lite.branch !== S.state.branch) {
    S.state.project = lite.project;
    S.state.branch = lite.branch;
    refreshBaseTitle();
    updateProgress();
  }
  const localIds = new Set(S.state.comments.map((c) => c.id));
  const incoming = lite.comments.filter((c) => !localIds.has(c.id));
  S.state.comments.push(...incoming);
  // The agent's replies in UI annotation threads (`galley comment --ui`) join the same way; a save
  // from this tab before they arrive keeps them on the server (mergeReviewerSave).
  const uiReplies = mergeAgentReplies(S.state.annotations ?? [], lite.annotations ?? []);
  if (uiReplies || incoming.some((c) => c.role === "agent")) S.awaitingAgent = false;
  // render() redraws the UI lane too.
  if (incoming.length) render();
  else if (uiReplies) renderUiLane();
}
