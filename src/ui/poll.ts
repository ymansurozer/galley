import { S, D, api, toast } from "./store";
import { render } from "./render";
import { updateAwaitingDom } from "./annotations";
import type { DeskStatus, ReviewState } from "./types";

// Pull the transient DeskStatus fields off a /api/state payload into the store and
// return the bare ReviewState. They must never enter S.state: persist() posts
// S.state back to /api/save, and the persisted review must not carry desk liveness.
export function adoptDeskStatus(payload: ReviewState & Partial<DeskStatus>): ReviewState {
  const { agentActivity, agentListening, queuedQuestions, queuedReviews, ...server } = payload;
  S.agentActivity = agentActivity?.body ?? null;
  S.agentListening = agentListening ?? false;
  S.queuedQuestions = queuedQuestions ?? 0;
  S.queuedReviews = queuedReviews ?? 0;
  return server;
}

export async function pollState() {
  if (S.composerOpen || S.popoverOpen) return;
  let server: ReviewState | undefined;
  try {
    const payload = await api<ReviewState & DeskStatus>("/api/state");
    if (payload && Array.isArray(payload.comments)) {
      server = adoptDeskStatus(payload);
      // Activity/presence changes alone don't warrant a render — patch the
      // waiting indicators in place every tick.
      updateAwaitingDom();
    }
  } catch {
    return;
  }
  if (!server || !Array.isArray(server.comments)) return;
  if (server.baseDiffHash !== S.lastBaseDiffHash) {
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
  if (JSON.stringify(server.guide ?? null) !== JSON.stringify(S.state.guide ?? null)) {
    S.state.guide = server.guide;
    render();
    toast("Guide updated");
  }
  const localIds = new Set(S.state.comments.map((c) => c.id));
  const incoming = server.comments.filter((c) => !localIds.has(c.id));
  if (!incoming.length) return;
  S.state.comments.push(...incoming);
  if (incoming.some((c) => c.role === "agent")) {
    S.awaitingAgent = false;
    toast("Agent replied");
  }
  render();
}
