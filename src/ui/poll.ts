import { S, D, api, toast, saver } from "./store";
import { render } from "./render";
import { updateAwaitingDom } from "./annotations";
import type { DeskStatus, PollPayload, ReviewState } from "./types";

// Pull the transient DeskStatus fields off a server payload into the store and
// return the rest. They must never enter S.state: persist() posts S.state back
// to /api/save, and the persisted review must not carry desk liveness.
export function adoptDeskStatus<T>(payload: T & Partial<DeskStatus>): T {
  const { agentActivity, agentListening, queuedQuestions, queuedReviews, ...server } = payload;
  S.agentActivity = agentActivity?.body ?? null;
  S.agentListening = agentListening ?? false;
  S.queuedQuestions = queuedQuestions ?? 0;
  S.queuedReviews = queuedReviews ?? 0;
  return server as T;
}

// The 1.5s tick hits /api/poll — a slice of hash + guide + comments + liveness. The
// full ReviewState (file contents for the whole diff; >100 MB on a big monorepo PR)
// is fetched from /api/state only when baseDiffHash moves: polling it every tick kept
// the desk process pinned serializing it and the tab pinned re-parsing it.
export async function pollState() {
  if (S.composerOpen) return;
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
  if (lite.baseDiffHash !== S.lastBaseDiffHash) {
    // The reload branch replaces S.state wholesale, which would clobber local decisions/
    // comments not yet persisted. A coalesced save can leave a trailing write outstanding,
    // so skip adopting while a save is busy — S.lastBaseDiffHash stays put, and the next
    // tick re-detects the changed hash and adopts once the save has drained. This only
    // narrows a race that already existed (fire-and-forget persist could lose the same way).
    if (saver.isBusy()) return;
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
    const curPath = S.state?.files?.[S.fileIndex]?.path;
    S.state = server;
    D.fileDiff = null;
    const remapped = curPath ? S.state.files.findIndex((f) => f.path === curPath) : -1;
    if (remapped >= 0) S.fileIndex = remapped;
    else if (S.fileIndex >= S.state.files.length) S.fileIndex = 0;
    S.awaitingAgent = false;
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
    S.state.guide = lite.guide;
    render();
    toast("Guide updated");
  }
  const localIds = new Set(S.state.comments.map((c) => c.id));
  const incoming = lite.comments.filter((c) => !localIds.has(c.id));
  if (!incoming.length) return;
  S.state.comments.push(...incoming);
  if (incoming.some((c) => c.role === "agent")) {
    S.awaitingAgent = false;
    toast("Agent replied");
  }
  render();
}
