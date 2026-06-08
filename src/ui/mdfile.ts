import { S, $ } from "./store";
import { currentFile, currentComments } from "./changes";
import { renderMarkdown } from "./markdown";
import { buildCommentThread } from "./annotations";
import { placePopoverFromPoint, placeNearActionPop, selectionLabel } from "./selection";
import type { ReviewComment } from "./types";

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

// In file mode, a new/unchanged markdown file opens rendered (read the plan); a changed
// one opens as source so you see the diff first. The toolbar toggle overrides per file.
export function defaultFileView(f: ReturnType<typeof currentFile>): "rendered" | "source" {
  if (!isMarkdownPath(f.path)) return "source";
  const changed = f.oldFile.contents !== "" && f.oldFile.contents !== f.newFile.contents;
  return changed ? "source" : "rendered";
}

function openComposerAt(lineNumber: number, clientX: number, clientY: number) {
  S.selected = { side: "additions", lineNumber };
  S.composerBody = "";
  S.editingCommentId = null;
  S.composerTitle = selectionLabel();
  S.popoverOpen = false;
  placePopoverFromPoint(clientX, clientY);
  placeNearActionPop($("composer"));
  S.composerOpen = true;
  setTimeout(() => $("commentBody").focus(), 0);
}

// A commentable block is any element carrying a source line, except the list
// containers themselves (you comment on the individual <li>, not the whole list).
function isAnchor(el: Element): boolean {
  return el.hasAttribute("data-line") && el.tagName !== "UL" && el.tagName !== "OL";
}

// Render the current markdown file as formatted HTML in #diff, with click-to-comment on
// each block and existing comment threads overlaid at their source line. Replaces the
// @pierre/diffs view; comments are still plain line-anchored ReviewComments.
export function renderMarkdownFile() {
  const f = currentFile();
  const host = $("diff");
  host.innerHTML = `<div class="md-file md"></div>`;
  const container = host.firstElementChild as HTMLElement;
  container.innerHTML = renderMarkdown(f.newFile.contents);

  const anchors = [...container.querySelectorAll<HTMLElement>("[data-line]")].filter(isAnchor);
  for (const el of anchors) {
    el.classList.add("md-anchor");
    el.title = "Click to comment";
  }

  // Click anywhere on a block to comment on it (ignore text selection, links, and clicks
  // inside an existing thread). Delegated so it survives the per-render rebuild.
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("a, button, input, .md-thread")) return;
    if (!window.getSelection()?.isCollapsed) return; // user is selecting text
    const el = target.closest<HTMLElement>("[data-line]");
    if (!el || !isAnchor(el)) return; // clicked the list container gutter, not an item
    openComposerAt(Number(el.dataset.line), e.clientX, e.clientY);
  });

  // Overlay comment threads at each comment's source line: inside the <li> for list
  // items (indented under the item), after the block otherwise.
  const byLine = new Map<number, ReviewComment[]>();
  for (const c of currentComments())
    (byLine.get(c.lineNumber) ?? byLine.set(c.lineNumber, []).get(c.lineNumber)!).push(c);
  for (const [line, comments] of byLine) {
    comments.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    const thread = document.createElement("div");
    thread.className = "annotation md-thread";
    thread.appendChild(
      buildCommentThread({
        type: "thread",
        path: f.path,
        side: "additions",
        lineNumber: line,
        status: comments.some((c) => c.status === "open") ? "open" : "resolved",
        comments,
      }),
    );
    const el = anchorForLine(anchors, line);
    if (!el) container.appendChild(thread);
    else if (el.tagName === "LI") el.appendChild(thread);
    else el.after(thread);
  }
}

// The anchor whose data-line is the largest value <= line (the block the comment sits in).
function anchorForLine(anchors: HTMLElement[], line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const el of anchors) {
    const l = Number(el.dataset.line);
    if (l <= line && (!best || l > Number(best.dataset.line))) best = el;
  }
  return best ?? anchors[0] ?? null;
}
