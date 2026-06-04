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

function openComposerAt(lineNumber: number, e: MouseEvent) {
  S.selected = { side: "additions", lineNumber };
  S.composerBody = "";
  S.editingCommentId = null;
  S.composerTitle = selectionLabel();
  S.popoverOpen = false;
  placePopoverFromPoint(e.clientX, e.clientY);
  placeNearActionPop($("composer"));
  S.composerOpen = true;
  setTimeout(() => $("commentBody").focus(), 0);
}

// Render the current markdown file as formatted HTML in #diff, with a per-block comment
// affordance and existing comment threads overlaid at their source line. Replaces the
// @pierre/diffs view (no line gutter); comments are still plain line-anchored ReviewComments.
export function renderMarkdownFile() {
  const f = currentFile();
  const host = $("diff");
  host.innerHTML = `<div class="md-file md"></div>`;
  const container = host.firstElementChild as HTMLElement;
  container.innerHTML = renderMarkdown(f.newFile.contents);

  // Wrap each top-level block (carries data-line) so we can hang a hover 💬 + threads off it.
  const wrappers: HTMLElement[] = [];
  for (const child of [...container.children] as HTMLElement[]) {
    const line = child.getAttribute("data-line");
    if (line === null) continue;
    const wrap = document.createElement("div");
    wrap.className = "md-block";
    wrap.dataset.line = line;
    child.replaceWith(wrap);
    wrap.appendChild(child);
    const btn = document.createElement("button");
    btn.className = "md-comment-btn";
    btn.title = "Comment on this block";
    btn.textContent = "💬";
    btn.onclick = (e) => openComposerAt(Number(line), e);
    wrap.appendChild(btn);
    wrappers.push(wrap);
  }

  // Overlay comment threads after the block at (or nearest at/above) each comment's line.
  const byLine = new Map<number, ReviewComment[]>();
  for (const c of currentComments()) (byLine.get(c.lineNumber) ?? byLine.set(c.lineNumber, []).get(c.lineNumber)!).push(c);
  for (const [line, comments] of byLine) {
    comments.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    const thread = document.createElement("div");
    thread.className = "annotation md-thread";
    thread.appendChild(buildCommentThread({ type: "thread", path: f.path, side: "additions", lineNumber: line, status: comments.some((c) => c.status === "open") ? "open" : "resolved", comments }));
    const block = blockForLine(wrappers, line);
    if (block) block.after(thread); else container.appendChild(thread);
  }
}

// The block whose data-line is the largest value <= line (the block the comment sits in).
function blockForLine(wrappers: HTMLElement[], line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const w of wrappers) {
    const wl = Number(w.dataset.line);
    if (wl <= line && (!best || wl > Number(best.dataset.line))) best = w;
  }
  return best ?? wrappers[0] ?? null;
}
