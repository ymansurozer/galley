import { S, $, api, toast } from "./store";
import { render } from "./render";

export async function pollState() {
  if ($("composer").classList.contains("show") || $("actionPop").classList.contains("show")) return;
  let server: any;
  try { server = await api("/api/state"); } catch { return; }
  if (!server || !Array.isArray(server.comments)) return;
  if (server.baseDiffHash !== S.lastBaseDiffHash) {
    S.lastBaseDiffHash = server.baseDiffHash;
    S.state = server;
    S.fileDiff = null;
    if (S.fileIndex >= S.state.files.length) S.fileIndex = 0;
    S.awaitingAgent = false;
    const b = $("send"); b.textContent = "Send to agent"; b.disabled = false;
    render(); toast("Diff updated");
    return;
  }
  const localIds = new Set(S.state.comments.map((c: any) => c.id));
  const incoming = server.comments.filter((c: any) => !localIds.has(c.id));
  if (!incoming.length) return;
  S.state.comments.push(...incoming);
  if (incoming.some((c: any) => c.role === "agent")) { S.awaitingAgent = false; const b = $("send"); b.textContent = "Send to agent"; b.disabled = false; toast("Agent replied"); }
  render();
}
