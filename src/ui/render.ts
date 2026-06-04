import { S, $ } from "./store";
import { currentFile, currentChanges, ensureChangesFromFileDiff, replayDecisions } from "./changes";
import { sync } from "./tree";
import { annotations, renderAnnotation } from "./annotations";
import { handleLineNumberClick, handleDiffSelection, attachDiffSelectionHandlers } from "./selection";
import { keepAllCurrentFile, resetReview, toggleReviewed } from "./decisions";

export async function render() {
  if (S.instance) S.instance.cleanUp?.();
  const f = currentFile();
  const viewOnly = S.state.mode === "file" && (f.oldFile.contents === "" || f.oldFile.contents === f.newFile.contents);
  S.fileDiff = viewOnly ? S.parseDiffFromFile({ name: f.newFile.name, contents: "" }, f.newFile) : S.parseDiffFromFile(f.oldFile, f.newFile);
  if (!viewOnly) { ensureChangesFromFileDiff(S.fileDiff); S.fileDiff = replayDecisions(S.fileDiff); }
  sync();
  S.instance = new S.FileDiff({
    theme: { dark: "pierre-dark", light: "pierre-light" }, themeType: "dark", diffStyle: S.diffStyle, diffIndicators: "bars", overflow: "scroll", hunkSeparators: "line-info", lineDiffType: "word-alt", enableLineSelection: true,
    renderAnnotation, onLineNumberClick: handleLineNumberClick, onLineSelectionStart: handleDiffSelection, onLineSelectionChange: handleDiffSelection, onLineSelected: handleDiffSelection, onLineSelectionEnd: handleDiffSelection,
    renderHeaderMetadata: () => {
      const wrap = document.createElement("span");
      const filePath = currentFile().path;
      const pending = currentChanges().filter((c: any) => c.status === "pending");
      const viewed = S.state.reviewedFiles?.includes(filePath);
      if (pending.length) { const button = document.createElement("button"); button.className = "diff-header-action"; button.textContent = "Keep All"; button.onclick = () => keepAllCurrentFile(); wrap.appendChild(button); }
      if (!pending.length && S.state.decisionFiles?.includes(filePath)) { const reset = document.createElement("button"); reset.className = "diff-header-action undo"; reset.textContent = "Reset Decisions"; reset.onclick = () => resetReview(filePath); wrap.appendChild(reset); }
      if (S.state.mode !== "file") { const actions = document.createElement("span"); actions.className = "file-header-actions"; actions.innerHTML = `<label><input type="checkbox" ${viewed ? "checked" : ""}>Viewed</label>`; (actions.querySelector("input") as any).onchange = () => toggleReviewed(filePath); wrap.appendChild(actions); }
      return wrap;
    },
  });
  await S.instance.render({ fileDiff: S.fileDiff, containerWrapper: $("diff"), lineAnnotations: annotations() });
  setTimeout(() => attachDiffSelectionHandlers(), 0);
}
