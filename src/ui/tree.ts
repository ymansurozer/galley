import { S } from "./store";
import { flowIndex } from "./changes";
import type { FlowIndex } from "./flow-index";
import { movedFrom, isSkimGroupExpanded } from "./skim";
import { fileTree, treeFileOrder, walkTree } from "./tree-derive";
import type { TreeRow, TreeNode, TreeFile, FileRow } from "./types";

// Every directory path in the tree (independent of current open/closed state) — used by
// the collapse-all / expand-all control.
export function allDirPaths(): string[] {
  if (!S.state) return [];
  const changedPaths = S.state.files.map((f) => f.path);
  const all =
    S.settings.showUnchanged && S.projectFiles.length
      ? [...new Set([...S.projectFiles, ...changedPaths])]
      : changedPaths;
  const dirs = new Set<string>();
  for (const p of all) {
    const parts = p.split("/").filter(Boolean);
    let full = "";
    for (let i = 0; i < parts.length - 1; i++) {
      full = full ? `${full}/${parts[i]}` : parts[i]!;
      dirs.add(full);
    }
  }
  return [...dirs];
}

// Folders containing a "touched" file — one in the review (changed/staged) or carrying a
// comment. These are what "expand all" opens (purely-unchanged folders stay closed).
export function touchedDirPaths(): string[] {
  if (!S.state) return [];
  const touched = new Set<string>([
    ...(S.state.files ?? []).map((f) => f.path),
    ...(S.state.comments ?? []).map((c) => c.path),
  ]);
  const dirs = new Set<string>();
  for (const p of touched) {
    const parts = p.split("/").filter(Boolean);
    let full = "";
    for (let i = 0; i < parts.length - 1; i++) {
      full = full ? `${full}/${parts[i]}` : parts[i]!;
      dirs.add(full);
    }
  }
  return [...dirs];
}

// The Files tab's tree over what it lists: every reviewed file (plus the project listing when
// unchanged files are shown) except those out of the main flow (fully skimmed, or pure renames —
// issue 01/07), which leave the folders and gather, sorted by path, in the collapsed Skimmed group
// at the bottom — so they don't mark their folders as changed and don't clutter the tree.
// treeRows renders it; treeOrder reads the no-guide review order off it.
function sidebarTree(ix: FlowIndex) {
  const changed = new Map(S.state.files.map((f, i) => [f.path, i]));
  const changedPaths = S.state.files.map((f) => f.path);
  const skimmed = changedPaths.filter((p) => ix.outOfFlow.has(p));
  const skimmedSet = new Set(skimmed);
  // A reviewed file must always appear, even if it isn't in the project listing (a new/
  // untracked file, or a stale listing): union the listing with the changed files when
  // showing unchanged; otherwise just the changed files. Fully-skimmed files are held back.
  const all = (
    S.settings.showUnchanged && S.projectFiles.length
      ? [...new Set([...S.projectFiles, ...changedPaths])]
      : changedPaths
  ).filter((p) => !skimmedSet.has(p));
  const root = fileTree(all, changed, S.state.stagedFiles ?? []);
  return { root, changed, skimmed: skimmed.sort((a, b) => a.localeCompare(b)) };
}

// state.files indices in the Files tab's top-to-bottom order with every folder open — the
// folders, then the Skimmed group — which review order follows when there's no guide. It is the
// order of what the tree SHOWS: with unchanged files shown, a changed test whose unchanged source
// file is listed folds beneath it, and "next" follows it there — that is the row below.
//
// Memoized: the nav buttons' bindings, the seeks, and the next-file prefetch all read it, and a
// rebuild sorts every listed path (the whole project listing with unchanged files shown). The
// key reads each input the order depends on, so an Alpine effect that hits the memo still tracks
// them and re-runs when one changes. state.files and projectFiles are replaced wholesale (never
// mutated in place), so identity stands in for their contents; stagedFiles is left out — it only
// flags a test's parent changed, which never reorders the reviewed files.
let orderMemo: { key: unknown[]; order: readonly number[] } | null = null;
export function treeOrder(ix: FlowIndex): readonly number[] {
  if (!S.state) return []; // the nav-button bindings evaluate before the initial fetch
  const key = [
    S.state.files,
    S.settings.showUnchanged,
    S.projectFiles,
    [...ix.outOfFlow].join("\n"),
  ];
  const memo = orderMemo;
  if (memo && key.every((k, i) => k === memo.key[i])) return memo.order;
  const { root, changed, skimmed } = sidebarTree(ix);
  const order = treeFileOrder(root).concat(skimmed.flatMap((p) => changed.get(p) ?? []));
  orderMemo = { key, order };
  return order;
}

// Pure data: the flat, ordered list of tree rows the template renders with x-for.
// (Replaces the old buildFileTree HTML-string builder + sync() DOM wiring.)
export function treeRows(): TreeRow[] {
  if (!S.state) return []; // template may evaluate before the initial fetch
  // One O(changes+comments+files) pass for everything each row needs — per-row predicate calls
  // rescanned the global arrays and froze big desks (see flow-index.ts). Built fresh per
  // evaluation so Alpine's dependency tracking stays intact.
  const ix = flowIndex();
  const { root, changed, skimmed } = sidebarTree(ix);
  // A changed file's type — drives the file-icon color. Reads the lean builder's `changeKind` stamp
  // (issue 04) instead of the embedded contents; a rename shows as "modified" (its icon), like before.
  function changeType(file: TreeFile): "new" | "modified" | "deleted" | null {
    if (file.index === undefined) return null;
    const sf = S.state.files[file.index];
    if (!sf) return null;
    if (sf.changeKind === "added") return "new";
    if (sf.changeKind === "deleted") return "deleted";
    return "modified";
  }

  const rows: TreeRow[] = [];
  // Indentation is computed (--depth feeds calc() in .node), not a class set — fixed
  // indent-N classes capped at 3 levels and flattened anything deeper.
  const indent = (d: number) => (d ? `--depth:${d}` : "");

  // Pushes the file's row; returns whether its test fold is open (walkTree then visits the tests).
  function fileRow(file: TreeFile, depth: number, isTest: boolean) {
    const comments = ix.commentsByPath.get(file.path) ?? [];
    const decisions = ix.changesByPath.get(file.path) ?? [];
    const decided = decisions.length > 0 && decisions.every((c) => c.status !== "pending");
    const finished = ix.finished(file.path);
    // Single review-state badge for a changed file: pending / approved / changes-requested.
    const state = file.changed ? ix.reviewState(file.path) : null;
    // NOTE: the "active" highlight is deliberately NOT part of the row model. Deriving it here
    // read S.fileIndex/S.preview/S.overviewOpen, which made EVERY file switch a dependency-
    // triggered rebuild of the whole x-for (1,600+ rows re-bound to move one highlight — the
    // dominant per-switch cost on big desks). applyActiveRow() patches the class imperatively.
    const hasTests = !isTest && file.tests.length > 0;
    // A changed test stays revealed for its whole lifecycle (like any changed file) so it doesn't
    // vanish from the tree the moment it's approved — only *unchanged* sibling tests stay folded.
    const changedTests = !isTest && file.tests.some((t) => t.changed);
    // The parent filename reads as "needs attention" (full ink) only while a changed test is still
    // pending; once every changed test is signed off, the parent goes neutral (dealt with).
    const pendingChangedTests =
      !isTest && file.tests.some((t) => t.changed && ix.reviewState(t.path) === "pending");
    // "Changed" (full-ink) filename = still needs attention: a pending changed file, or a child
    // test that's still pending. Approved / changes-requested files read as neutral (dealt with).
    const changedish = (file.changed && state === "pending") || pendingChangedTests;
    const testOpen = hasTests && (S.expandedDirs.has(`tests:${file.path}`) || changedTests);
    // A file with tests shows the test-toggle caret instead of a badge only when it's otherwise
    // "quiet" (not finished / decided / commented).
    const showTestToggle = hasTests && !finished && !decided && !comments.length;
    rows.push({
      key: (isTest ? "test:" : "file:") + file.path,
      kind: isTest ? "test" : "file",
      depth,
      name: file.name,
      cls: [changedish ? "changed" : "", isTest ? "test" : ""].filter(Boolean).join(" "),
      style: indent(depth),
      path: file.path,
      fileIndex: file.index,
      testToggle: showTestToggle,
      testKey: `tests:${file.path}`,
      testCaret: testOpen ? "▾" : "▸",
      changeType: changedish ? changeType(file) : null,
      state: showTestToggle ? null : state,
      skim: file.changed && ix.fullySkimmed.has(file.path),
    });
    return testOpen;
  }

  function dirRow(dir: TreeNode, depth: number) {
    // Changed folders default open (collapsible via collapsedDirs); unchanged default
    // closed (expandable via expandedDirs). Either way the chevron toggles.
    const open = dir.changed ? !S.collapsedDirs.has(dir.full) : S.expandedDirs.has(dir.full);
    rows.push({
      key: "dir:" + dir.full,
      kind: "dir",
      depth,
      name: dir.name,
      cls: dir.changed ? "changed" : "",
      style: indent(depth),
      full: dir.full,
      dirCaret: open ? "▾" : "▸",
      open,
      changed: dir.changed,
    });
    return open;
  }

  // A flat, muted row for a fully-skimmed file inside the collapsed group: no state badge and no
  // "changed" full-ink name (it's out of the flow), just the skim indicator. Clicking opens it like
  // any file — its file/block skim strips render as issue 06 built.
  function skimFileRow(path: string): FileRow {
    const index = changed.get(path);
    return {
      key: "file:" + path,
      kind: "file",
      depth: 1,
      name: path.split("/").pop() || path,
      cls: "", // "active" is patched imperatively — see applyActiveRow

      style: indent(1),
      path,
      fileIndex: index,
      testToggle: false,
      testKey: "",
      testCaret: "▸",
      changeType: null,
      state: null,
      // A pure rename shows a "← old" arrow instead of the skim indicator (it's moved, not skimmed).
      skim: !movedFrom(path),
      movedFrom: movedFrom(path) || undefined,
    };
  }

  walkTree(root, dirRow, fileRow);
  // The collapsed "Skimmed · N files" group at the very bottom — the test-fold precedent, but a
  // flat group (no nesting). Expand state is per-session (isSkimGroupExpanded).
  if (skimmed.length) {
    const open = isSkimGroupExpanded();
    rows.push({
      kind: "skimgrp",
      key: "skimgrp",
      count: skimmed.length,
      open,
      caret: open ? "▾" : "▸",
    });
    if (open) skimmed.forEach((p) => rows.push(skimFileRow(p)));
  }
  return rows;
}

// Layout classes were toggled inside the old sync(); render() calls this now.
export function applyLayoutClasses() {
  document.body.classList.toggle("single", (S.state.files?.length || 0) <= 1);
  document.body.classList.toggle("file-mode", S.state.mode === "file");
}

// The file the sidebar last followed. Following runs only when the active file changes, not on
// every render()'s re-apply — so a decision or a reload never re-opens a folder the reviewer
// collapsed, or scrolls back a sidebar they scrolled away. (A tab switch re-scrolls without
// re-revealing — see showActiveRow.)
let followed: string | null = null;

// The sidebar's "active" highlight, patched in place instead of derived in the row models.
// Deriving it made treeRows()/walkthroughRows() depend on S.fileIndex/S.preview/S.overviewOpen,
// so every file switch re-ran both x-fors — thousands of row bindings re-evaluated to move one
// highlight (the dominant per-switch cost on big desks). Same pattern as updateAwaitingDom:
// selectFile calls this directly, and render() re-applies it after Alpine's flush (an rAF later,
// so freshly re-keyed rows get the class back — Alpine's :class diff only removes classes it
// added itself, so this manual class survives binding re-evaluation on reused elements).
// On the Overview the Review tab's Overview row is "active" and no file is; a previewed file wins
// over the indexed review file.
// It is also the one place the sidebar follows the active file (followActiveRow), whatever moved
// it — a click, ⇧←/→, ⌘⇧↑/↓, approve-advance, a wrap seek.
export function applyActiveRow() {
  const path = S.overviewOpen
    ? null
    : (S.preview?.path ?? S.state?.files?.[S.fileIndex]?.path ?? null);
  for (const el of document.querySelectorAll(".tree .node.active")) el.classList.remove("active");
  if (S.overviewOpen)
    document.querySelector('.side-nav .node[data-key="overview"]')?.classList.add("active");
  if (path)
    for (const key of [`file:${path}`, `test:${path}`])
      for (const el of document.querySelectorAll(`.node[data-key="${CSS.escape(key)}"]`))
        el.classList.add("active");
  if (path === followed) return;
  followed = path;
  if (path) followActiveRow(path);
}

// Bring the active row into view: open the collapsed folders above it, then scroll to it. A
// reviewed in-flow file's folders are all changed ones (open unless in collapsedDirs) and, as a
// changed test, it holds its parent's test fold open. A preview can open without its row showing
// (`]` to a change request on an unchanged file), and its folders may be unchanged ones, closed
// unless in expandedDirs; with unchanged files hidden it has no row at all. An out-of-flow file
// sits in the Skimmed group instead.
function followActiveRow(path: string) {
  const reveal = S.preview ? S.settings.showUnchanged : !flowIndex().outOfFlow.has(path);
  if (reveal) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      S.collapsedDirs.delete(dir);
      if (S.preview) S.expandedDirs.add(dir);
    }
  }
  showActiveRow();
}

// Scroll the visible sidebar list (Files or Review; the other is display:none) just enough
// to show the active row, "nearest"-style, so a row already in view never moves. An rAF later,
// once Alpine's flush has rendered the rows a reveal just opened. main.ts setSidebarTab calls it
// too: a follow made while that list was hidden couldn't scroll it.
// The list's own scrollTop, not scrollIntoView, which would also scroll the off-canvas drawer.
export function showActiveRow() {
  requestAnimationFrame(() => {
    applyActiveRow(); // rows the reveal just rendered carry the class too
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const list of document.querySelectorAll<HTMLElement>("#files, #walk")) {
      const row = list.querySelector(".node.active");
      if (!row || !list.offsetParent) continue;
      const box = list.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      // Whole pixels, rounded away from the row: scrollTop snaps, and a fractional distance would
      // leave the row a sub-pixel short of fully visible.
      const by =
        r.top < box.top
          ? Math.floor(r.top - box.top)
          : Math.max(0, Math.ceil(r.bottom - box.bottom));
      if (by) list.scrollTo({ top: list.scrollTop + by, behavior: smooth ? "smooth" : "auto" });
    }
  });
}
