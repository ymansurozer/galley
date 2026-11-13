import type { DiffLineAnnotation, FileDiff, FileDiffMetadata } from "@pierre/diffs";
import { S, D, esc, persist } from "./store";
import { annotations, newCommentCard, type ThreadControls } from "./annotations";
import { addLineComment, deleteComment, turnComment } from "./comments";
import { closeComposer, openTopicComposer } from "./composer";
import { fetchContents, peekContents } from "./contents";
import { threadKey, threadSlot } from "./rests";
import { codeScheme } from "./shiki-curated";
import { renderTopics } from "./topics";
import {
  linePart,
  readLinePart,
  sliceRange,
  slicePatch,
  sliceRows,
  spanLabel,
  type SliceRow,
} from "./topics-lines-derive";
import type { AnnotationInput, AnnotationMeta, Side, ThreadMeta } from "./types";
import type { GuideTopic, LineSpan, ReviewState } from "../types";

type ReviewFile = ReviewState["files"][number];

// A topic's line blocks on its page: each entry the desk stamped (TopicStamp lineSpans) drawn by
// the diff component Code mode uses, as a second instance of its own, from a patch cut to the
// entry's rows (topics-lines-derive.ts slicePatch). The main diff's cursor, folds, skims and line
// map never see it: it draws the raw lines with the file's own numbers, and it never becomes the
// current file. Its lines are parts of the topic's page, and a comment on one is the ReviewComment
// Code mode makes on that line, so the thread is the same in both places.

// What an entry draws: its rows, or why it draws none (its lines left the diff, its file is too
// large to draw here, or the file's contents are still on their way).
type Slice = SliceRow[] | "gone" | "large" | "loading";

function sliceOf(span: LineSpan): Slice {
  const file = S.state.files.find((f) => f.path === span.path);
  if (!file || span.start === undefined || span.end === undefined) return "gone";
  if (file.oversized) return "large";
  if (file.hunks.length) return sliceRows(file.hunks, span.start, span.end);
  // A file the diff shows without hunks (an untracked add) is drawn from its contents.
  const contents = peekContents(file);
  if (!contents) {
    void fetchContents(file)
      .then(() => S.view === "topics" && renderTopics())
      .catch(() => {});
    return "loading";
  }
  return sliceRows([], span.start, span.end, contents.newContents.split("\n"));
}

const spansOf = (topic: GuideTopic) => S.state.topics?.[topic.id]?.lineSpans ?? [];

// The parts a topic's line blocks add to its page, by the source line of each block's fence: each
// line drawn, top to bottom (topicthreads-derive.ts topicParts places them among the body's).
export function lineParts(topic: GuideTopic): Array<{ fence: number; parts: string[] }> {
  const byFence = new Map<number, string[]>();
  for (const span of spansOf(topic)) {
    const rows = sliceOf(span);
    if (typeof rows === "string") continue;
    const parts = byFence.get(span.fence) ?? [];
    for (const r of rows) {
      const part = linePart(r.side, r.line, span.path);
      if (!parts.includes(part)) parts.push(part);
    }
    byFence.set(span.fence, parts);
  }
  return [...byFence].map(([fence, parts]) => ({ fence, parts }));
}

// A drawn entry's instance and the element it draws into, kept across redraws of the page (each
// redraw rebuilds the page's markup) so the same lines aren't tokenized again. Keyed by what the
// drawing depends on.
type Drawn = {
  wrapper: HTMLElement;
  inst: FileDiff<AnnotationMeta>;
  patch: string;
  fd: FileDiffMetadata;
};
const drawn = new Map<string, Drawn>();
const DRAWN_CAP = 24;

// What the page's cursor and comments do, which topicthreads.ts owns.
export type LineBlockActions = {
  // Open the composer on a line's part.
  comment: (part: string) => void;
  // Put the keyboard's cursor on a line's part, unseen, as a plain click on any part does.
  point: (part: string) => void;
};

// Draw the line blocks of the open topic's page, which renderTopicBody left as `.topic-lines`
// places. `cursor`: the part the keyboard's cursor shows on, when its rail is showing.
export function mountLineBlocks(
  page: HTMLElement,
  topic: GuideTopic,
  cursor: string | null,
  actions: LineBlockActions,
) {
  const spans = spansOf(topic);
  let composerPlaced = false;
  for (const place of page.querySelectorAll<HTMLElement>(".topic-lines")) {
    const fence = Number(place.dataset.line);
    const mine = spans.flatMap((span, i) => (span.fence === fence ? [{ span, i }] : []));
    place.replaceChildren();
    for (const { span, i } of mine) {
      const card = page.ownerDocument.createElement("div");
      card.className = "topic-lines-card";
      const line = span.start ?? 1;
      card.innerHTML = `<div class="topic-lines-h"><span class="topic-lines-path" title="${esc(span.path)}">${esc(spanLabel(span))}</span><button type="button" class="btn quiet sm" data-topic-code="${esc(span.path)}" data-line="${line}">Open in Code</button></div>`;
      place.append(card);
      const rows = sliceOf(span);
      if (typeof rows === "string") {
        const note = page.ownerDocument.createElement("p");
        note.className = "topic-lines-note";
        note.textContent =
          rows === "gone"
            ? "These lines are no longer in the diff"
            : rows === "large"
              ? "This file is too large to draw here"
              : "Loading lines…";
        card.append(note);
        continue;
      }
      const anns = blockAnnotations(topic.id, span.path, rows, !composerPlaced);
      if (anns.some((a) => a.metadata.type === "composer")) composerPlaced = true;
      const entry = instanceFor(`${topic.id}\n${fence}\n${i}`, span.path, rows, topic.id, actions);
      const code = page.ownerDocument.createElement("div");
      code.className = "topic-lines-code";
      // The code takes the code theme's scheme, as Code mode's diff area does (tokens.css).
      code.dataset.scheme = codeScheme(S.settings.theme);
      code.append(entry.wrapper);
      card.append(code);
      const sel = cursorLine(cursor, span.path, rows);
      // A new array each draw, which is what tells the component its annotations changed.
      const lineAnnotations = anns as DiffLineAnnotation<AnnotationMeta>[];
      entry.inst.render({ fileDiff: entry.fd, containerWrapper: entry.wrapper, lineAnnotations });
      entry.inst.setSelectedLines(sel ? { start: sel.line, end: sel.line, side: sel.side } : null, {
        notify: false,
      });
    }
  }
}

// The keyboard's cursor on one of these rows, if it is on one.
function cursorLine(cursor: string | null, path: string, rows: readonly SliceRow[]) {
  const at = cursor ? readLinePart(cursor) : null;
  return at && at.path === path && rows.some((r) => r.side === at.side && r.line === at.line)
    ? at
    : null;
}

// Show the keyboard's cursor on a line part (j / k), in whichever block draws it, and bring the
// line into view. False when no block on the page draws it.
export function showLineCursor(page: HTMLElement, part: string): boolean {
  const at = readLinePart(part);
  let shown = false;
  for (const entry of drawn.values()) {
    if (!page.contains(entry.wrapper)) continue;
    const mine = at && entry.wrapper.dataset.path === at.path && hasRow(entry, at.side, at.line);
    entry.inst.setSelectedLines(
      mine && at && !shown ? { start: at.line, end: at.line, side: at.side } : null,
      { notify: false },
    );
    if (mine && !shown) {
      shown = true;
      entry.wrapper.closest(".topic-lines-card")?.scrollIntoView({ block: "nearest" });
    }
  }
  return shown;
}

// Whether a drawn block holds a row for a side and line: its patch's hunks say which lines it drew.
function hasRow(entry: Drawn, side: Side, line: number) {
  return entry.fd.hunks.some((h) =>
    side === "additions"
      ? line >= h.additionStart && line < h.additionStart + h.additionCount
      : line >= h.deletionStart && line < h.deletionStart + h.deletionCount,
  );
}

function instanceFor(
  key: string,
  path: string,
  rows: readonly SliceRow[],
  topic: string,
  actions: LineBlockActions,
): Drawn {
  const patch = slicePatch(path, rows);
  const look = [
    S.settings.theme,
    S.settings.lineDiffType,
    S.settings.diffIndicators,
    S.settings.overflow,
    S.settings.hunkSeparators,
  ].join("\n");
  const full = `${key}\n${look}`;
  const had = drawn.get(full);
  if (had) {
    drawn.delete(full); // re-insert → most-recently-used
    if (had.patch !== patch) {
      had.patch = patch;
      had.fd = parsePatch(patch, path);
    }
    drawn.set(full, had);
    return had;
  }
  const wrapper = document.createElement("div");
  wrapper.className = "diff-wrap";
  wrapper.dataset.path = path;
  const comment = (side: Side, line: number) => actions.comment(linePart(side, line, path));
  const inst: FileDiff<AnnotationMeta> = new D.FileDiff<AnnotationMeta>({
    theme: { dark: S.settings.theme, light: S.settings.theme },
    themeType: "light",
    // A block sits in the page's reading column, so it is drawn in one column.
    diffStyle: "unified",
    diffIndicators: S.settings.diffIndicators,
    overflow: S.settings.overflow,
    hunkSeparators: S.settings.hunkSeparators,
    lineDiffType: S.settings.lineDiffType,
    disableFileHeader: true,
    // A click on a line comments or moves the cursor; a drag selects nothing (setSelectedLines
    // still shows the cursor).
    enableLineSelection: false,
    enableGutterUtility: true,
    onGutterUtilityClick: (range) => comment(range.side ?? "additions", range.start),
    onLineNumberClick: (p) => comment(p.annotationSide, p.lineNumber),
    // ⇧ click on a line comments on it, as on any part; a plain click puts the cursor there.
    onLineClick: (p) =>
      p.event.shiftKey
        ? comment(p.annotationSide, p.lineNumber)
        : actions.point(linePart(p.annotationSide, p.lineNumber, path)),
    renderAnnotation: (a: { metadata: AnnotationMeta }) => blockAnnotation(a.metadata, topic),
    // The patch starts at the range, so the lines above it are no gap in what the block names: no
    // separator leads it. One between two of its hunks still says lines are left out.
    unsafeCSS:
      "[data-separator-first]{display:none}" +
      "[data-code]{scrollbar-gutter:auto}" +
      "[data-line-annotation],[data-gutter-buffer=annotation]{--diffs-line-bg:var(--diffs-annotation-bg)}" +
      (codeScheme(S.settings.theme) === "dark"
        ? ":host{--diffs-bg-separator:color-mix(in lab,var(--diffs-bg) 85%,#fff)}"
        : ""),
  });
  const entry = { wrapper, inst, patch, fd: parsePatch(patch, path) };
  drawn.set(full, entry);
  while (drawn.size > DRAWN_CAP) {
    const oldest = drawn.keys().next().value as string;
    drawn.get(oldest)?.inst.cleanUp?.();
    drawn.delete(oldest);
  }
  return entry;
}

// The entry's rows as the diff component reads them. A patch with no sides is partial, so the
// component offers no way to expand the lines between its hunks: the block shows what it names.
function parsePatch(patch: string, path: string): FileDiffMetadata {
  // slicePatch always writes one file with at least one hunk, which processFile parses.
  const fd = D.processFile(patch, { isGitDiff: false })!;
  fd.name = path;
  return fd;
}

// The threads on the block's lines (the annotation builder over the block's path and range), and
// the composer for a new comment when the topic's composer is open on one of its lines and no open
// thread there hosts it. `composer`: no block drew it yet this pass.
function blockAnnotations(
  topic: string,
  path: string,
  rows: readonly SliceRow[],
  composer: boolean,
): AnnotationInput[] {
  const anns = annotations(path, sliceRange(rows));
  const draft =
    composer && S.composerOpen && !S.editingCommentId && S.topicDraft?.topic === topic
      ? readLinePart(S.topicDraft.part)
      : null;
  if (
    draft &&
    draft.path === path &&
    rows.some((r) => r.side === draft.side && r.line === draft.line) &&
    !anns.some(
      (a) =>
        a.metadata.type === "thread" &&
        a.metadata.status === "open" &&
        a.side === draft.side &&
        a.lineNumber === draft.line,
    )
  )
    anns.push({
      side: draft.side,
      lineNumber: draft.line,
      metadata: { type: "composer", side: draft.side, lineNumber: draft.line, path },
    });
  return anns;
}

function blockAnnotation(m: AnnotationMeta, topic: string): HTMLElement {
  const el = document.createElement("div");
  const signs = S.settings.diffIndicators === "classic" ? " signs" : "";
  if (m.type === "thread") {
    el.className = `annotation line-thread${signs}`;
    el.append(threadSlot(m, false, "code", blockThread(m, topic)));
  } else if (m.type === "composer") {
    el.className = `annotation composer-annotation${signs}`;
    el.append(newCommentCard(null));
  }
  return el;
}

// A thread's buttons in a block: replying and editing open the topic page's composer on the line,
// whose submit makes or edits the line's ReviewComment (submitLineComposer).
function blockThread(t: ThreadMeta, topic: string): ThreadControls {
  const part = linePart(t.side, t.lineNumber, t.path);
  const here = () => S.composerOpen && S.topicDraft?.topic === topic && S.topicDraft.part === part;
  return {
    replying: here() && !S.editingCommentId,
    reply: () => openTopicComposer({ topic, part }),
    setStatus: (status) => {
      // As in Code mode (annotations.ts lineThread): resolving closes the empty reply composer, and
      // a draft keeps the resolved card open around it.
      if (status === "resolved") {
        if (here() && S.composerBody.trim()) S.openThread = threadKey(t);
        else {
          if (here()) closeComposer(true);
          if (S.openThread === threadKey(t)) S.openThread = null;
        }
      }
      S.state.comments
        .filter((x) => x.path === t.path && x.side === t.side && x.lineNumber === t.lineNumber)
        .forEach((x) => (x.status = status));
      renderTopics();
      persist();
    },
    edit: (id) => {
      const c = S.state.comments.find((x) => x.id === id);
      if (c && c.role !== "agent") openTopicComposer({ topic, part }, null, c.body, id);
    },
    remove: deleteComment,
    turn: turnComment,
  };
}

// Submit the topic page's composer open on a line of a block: a new comment on the line (a reply,
// where a thread is), or the edit of one, exactly as Code mode makes them.
export function submitLineComposer(part: string, body: string, intent: "question" | "action") {
  const at = readLinePart(part);
  if (!at) return;
  if (S.editingCommentId) {
    const c = S.state.comments.find((x) => x.id === S.editingCommentId);
    if (c) {
      c.body = body;
      c.updatedAt = new Date().toISOString();
    }
    persist();
  } else {
    const file = S.state.files.find((f) => f.path === at.path);
    addLineComment(
      {
        path: at.path,
        side: at.side,
        lineNumber: at.line,
        anchorText: file && lineText(file, at.side, at.line),
      },
      body,
      intent,
    );
  }
  closeComposer();
}

// A line's text, from the file's hunks (or, for a file without hunks, its contents), so a reload
// can re-anchor the thread as it does one made in Code mode.
function lineText(file: ReviewFile, side: Side, line: number): string | undefined {
  for (const h of file.hunks)
    for (const l of h.lines)
      if (side === "deletions" ? l.kind !== "add" && l.oldLine === line : l.newLine === line)
        return l.text;
  if (!file.hunks.length && side === "additions")
    return peekContents(file)?.newContents.split("\n")[line - 1];
  return undefined;
}
