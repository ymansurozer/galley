import { S } from "./store";
import { flowIndex } from "./changes";
import { movedFrom, isSkimGroupExpanded } from "./skim";
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

// Pure data: the flat, ordered list of tree rows the template renders with x-for.
// (Replaces the old buildFileTree HTML-string builder + sync() DOM wiring.)
export function treeRows(): TreeRow[] {
  if (!S.state) return []; // template may evaluate before the initial fetch
  // One O(changes+comments+files) pass for everything each row needs — per-row predicate calls
  // rescanned the global arrays and froze big desks (see flow-index.ts). Built fresh per
  // evaluation so Alpine's dependency tracking stays intact.
  const ix = flowIndex();
  const root: TreeNode = { name: "", full: "", dirs: new Map(), files: [], changed: false };
  const changed = new Map(S.state.files.map((f, i) => [f.path, i]));
  const changedPaths = S.state.files.map((f) => f.path);
  // Files out of the main flow (fully skimmed, or pure renames — issue 01/07) leave the main
  // listing and gather in the collapsed group at the bottom — so they don't mark their folders as
  // changed and don't clutter the tree.
  const skimmedPaths = changedPaths.filter((p) => ix.outOfFlow.has(p));
  const skimmedSet = new Set(skimmedPaths);
  // A reviewed file must always appear, even if it isn't in the project listing (a new/
  // untracked file, or a stale listing): union the listing with the changed files when
  // showing unchanged; otherwise just the changed files. Fully-skimmed files are held back.
  const all = (
    S.settings.showUnchanged && S.projectFiles.length
      ? [...new Set([...S.projectFiles, ...changedPaths])]
      : changedPaths
  ).filter((p) => !skimmedSet.has(p));
  all.forEach((path) => {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    const stack: TreeNode[] = [root];
    let full = "";
    for (const part of parts.slice(0, -1)) {
      full = full ? `${full}/${part}` : part;
      if (!node.dirs.has(part))
        node.dirs.set(part, { name: part, full, dirs: new Map(), files: [], changed: false });
      node = node.dirs.get(part)!;
      stack.push(node);
    }
    const isChanged = changed.has(path);
    // A folder counts as part of the review (open by default) if it holds any reviewed file,
    // staged or not — so staging a file doesn't flip its folder to "unchanged" and collapse it.
    if (isChanged) stack.forEach((n) => (n.changed = true));
    node.files.push({
      name: parts.at(-1) || path,
      index: changed.get(path),
      changed: isChanged,
      path,
      tests: [],
    });
  });

  function groupTests(node: TreeNode) {
    const byName = new Map(node.files.map((f) => [f.name, f]));
    for (const f of node.files) {
      const m = f.name.match(/^(.*)\.(test|spec)(\.[^.]+)$/);
      if (!m) continue;
      const parent = byName.get(`${m[1]}${m[3]}`);
      if (parent) {
        parent.tests.push(f);
        if (f.changed && !S.state.stagedFiles?.includes(f.path)) parent.changed = true;
        f.folded = true;
      }
    }
    node.files = node.files.filter((f) => !f.folded);
    for (const child of node.dirs.values()) groupTests(child);
  }
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
    // The parent filename reads as "needs attention" (cyan) only while a changed test is still
    // pending; once every changed test is signed off, the parent goes neutral (dealt with).
    const pendingChangedTests =
      !isTest && file.tests.some((t) => t.changed && ix.reviewState(t.path) === "pending");
    // "Changed" (cyan) filename = still needs attention: a pending changed file, or a child test
    // that's still pending. Approved / changes-requested files read as neutral (dealt with).
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
    if (testOpen)
      file.tests
        .sort((a, b) => Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name))
        .forEach((t) => fileRow(t, depth + 1, true));
  }

  function walk(node: TreeNode, depth: number) {
    [...node.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((dir) => {
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
        if (open) walk(dir, depth + 1);
      });
    node.files
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((file) => fileRow(file, depth, false));
  }

  // A flat, muted row for a fully-skimmed file inside the collapsed group: no state badge and no
  // "changed" cyan (it's out of the flow), just the skim indicator. Clicking opens it like any
  // file — its file/block skim strips render as issue 06 built.
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

  groupTests(root);
  walk(root, 0);
  // The collapsed "Skimmed · N files" group at the very bottom — the test-fold precedent, but a
  // flat group (no nesting). Expand state is per-session (isSkimGroupExpanded).
  if (skimmedPaths.length) {
    const open = isSkimGroupExpanded();
    rows.push({
      kind: "skimgrp",
      key: "skimgrp",
      count: skimmedPaths.length,
      open,
      caret: open ? "▾" : "▸",
    });
    if (open)
      [...skimmedPaths]
        .sort((a, b) => a.localeCompare(b))
        .forEach((p) => rows.push(skimFileRow(p)));
  }
  return rows;
}

// Layout classes were toggled inside the old sync(); render() calls this now.
export function applyLayoutClasses() {
  document.body.classList.toggle("single", (S.state.files?.length || 0) <= 1);
  document.body.classList.toggle("file-mode", S.state.mode === "file");
}

// The sidebar's "active" highlight, patched in place instead of derived in the row models.
// Deriving it made treeRows()/walkthroughRows() depend on S.fileIndex/S.preview/S.overviewOpen,
// so every file switch re-ran both x-fors — thousands of row bindings re-evaluated to move one
// highlight (the dominant per-switch cost on big desks). Same pattern as updateAwaitingDom:
// selectFile calls this directly, and render() re-applies it after Alpine's flush (an rAF later,
// so freshly re-keyed rows get the class back — Alpine's :class diff only removes classes it
// added itself, so this manual class survives binding re-evaluation on reused elements).
// No file is "active" on the Overview; a previewed file wins over the indexed review file.
export function applyActiveRow() {
  const path = S.overviewOpen
    ? null
    : (S.preview?.path ?? S.state?.files?.[S.fileIndex]?.path ?? null);
  for (const el of document.querySelectorAll("#files .node.active, #walk .node.active"))
    el.classList.remove("active");
  if (!path) return;
  for (const key of [`file:${path}`, `test:${path}`])
    for (const el of document.querySelectorAll(`.node[data-key="${CSS.escape(key)}"]`))
      el.classList.add("active");
}
