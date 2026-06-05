import { S, D, api, toast } from "./store";
import { render } from "./render";
import type { ReviewState } from "./types";

export async function pollState() {
  if (S.composerOpen || S.popoverOpen) return;
  let server: ReviewState | undefined;
  try { server = await api<ReviewState>("/api/state"); } catch { return; }
  if (!server || !Array.isArray(server.comments)) return;
  if (server.baseDiffHash !== S.lastBaseDiffHash) {
    S.lastBaseDiffHash = server.baseDiffHash;
    S.state = server;
    D.fileDiff = null;
    if (S.fileIndex >= S.state.files.length) S.fileIndex = 0;
    S.awaitingAgent = false;
    // The diff changed (e.g. a reload added files) — refresh the project listing too so
    // the tree reflects newly tracked files, not the listing fetched at startup.
    api<{ files?: string[] }>("/api/tree").then((r) => { if (r.files) S.projectFiles = r.files; }).catch(() => {});
    render(); toast("Diff updated");
    return;
  }
  const localIds = new Set(S.state.comments.map((c) => c.id));
  const incoming = server.comments.filter((c) => !localIds.has(c.id));
  if (!incoming.length) return;
  S.state.comments.push(...incoming);
  if (incoming.some((c) => c.role === "agent")) { S.awaitingAgent = false; toast("Agent replied"); }
  render();
}
