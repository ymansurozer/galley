import type { FileDiffMetadata } from "@pierre/diffs";
import { S, $ } from "./store";
import { currentFile, currentSplittable, flowIndex } from "./changes";
import { unanchoredBlock } from "./annotations";
import { unanchoredThreads } from "./unanchored";
import { approveCurrentStep, resetStep } from "./decisions";
import { blockersChip, currentBlockers } from "./blockers";
import { currentGuideEntry, currentSlot, currentStep, nextStep } from "./guide";
import type { Step } from "./steps";
import { isFileSkim, isFileSkimCollapsed, movedFrom, toggleFileSkim } from "./skim";
import { keycapsHtml, keycapsNode } from "./keycaps";
import { fileBarActions, splitPath } from "./filebar-derive";
import { guideMini, guideMiniElement, retrackGuideCard } from "./guidecard";

// ── The open file's bar ──────────────────────────────────────────────────────
// One Galley-DOM header serves every file view (diff, skim strip, pure rename, oversized card,
// rendered markdown, preview). render() mounts it as #diff's first child, where it sits sticky
// under the top bar while the view scrolls beneath it. #diff is also where every jump scrolls
// (cursor, go-to-line, blockers, the change-request walk), so the bar's height is mirrored into
// --file-bar-h, which sets the scroll-margin-top of everything under it (--jump-top in diff.css,
// and the rows' in-shadow CSS in render.ts): a scrollIntoView then lands below the bar, with a
// little air, instead of under it. The element
// persists across renders (its contents are rebuilt), and so does the pinned guide line it carries
// (guidecard.ts), so one observer tracks both for the session — including the bar's wrap at narrow
// widths, which also moves the line the guide card pins at.
let bar: HTMLElement | null = null;
function barElement(): HTMLElement {
  if (bar) return bar;
  const el = document.createElement("div");
  el.className = "file-bar";
  // Chrome over the code canvas, so the appearance's scheme, not the code's (tokens.css).
  el.dataset.scheme = "chrome";
  const ro = new ResizeObserver(() => {
    syncFileBarHeight();
    retrackGuideCard();
  });
  ro.observe(el);
  ro.observe(guideMiniElement());
  bar = el;
  return el;
}

// --file-bar-h: the bar, plus the pinned guide line under it while that shows.
export function syncFileBarHeight() {
  if (!bar) return;
  const pinned = bar.querySelector<HTMLElement>(":scope > .guide-mini.pinned");
  $("diff").style.setProperty(
    "--file-bar-h",
    `${bar.offsetHeight + (pinned?.offsetHeight ?? 0)}px`,
  );
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

// The step's one filled button: Approve File (clean, green) or Mark Reviewed (it carries a
// rejected change or an open change request, orange). Either signs off the step on screen (a part,
// a Rest, or the file whole) and advances. The end
// row's copy (`filled` false) is a neutral push button, so the code view keeps one filled button
// when both are on screen.
function signOffButton(objections: boolean, filled = true): HTMLElement {
  const b = document.createElement("button");
  b.className = filled ? "signoff fill" + (objections ? " warn" : "") : "btn";
  b.innerHTML = `${objections ? "Mark Reviewed" : "Approve File"} ${keycapsHtml("⇧A")}`;
  b.onclick = () => approveCurrentStep();
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

// Where the step on screen's sign-off stands: a part or Rest step by its own blocks, the file
// whole by the file (flow-index stepFinished / stepObjections). It has decisions to reset once one
// of its blocks is decided, or for a whole file once the file is.
function stepStand(path: string) {
  const blocks = currentSlot()?.blocks ?? null;
  const ix = flowIndex();
  return {
    part: !!blocks,
    finished: ix.stepFinished({ path, blocks }),
    objections: ix.stepObjections({ path, blocks }),
    decided: blocks
      ? blocks.some((c) => c.status !== "pending")
      : !!S.state.decisionFiles?.includes(path),
  };
}

// The open step's actions, in fileBarActions' order. Every handler is the one the header has
// always had: the step's reset (its toast offers Undo), the blockers jump list, the skim
// re-collapse, and the ⇧A sign-off. `jumpable` is false over a view with no rows to jump to.
function fileActions(path: string, jumpable: boolean): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "fb-actions";
  const { part, finished, objections, decided } = stepStand(path);
  const chip = jumpable ? blockersChip() : null;
  const actions = fileBarActions({
    finished,
    objections,
    blockers: chip ? currentBlockers().length : 0,
    hasDecisions: decided,
    skimExpanded: isFileSkim(path) && !isFileSkimCollapsed(path),
  });
  for (const a of actions) {
    if (a === "collapse") {
      const b = button("btn quiet sm", "Collapse", () => toggleFileSkim(path));
      b.dataset.tip = "Fold this skimmed file back";
      wrap.appendChild(b);
    } else if (a === "reset") {
      const b = button("btn quiet sm", "Reset", () => resetStep(currentStep()));
      const what = part ? "part" : "file";
      b.dataset.tip = finished
        ? `Undo the sign-off and clear this ${what}'s decisions`
        : `Clear this ${what}'s Keep / Undo decisions`;
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
  const mini = guideMini();
  if (S.preview) {
    const tag = document.createElement("span");
    tag.className = "fb-tag";
    tag.textContent = "Unchanged";
    mount(el, [...lead, openEditorButton(), grow, tag], null);
    return el;
  }
  // A step of a split file names its part (or "Rest") beside the path.
  const partLabel = S.stepPart === "rest" ? "Rest" : (currentGuideEntry()?.part?.title ?? "");
  if (partLabel) {
    const label = document.createElement("span");
    label.className = "fb-part";
    label.title = partLabel;
    label.textContent = partLabel;
    lead.push(label);
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
  mount(el, [...lead, openEditorButton(), grow, counts, sep, fileActions(f.path, jumpable)], mini);
  return el;
}

// Swap the bar's contents but leave the pinned guide line where it is when it stays: detaching it
// would replay its entrance and drop an open note's scroll, selection and focus.
function mount(el: HTMLElement, kids: Node[], mini: HTMLElement | null) {
  const keep = mini && mini.parentNode === el ? mini : null;
  for (const c of Array.from(el.childNodes)) if (c !== keep) c.remove();
  if (keep) keep.before(...kids);
  else el.append(...kids, ...(mini ? [mini] : []));
}

// A step as the end row names it: the file's name, then its part's title, or "Rest of <name>".
function stepName(step: Step): Node[] {
  const path = S.state.files[step.fileIndex]?.path ?? "";
  const name = splitPath(path).name;
  if (step.part === "rest") return [document.createTextNode(`Rest of ${name}`)];
  const title =
    typeof step.part === "number" ? S.state.guide?.files[step.part]?.part?.title : undefined;
  if (!title) return [document.createTextNode(name)];
  const part = document.createElement("span");
  part.className = "fe-part";
  part.textContent = title;
  return [document.createTextNode(`${name} `), part];
}

// The row after the step's last line: "End of <step> · next: <step> ⇧→" and the step's sign-off,
// so a reviewer who read to the bottom acts there instead of scrolling back to the bar. Next is
// the step ⇧→ opens in review order (a part, a Rest, or a file), left out on the last one (⇧→ only
// wraps from there). A finished step shows its quiet state in the button's place; Reset stays in
// the bar.
export function fileEnd(): HTMLElement {
  const path = currentFile().path;
  const row = document.createElement("div");
  row.className = "file-end";
  const text = document.createElement("span");
  text.className = "fe-text";
  const name = document.createElement("b");
  name.append(...stepName(currentStep()));
  text.append("End of ", name);
  const next = nextStep(currentStep());
  if (next && S.state.files[next.fileIndex]) {
    const go = document.createElement("button");
    go.className = "fe-next";
    go.append(...stepName(next));
    go.title = S.state.files[next.fileIndex]!.path;
    go.onclick = () => S.nextFile?.();
    text.append(" · next: ", go, keycapsNode(document, "⇧→"));
  }
  const { finished, objections } = stepStand(path);
  row.append(text, finished ? signedOffState(objections) : signOffButton(objections, false));
  return row;
}

// The open threads whose anchor line no longer renders, read before the diff (under the bar and
// the guide card) so they stay actionable: they block approval until resolved. Null when there are
// none.
export function fileLead(): HTMLElement | null {
  const orphans = unanchoredThreads();
  if (!orphans.length) return null;
  const lead = document.createElement("div");
  lead.className = "file-lead";
  lead.appendChild(unanchoredBlock(orphans));
  return lead;
}
