import type { FileDiffMetadata } from "@pierre/diffs";
import { S, $ } from "./store";
import { currentFile, currentSplittable, fileFinished, fileObjections } from "./changes";
import { unanchoredBlock } from "./annotations";
import { unanchoredThreads } from "./unanchored";
import { approveCurrentFile, resetReview } from "./decisions";
import { blockersChip, fileBlockers } from "./blockers";
import { renderMarkdown } from "./markdown";
import { currentGuideEntry, nextFileIndex } from "./guide";
import { isFileSkim, isFileSkimCollapsed, movedFrom, toggleFileSkim } from "./skim";
import { keycapsHtml, keycapsNode } from "./keycaps";
import { fileBarActions, splitPath } from "./filebar-derive";

// ── The open file's bar ──────────────────────────────────────────────────────
// One Galley-DOM header serves every file view (diff, skim strip, pure rename, oversized card,
// rendered markdown, preview). render() mounts it as #diff's first child, where it sits sticky
// under the top bar while the view scrolls beneath it. #diff is also where every jump scrolls
// (cursor, go-to-line, blockers, the change-request walk), so the bar's height is mirrored into
// --file-bar-h, the scroll-margin-top of everything under it (diff.css, and the rows' in-shadow
// CSS in render.ts): a scrollIntoView then lands below the bar instead of under it. The element
// persists across renders (its contents are rebuilt), so one observer tracks it for the session —
// including its wrap at narrow widths.
let bar: HTMLElement | null = null;
function barElement(): HTMLElement {
  if (bar) return bar;
  const el = document.createElement("div");
  el.className = "file-bar";
  new ResizeObserver(() =>
    $("diff").style.setProperty("--file-bar-h", `${el.offsetHeight}px`),
  ).observe(el);
  bar = el;
  return el;
}

function button(className: string, label: string, run: () => unknown): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = className;
  b.textContent = label;
  b.onclick = () => void run();
  return b;
}

// A two-way segmented control (Rendered | Source, Unified | Split). Clicking re-renders, which
// rebuilds the bar with the new choice active.
function segmented<T extends string>(
  tip: string,
  keys: string,
  options: [T, string][],
  value: T,
  pick: (v: T) => void,
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "seg xs";
  wrap.dataset.tip = tip;
  wrap.dataset.tipKeys = keys;
  for (const [v, label] of options)
    wrap.appendChild(button(v === value ? "active" : "", label, () => pick(v)));
  return wrap;
}

// The path, its folder muted and its filename in ink. When the bar runs short the folder gives
// way from the left ("…storage/uploads.ts"), so the filename stays readable: the folder is laid
// out right-to-left to put its ellipsis at the start, and <bdi> keeps the path itself reading
// left-to-right inside it.
function pathLabel(path: string): HTMLElement {
  const { dir, name } = splitPath(path);
  const el = document.createElement("span");
  el.className = "fb-path";
  el.title = path;
  if (dir) {
    const d = document.createElement("span");
    d.className = "fb-dir";
    const bdi = document.createElement("bdi");
    bdi.textContent = dir;
    d.appendChild(bdi);
    el.appendChild(d);
  }
  const n = document.createElement("span");
  n.className = "fb-name";
  n.textContent = name;
  el.appendChild(n);
  return el;
}

// Icon-only "jump to this file in the local editor" button — file-scoped, so it lives in the
// file's bar rather than the app chrome (the top bar is for review-final actions).
function openEditorButton(): HTMLElement {
  const b = document.createElement("button");
  b.className = "btn icon sm fb-open";
  b.dataset.tip = "Open in editor";
  b.dataset.tipKeys = "⇧E";
  b.setAttribute("aria-label", "Open in editor");
  b.innerHTML = `<svg class="ic"><use href="#gly-open-editor"></use></svg>`;
  b.onclick = () => S.openInEditor?.();
  return b;
}

// The file's one filled button: Approve File (clean, green) or Mark Reviewed (it carries a
// rejected change or an open change request, orange). Either signs off and advances.
function signOffButton(objections: boolean): HTMLElement {
  const b = document.createElement("button");
  b.className = "signoff fill" + (objections ? " warn" : "");
  b.innerHTML = `${objections ? "Mark Reviewed" : "Approve File"} ${keycapsHtml("⇧A")}`;
  b.onclick = () => approveCurrentFile();
  return b;
}

// A finished file's quiet state, in place of the button that signed it off.
function signedOffState(objections: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = "fb-state " + (objections ? "warn" : "ok");
  el.innerHTML = objections
    ? `<svg class="ic"><use href="#gly-circle-alert"></use></svg>Reviewed with requests`
    : `<svg class="ic"><use href="#gly-check"></use></svg>Approved`;
  return el;
}

// The open file's actions, in fileBarActions' order. Every handler is the one the header has
// always had: the per-file reset (its toast offers Undo), the blockers jump list, the skim
// re-collapse, and the ⇧A sign-off. `jumpable` is false over a view with no rows to jump to.
function fileActions(path: string, jumpable: boolean): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "fb-actions";
  const finished = fileFinished(path);
  const objections = fileObjections(path);
  const chip = jumpable ? blockersChip() : null;
  const actions = fileBarActions({
    finished,
    objections,
    blockers: chip ? fileBlockers(path).length : 0,
    hasDecisions: !!S.state.decisionFiles?.includes(path),
    skimExpanded: isFileSkim(path) && !isFileSkimCollapsed(path),
  });
  for (const a of actions) {
    if (a === "collapse") {
      const b = button("btn quiet sm", "Collapse", () => toggleFileSkim(path));
      b.dataset.tip = "Fold this skimmed file back";
      wrap.appendChild(b);
    } else if (a === "reset") {
      const b = button("btn quiet sm", "Reset", () => resetReview(path));
      b.dataset.tip = finished
        ? "Undo the sign-off and clear this file's decisions"
        : "Clear this file's Keep / Undo decisions";
      wrap.appendChild(b);
    } else if (a === "blockers") {
      if (chip) wrap.appendChild(chip);
    } else if (a === "approve" || a === "mark") wrap.appendChild(signOffButton(a === "mark"));
    else wrap.appendChild(signedOffState(a === "reviewed"));
  }
  return wrap;
}

// Fill the bar for the current file and return it for render() to mount. Left to right: the path,
// where it moved from, the view toggles that apply (Rendered | Source for a markdown file, Unified
// | Split for a two-sided diff), open in editor, +/−, and the file's actions. `fd` is the
// rendered (decision-replayed) diff when the view is @pierre's, so +/− track what's still on
// screen; the other views count from the file's own stats. A preview bar is the path and an
// "Unchanged" tag: an unchanged file isn't in the review, so it has no counts and no actions.
// `jumpable` is false over a view whose blockers can't be reached (see render.ts): it hides the
// blockers chip, whose rows would otherwise do nothing.
export function renderFileBar(fd?: FileDiffMetadata, jumpable = true): HTMLElement {
  const el = barElement();
  const f = currentFile();
  const lead: Node[] = [pathLabel(f.path)];
  const grow = document.createElement("span");
  grow.className = "fb-grow";
  if (S.preview) {
    const tag = document.createElement("span");
    tag.className = "fb-tag";
    tag.textContent = "Unchanged";
    el.replaceChildren(...lead, openEditorButton(), grow, tag);
    return el;
  }
  // Rename+edit files (git -M): where the file moved from, right of the new path.
  const from = movedFrom(f.path);
  if (from) {
    const moved = document.createElement("span");
    moved.className = "fb-moved";
    moved.title = `moved from ${from}`;
    moved.textContent = `moved from ${from}`;
    lead.push(moved);
  }
  if (S.isMarkdownFile?.())
    lead.push(
      segmented(
        "Rendered / Source",
        "m",
        [
          ["rendered", "Rendered"],
          ["source", "Source"],
        ],
        S.fileView,
        (v) => S.setFileView?.(v),
      ),
    );
  // Split only applies to a two-sided diff on screen. It's the Settings dialog's Layout, so the
  // two always agree.
  if (fd && currentSplittable())
    lead.push(
      segmented(
        "Unified / Split",
        "v",
        [
          ["unified", "Unified"],
          ["split", "Split"],
        ],
        S.diffStyle,
        (v) => S.setStyle?.(v),
      ),
    );
  let add = f.added ?? 0,
    del = f.removed ?? 0;
  if (fd) {
    add = del = 0;
    for (const h of fd.hunks) {
      add += h.additionLines ?? 0;
      del += h.deletionLines ?? 0;
    }
  }
  const counts = document.createElement("span");
  counts.className = "fb-counts";
  counts.innerHTML = `<span class="a">+${add}</span><span class="d">−${del}</span>`;
  const sep = document.createElement("span");
  sep.className = "fb-sep";
  el.replaceChildren(...lead, openEditorButton(), grow, counts, sep, fileActions(f.path, jumpable));
  return el;
}

// The row after the file's last line: "End of <file> · next: <file> ⇧→" and the file's sign-off,
// so a reviewer who read to the bottom acts there instead of scrolling back to the bar. Next is
// the file ⇧→ opens in review order, left out on the last file (⇧→ only wraps from there). A
// finished file shows its quiet state in the button's place; Reset stays in the bar.
export function fileEnd(): HTMLElement {
  const path = currentFile().path;
  const row = document.createElement("div");
  row.className = "file-end";
  const text = document.createElement("span");
  text.className = "fe-text";
  const name = document.createElement("b");
  name.textContent = splitPath(path).name;
  text.append("End of ", name);
  const n = nextFileIndex(S.fileIndex);
  const next = n === null ? null : S.state.files[n];
  if (next) {
    const go = button("fe-next", splitPath(next.path).name, () => S.nextFile?.());
    go.title = next.path;
    text.append(" · next: ", go, keycapsNode(document, "⇧→"));
  }
  const objections = fileObjections(path);
  row.append(text, fileFinished(path) ? signedOffState(objections) : signOffButton(objections));
  return row;
}

// What reads before the diff, under the bar and scrolling with the code: the guide's note on this
// file, then any open threads whose anchor line no longer renders. Null when there's neither.
export function fileLead(): HTMLElement | null {
  const entry = currentGuideEntry();
  const orphans = unanchoredThreads();
  if (!entry && !orphans.length) return null;
  const lead = document.createElement("div");
  lead.className = "file-lead";
  if (entry) {
    // Group the AI guidance into a subtle card, set apart from the bar + the code. The prose
    // fields render as markdown (renderMarkdown sanitizes) — the guidance is the main reading
    // content of a guided review, so identifiers/lists the agent writes survive.
    const guide = document.createElement("div");
    guide.className = "ghdr-guide";
    const chip = document.createElement("span");
    chip.className = "ghdr-cat" + (entry.flag ? " crit" : "");
    chip.textContent = entry.category;
    guide.appendChild(chip);
    // A whole-file skim entry may omit its orientation; the skim reason (if any) takes the
    // slot. Only the expanded file reaches the diff view — the collapsed strip shows the reason.
    if (entry.orientation) {
      const expl = document.createElement("div");
      expl.className = "ghdr-expl md";
      expl.innerHTML = renderMarkdown(entry.orientation);
      guide.appendChild(expl);
    } else if (entry.skimReason) {
      const why = document.createElement("div");
      why.className = "ghdr-skim";
      why.textContent = `skimmed · ${entry.skimReason}`;
      guide.appendChild(why);
    }
    // A flagged file gets its own readable callout within the card.
    if (entry.flag) {
      const flag = document.createElement("div");
      flag.className = "ghdr-flag";
      flag.innerHTML = `<svg class="ic"><use href="#gly-flag"></use></svg><div class="md">${renderMarkdown(entry.flag)}</div>`;
      guide.appendChild(flag);
    }
    lead.appendChild(guide);
  }
  // Open threads whose anchor line no longer renders — shown before the diff's first row so they
  // stay actionable (they block approval until resolved).
  if (orphans.length) lead.appendChild(unanchoredBlock(orphans));
  return lead;
}
