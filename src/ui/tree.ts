import { S } from "./store";
import type { TreeRow, TreeNode, TreeFile } from "./types";

// Pure data: the flat, ordered list of tree rows the template renders with x-for.
// (Replaces the old buildFileTree HTML-string builder + sync() DOM wiring.)
export function treeRows(): TreeRow[] {
  if (!S.state) return []; // template may evaluate before the initial fetch
  const root: TreeNode = { name: "", full: "", dirs: new Map(), files: [], changed: false };
  const changed = new Map(S.state.files.map((f, i) => [f.path, i]));
  const all = S.settings.showUnchanged && S.projectFiles.length ? S.projectFiles : S.state.files.map((f) => f.path);
  all.forEach((path) => {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    const stack: TreeNode[] = [root];
    let full = "";
    for (const part of parts.slice(0, -1)) {
      full = full ? `${full}/${part}` : part;
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, full, dirs: new Map(), files: [], changed: false });
      node = node.dirs.get(part)!;
      stack.push(node);
    }
    const isChanged = changed.has(path);
    const isStaged = S.state.stagedFiles?.includes(path);
    if (isChanged && !isStaged) stack.forEach((n) => (n.changed = true));
    node.files.push({ name: parts.at(-1) || path, index: changed.get(path), changed: isChanged, path, tests: [] });
  });

  function groupTests(node: TreeNode) {
    const byName = new Map(node.files.map((f) => [f.name, f]));
    for (const f of node.files) {
      const m = f.name.match(/^(.*)\.(test|spec)(\.[^.]+)$/);
      if (!m) continue;
      const parent = byName.get(`${m[1]}${m[3]}`);
      if (parent) { parent.tests.push(f); if (f.changed && !S.state.stagedFiles?.includes(f.path)) parent.changed = true; f.folded = true; }
    }
    node.files = node.files.filter((f) => !f.folded);
    for (const child of node.dirs.values()) groupTests(child);
  }
  function countChanged(node: TreeNode): number {
    let n = node.files.filter((f) => (f.changed && !S.state.stagedFiles?.includes(f.path)) || f.tests.some((t) => t.changed && !S.state.stagedFiles?.includes(t.path))).length;
    for (const child of node.dirs.values()) n += countChanged(child);
    return n;
  }

  const rows: TreeRow[] = [];
  const indent = (d: number) => `indent-${Math.min(d, 3)}`;

  function fileRow(file: TreeFile, depth: number, isTest: boolean) {
    const comments = S.state.comments.filter((c) => c.path === file.path);
    const openComments = comments.filter((c) => c.status === "open" && c.role !== "agent").length;
    const reviewed = S.state.reviewedFiles?.includes(file.path);
    const staged = S.state.stagedFiles?.includes(file.path);
    const decisions = S.state.changes.filter((c) => c.path === file.path);
    const decided = decisions.length > 0 && decisions.every((c) => c.status !== "pending");
    const active = file.index === S.fileIndex;
    const hasTests = !isTest && file.tests.length > 0;
    const changedTests = !isTest && file.tests.some((t) => t.changed && !S.state.stagedFiles?.includes(t.path));
    const changedish = (file.changed || changedTests) && !staged;
    const testOpen = hasTests && (S.expandedDirs.has(`tests:${file.path}`) || changedTests);
    // Original: a file with tests shows the test-toggle caret instead of badges
    // only when it's otherwise "quiet" (not reviewed/decided/commented).
    const showTestToggle = hasTests && !reviewed && !decided && !comments.length;
    rows.push({
      key: (isTest ? "test:" : "file:") + file.path,
      kind: isTest ? "test" : "file",
      depth,
      name: file.name,
      cls: [active ? "active" : "", changedish ? "changed" : "", isTest ? "test" : "", indent(depth)].filter(Boolean).join(" "),
      path: file.path,
      fileIndex: file.index,
      testToggle: showTestToggle,
      testKey: `tests:${file.path}`,
      testCaret: testOpen ? "▾" : "▸",
      badges: showTestToggle ? null : { pending: !decided && file.changed && !staged, comments: openComments > 0, viewed: !!reviewed },
      git: file.changed || staged ? (staged ? "unstage" : "stage") : null,
      gitSymbol: staged ? "−" : "+",
    });
    if (testOpen) file.tests.sort((a, b) => Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name)).forEach((t) => fileRow(t, depth + 1, true));
  }

  function walk(node: TreeNode, depth: number) {
    [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((dir) => {
      const open = S.expandedDirs.has(dir.full) || dir.changed;
      const count = countChanged(dir);
      rows.push({ key: "dir:" + dir.full, kind: "dir", depth, name: dir.name, cls: [dir.changed ? "changed" : "", indent(depth)].filter(Boolean).join(" "), full: dir.full, dirCaret: open ? "▾" : "▸", count });
      if (open) walk(dir, depth + 1);
    });
    node.files.sort((a, b) => a.name.localeCompare(b.name)).forEach((file) => fileRow(file, depth, false));
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
