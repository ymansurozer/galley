import { S } from "./store";
import { fileFinished, fileReviewState } from "./changes";
import type { TreeRow, TreeNode, TreeFile } from "./types";

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
  const root: TreeNode = { name: "", full: "", dirs: new Map(), files: [], changed: false };
  const changed = new Map(S.state.files.map((f, i) => [f.path, i]));
  const changedPaths = S.state.files.map((f) => f.path);
  // A reviewed file must always appear, even if it isn't in the project listing (a new/
  // untracked file, or a stale listing): union the listing with the changed files when
  // showing unchanged; otherwise just the changed files.
  const all =
    S.settings.showUnchanged && S.projectFiles.length
      ? [...new Set([...S.projectFiles, ...changedPaths])]
      : changedPaths;
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
  // A changed file's type, derived from its diff contents — drives the file-icon color.
  function changeType(file: TreeFile): "new" | "modified" | "deleted" | null {
    if (file.index === undefined) return null;
    const sf = S.state.files[file.index];
    if (!sf) return null;
    if (!sf.oldFile?.contents && sf.newFile?.contents) return "new";
    if (!sf.newFile?.contents && sf.oldFile?.contents) return "deleted";
    return "modified";
  }

  const rows: TreeRow[] = [];
  // Indentation is computed (--depth feeds calc() in .node), not a class set — fixed
  // indent-N classes capped at 3 levels and flattened anything deeper.
  const indent = (d: number) => (d ? `--depth:${d}` : "");

  function fileRow(file: TreeFile, depth: number, isTest: boolean) {
    const comments = S.state.comments.filter((c) => c.path === file.path);
    const decisions = S.state.changes.filter((c) => c.path === file.path);
    const decided = decisions.length > 0 && decisions.every((c) => c.status !== "pending");
    const finished = fileFinished(file.path);
    // Single review-state badge for a changed file: pending / approved / changes-requested.
    const state = file.changed ? fileReviewState(file.path) : null;
    // No file is "active" while the guide Overview is showing (nothing is being viewed yet).
    // While previewing an opened file, the previewed path is active (it may be unchanged, so
    // it has no fileIndex); otherwise the indexed review file is active.
    const active = S.overviewOpen
      ? false
      : S.preview
        ? S.preview.path === file.path
        : file.index === S.fileIndex;
    const hasTests = !isTest && file.tests.length > 0;
    // A changed test stays revealed for its whole lifecycle (like any changed file) so it doesn't
    // vanish from the tree the moment it's approved — only *unchanged* sibling tests stay folded.
    const changedTests = !isTest && file.tests.some((t) => t.changed);
    // The parent filename reads as "needs attention" (cyan) only while a changed test is still
    // pending; once every changed test is signed off, the parent goes neutral (dealt with).
    const pendingChangedTests =
      !isTest && file.tests.some((t) => t.changed && fileReviewState(t.path) === "pending");
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
      cls: [active ? "active" : "", changedish ? "changed" : "", isTest ? "test" : ""]
        .filter(Boolean)
        .join(" "),
      style: indent(depth),
      path: file.path,
      fileIndex: file.index,
      testToggle: showTestToggle,
      testKey: `tests:${file.path}`,
      testCaret: testOpen ? "▾" : "▸",
      changeType: changedish ? changeType(file) : null,
      state: showTestToggle ? null : state,
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

  groupTests(root);
  walk(root, 0);
  return rows;
}

// Layout classes were toggled inside the old sync(); render() calls this now.
export function applyLayoutClasses() {
  document.body.classList.toggle("single", (S.state.files?.length || 0) <= 1);
  document.body.classList.toggle("file-mode", S.state.mode === "file");
}
