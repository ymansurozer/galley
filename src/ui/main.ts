import { S, $, show, hide, toast, api, persist } from "./store";
import { loadDiffLib } from "./difflib";
import { currentFile } from "./changes";
import { openCommentComposer, closeComposerIfEmpty } from "./selection";
import { stageFile } from "./decisions";
import { render } from "./render";
import { pollState } from "./poll";

// Close the composer when clicking outside it (unless it has unsaved text).
document.addEventListener("pointerdown", (e: any) => {
  if (!$("composer").classList.contains("show")) return;
  if ($("composer").contains(e.target) || $("actionPop").contains(e.target)) return;
  closeComposerIfEmpty();
}, true);

// Pane resizers
document.querySelectorAll("[data-resize]").forEach((handle: any) => {
  handle.onpointerdown = (e: any) => {
    e.preventDefault(); handle.classList.add("dragging");
    const side = handle.dataset.resize; const startX = e.clientX;
    const styles = getComputedStyle(document.documentElement);
    const startLeft = parseInt(styles.getPropertyValue("--left-width")) || 280;
    const startRight = parseInt(styles.getPropertyValue("--right-width")) || 320;
    handle.setPointerCapture(e.pointerId);
    handle.onpointermove = (move: any) => {
      if (side === "left") document.documentElement.style.setProperty("--left-width", `${Math.max(180, Math.min(520, startLeft + move.clientX - startX))}px`);
      else document.documentElement.style.setProperty("--right-width", `${Math.max(220, Math.min(620, startRight - (move.clientX - startX)))}px`);
    };
    handle.onpointerup = () => { handle.classList.remove("dragging"); handle.onpointermove = null; handle.onpointerup = null; };
  };
});

// Stage-confirmation modal
$("cancelStage").onclick = () => { S.pendingStagePath = null; hide($("stageModal")); };
$("confirmStage").onclick = async () => { const path = S.pendingStagePath; S.pendingStagePath = null; hide($("stageModal")); if (path) await stageFile(path, true); };

// Composer + toolbar
$("doComment").onclick = openCommentComposer;
$("saveComment").onclick = async () => {
  const body = $("commentBody").value.trim();
  if (!body) return;
  const base = { path: currentFile().path, side: S.selected.side, lineNumber: S.selected.lineNumber, endLine: S.selected.endLine, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "open" };
  S.state.comments.push({ id: crypto.randomUUID(), ...base, role: "user", body, intent: "action" });
  hide($("composer")); render(); persist(); toast("Comment saved");
};
$("reset").onclick = async () => { const result = await api("/api/reset", { method: "POST" }); if (result.state) { S.state = result.state; S.fileDiff = null; render(); } toast("Reset review"); };
$("save").onclick = async () => { await persist(); toast("Saved"); };
$("send").onclick = async () => {
  const b = $("send");
  const r = await api("/api/send", { method: "POST", body: JSON.stringify(S.state) });
  if (r && r.sent) { S.awaitingAgent = true; b.textContent = "Waiting for agent…"; b.disabled = true; toast("Sent to agent"); }
  else toast("Could not send review");
};

document.querySelectorAll("[data-style]").forEach((b: any) => (b.onclick = () => {
  document.querySelectorAll("[data-style]").forEach((x: any) => x.classList.remove("active"));
  b.classList.add("active");
  S.diffStyle = b.dataset.style;
  localStorage.setItem("galley.diffStyle", S.diffStyle);
  render();
}));

document.addEventListener("keydown", (e: any) => {
  if (e.key === "Escape") { if ($("composer").classList.contains("show")) { hide($("composer")); return; } hide($("actionPop")); hide($("composer")); }
  if (e.key === "c" && $("composer").classList.contains("show")) { e.preventDefault(); $("saveComment").click(); }
  if (e.key === "v") { S.diffStyle = S.diffStyle === "split" ? "unified" : "split"; localStorage.setItem("galley.diffStyle", S.diffStyle); document.querySelectorAll("[data-style]").forEach((x: any) => x.classList.toggle("active", x.dataset.style === S.diffStyle)); render(); }
});

// Init
await loadDiffLib();
S.state = await api("/api/state");
S.projectFiles = (await api("/api/tree")).files || [];
document.querySelectorAll("[data-style]").forEach((x: any) => x.classList.toggle("active", x.dataset.style === S.diffStyle));
S.lastBaseDiffHash = S.state.baseDiffHash;
S.selected = { side: S.state.changes[0]?.side || "additions", lineNumber: S.state.changes[0]?.lineNumber || 1 };
render();
setInterval(pollState, 1500);
