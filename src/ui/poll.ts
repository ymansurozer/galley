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
function splitDeskStatus<T>(payload: T & Partial<DeskStatus>) {
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
  return {
    server: server as T,
    status: {
      agentActivity,
      agentListening,
      agentRecentlyActive,
      queuedQuestions,
      queuedReviews,
      uiProxy,
      reloadGeneration,
      uiRefreshGeneration,
    },
  };
}

export function adoptDeskStatus<T>(payload: T & Partial<DeskStatus>): T {
  const {
    server,
    status: {
      agentActivity,
      agentListening,
      agentRecentlyActive,
      queuedQuestions,
      queuedReviews,
      uiProxy,
      reloadGeneration,
      uiRefreshGeneration,
    },
  } = splitDeskStatus(payload);
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
  return server;
}

// Only changes that can invalidate full-state work belong here. Presence, names and replies
// keep arriving on lite polls while a large snapshot transfers; they must not starve adoption.
function stateRevision(payload: PollPayload & Partial<DeskStatus>): string {
  return JSON.stringify([
    payload.uiProxy ?? null,
    payload.ui ?? null,
    payload.reloadGeneration ?? 0,
    payload.uiRefreshGeneration ?? 0,
    payload.baseDiffHash,
    payload.guide ?? null,
  ]);
}

let latestPoll: { revision: string; lite: PollPayload } | undefined;
let fullStateRequest: { revision: string } | undefined;

// The 1.5s tick hits /api/poll — a slice of hash + guide + comments + names + liveness. The
// full ReviewState (file contents for the whole diff; >100 MB on a big monorepo PR)
// is fetched from /api/state only when baseDiffHash moves: polling it every tick kept
// the desk process pinned serializing it and the tab pinned re-parsing it.
let pollSequence = 0;
let adoptedPoll = 0;
export async function pollState() {
  const sequence = ++pollSequence;
  // Transient status follows response sequence. Full-state work follows content revision:
  // another lite tick for the same revision neither cancels it nor starts a duplicate fetch.
  const superseded = () => sequence < adoptedPoll;
  let lite: PollPayload | undefined;
  try {
    const payload = await api<PollPayload & DeskStatus>("/api/poll");
    if (payload && Array.isArray(payload.comments)) {
      if (superseded()) return;
      adoptedPoll = sequence;
      lite = adoptDeskStatus(payload);
      const revision = stateRevision(payload);
      if (revision !== latestPoll?.revision) fullStateRequest = undefined;
      latestPoll = { revision, lite };
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
  const diffChanged = lite.baseDiffHash !== S.lastBaseDiffHash;
  const guideChanged = JSON.stringify(lite.guide ?? null) !== JSON.stringify(S.state.guide ?? null);
  let server: ReviewState | undefined;
  if (diffChanged || guideChanged) {
    // The reload branch replaces S.state wholesale and re-renders, which would clobber local
    // decisions/comments not yet persisted and rebuild the diff DOM out from under an open
    // composer (losing in-progress typing). Defer while a save is busy OR a composer is open —
    // S.lastBaseDiffHash stays put, and the next tick re-detects the changed hash and adopts
    // once the save has drained and the composer has closed. This only narrows a race that
    // already existed (fire-and-forget persist could lose the same way). Scoping the composer
    // guard here (not at the top) keeps liveness/presence and the additive agent-reply comment
    // merge running every tick while a reply box is open, so the desk never looks dead.
    if (diffChanged && (saver.isBusy() || S.composerOpen)) return;
    if (fullStateRequest?.revision === latestPoll!.revision) return;
    const request = { revision: latestPoll!.revision };
    const state = S.state;
    const saveGeneration = saver.generation();
    fullStateRequest = request;
    try {
      const payload = await api<ReviewState & DeskStatus>("/api/state");
      if (
        fullStateRequest !== request ||
        latestPoll!.revision !== request.revision ||
        stateRevision(payload) !== request.revision ||
        S.state !== state ||
        // Reviewer saves mutate in place and can finish during the transfer. Being idle now
        // cannot prove this snapshot includes them (including a save still waiting to dispatch).
        saver.generation() !== saveGeneration
      )
        return;
      // Lite polls own transient status. A matching full snapshot can carry older liveness
      // and replies, so strip its status and finish against the latest matching lite poll.
      server = splitDeskStatus(payload).server;
      lite = latestPoll!.lite;
    } catch {
      return;
    } finally {
      if (fullStateRequest === request) fullStateRequest = undefined;
    }
  }
  if (diffChanged) {
    if (!server || !Array.isArray(server.comments)) return;
    if (saver.isBusy() || S.composerOpen) return;
    // Newer matching lite polls can bring names and agent replies during the transfer.
    // Carry them into the adopted snapshot without taking its older transient status.
    server.project = lite.project;
    server.branch = lite.branch;
    const ids = new Set(server.comments.map((c) => c.id));
    server.comments.push(...lite.comments.filter((c) => !ids.has(c.id)));
    mergeAgentReplies(server.annotations ?? [], lite.annotations ?? []);
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
  if (guideChanged) {
    // The new guide restamped which blocks its parts and skims claim, server-side; those stamps
    // ride the changes, so take them off the full state (fetched only on a swap — the diff is the
    // same). A diff that moved meanwhile waits for the next tick's full adoption above.
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
