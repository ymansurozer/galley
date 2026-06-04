import type { DiffLineAnnotation } from "@pierre/diffs";
import { S, D, $ } from "./store";
import { currentFile, currentChanges, ensureChangesFromFileDiff, replayDecisions } from "./changes";
import type { AnnotationMeta } from "./types";
import { applyLayoutClasses } from "./tree";
import { annotations, renderAnnotation } from "./annotations";
import { handleLineNumberClick, handleDiffSelection, attachDiffSelectionHandlers } from "./selection";
import { keepAllCurrentFile, resetReview, toggleReviewed } from "./decisions";

export async function render() {
  if (D.instance) D.instance.cleanUp?.();
  const f = currentFile();
  const viewOnly = S.state.mode === "file" && (f.oldFile.contents === "" || f.oldFile.contents === f.newFile.contents);
  let fd = viewOnly ? D.parseDiffFromFile({ name: f.newFile.name, contents: "" }, f.newFile) : D.parseDiffFromFile(f.oldFile, f.newFile);
  if (!viewOnly) { ensureChangesFromFileDiff(fd); fd = replayDecisions(fd); }
  D.fileDiff = fd;
  applyLayoutClasses();
  const inst = new D.FileDiff({
    theme: { dark: "pierre-dark", light: "pierre-light" }, themeType: "dark", diffStyle: S.diffStyle, diffIndicators: "bars", overflow: "scroll", hunkSeparators: "line-info", lineDiffType: "word-alt", enableLineSelection: true,
    renderAnnotation, onLineNumberClick: handleLineNumberClick, onLineSelectionStart: handleDiffSelection, onLineSelectionChange: handleDiffSelection, onLineSelected: handleDiffSelection, onLineSelectionEnd: handleDiffSelection,
    renderHeaderMetadata: () => {
      const wrap = document.createElement("span");
      const filePath = currentFile().path;
      const pending = currentChanges().filter((c) => c.status === "pending");
      const viewed = S.state.reviewedFiles?.includes(filePath);
      if (pending.length) { const button = document.createElement("button"); button.className = "diff-header-action"; button.textContent = "Keep All"; button.onclick = () => keepAllCurrentFile(); wrap.appendChild(button); }
      if (!pending.length && S.state.decisionFiles?.includes(filePath)) { const reset = document.createElement("button"); reset.className = "diff-header-action undo"; reset.textContent = "Reset Decisions"; reset.onclick = () => resetReview(filePath); wrap.appendChild(reset); }
      if (S.state.mode !== "file") { const actions = document.createElement("span"); actions.className = "file-header-actions"; actions.innerHTML = `<label><input type="checkbox" ${viewed ? "checked" : ""}>Viewed</label>`; (actions.querySelector("input") as any).onchange = () => toggleReviewed(filePath); wrap.appendChild(actions); }
      return wrap;
    },
  });
  D.instance = inst;
  // annotations() is our own AnnotationInput[]; the lib's DiffLineAnnotation<T> is a
  // discriminated union whose assignability check rejects our union-typed metadata,
  // though the runtime shape (side/lineNumber/metadata) is exactly what it reads.
  await inst.render({ fileDiff: fd, containerWrapper: $("diff"), lineAnnotations: annotations() as DiffLineAnnotation<AnnotationMeta>[] });
  setTimeout(() => attachDiffSelectionHandlers(), 0);
}
