import { S } from "./store";

// Pure data: the flat, ordered list of tree rows the template renders with x-for.
// (Replaces the old buildFileTree HTML-string builder + sync() DOM wiring.)
export function treeRows() {
  if (!S.state) return []; // template may evaluate before the initial fetch
  const root: any = { name: "", full: "", dirs: new Map(), files: [], changed: false };
  const changed = new Map(S.state.files.map((f: any, i: number) => [f.path, i]));
  const all = S.projectFiles.length ? S.projectFiles : S.state.files.map((f: any) => f.path);
  all.forEach((path: string) => {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    const stack = [root];
    let full = "";
    for (const part of parts.slice(0, -1)) {
      full = full ? `${full}/${part}` : part;
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, full, dirs: new Map(), files: [], changed: false });
      node = node.dirs.get(part);
      stack.push(node);
    }
    const isChanged = changed.has(path);
    const isStaged = S.state.stagedFiles?.includes(path);
    if (isChanged && !isStaged) stack.forEach((n) => (n.changed = true));
    node.files.push({ name: parts.at(-1) || path, index: changed.get(path), changed: isChanged, path, tests: [] });
  });

  function groupTests(node: any) {
    const byName = new Map(node.files.map((f: any) => [f.name, f]));
    for (const f of node.files) {
      const m = f.name.match(/^(.*)\.(test|spec)(\.[^.]+)$/);
      if (!m) continue;
      const parent: any = byName.get(`${m[1]}${m[3]}`);
      if (parent) { parent.tests.push(f); if (f.changed && !S.state.stagedFiles?.includes(f.path)) parent.changed = true; f.folded = true; }
    }
    node.files = node.files.filter((f: any) => !f.folded);
    for (const child of node.dirs.values()) groupTests(child);
  }
  function countChanged(node: any): number {
    let n = node.files.filter((f: any) => (f.changed && !S.state.stagedFiles?.includes(f.path)) || f.tests.some((t: any) => t.changed && !S.state.stagedFiles?.includes(t.path))).length;
    for (const child of node.dirs.values()) n += countChanged(child);
    return n;
  }

  const rows: any[] = [];
  const indent = (d: number) => `indent-${Math.min(d, 3)}`;

  function fileRow(file: any, depth: number, isTest: boolean) {
    const comments = S.state.comments.filter((c: any) => c.path === file.path);
    const openComments = comments.filter((c: any) => c.status === "open" && c.role !== "agent").length;
    const reviewed = S.state.reviewedFiles?.includes(file.path);
    const staged = S.state.stagedFiles?.includes(file.path);
    const decisions = S.state.changes.filter((c: any) => c.path === file.path);
    const decided = decisions.length > 0 && decisions.every((c: any) => c.status !== "pending");
    const active = file.index === S.fileIndex;
    const hasTests = !isTest && file.tests.length > 0;
    const changedTests = !isTest && file.tests.some((t: any) => t.changed && !S.state.stagedFiles?.includes(t.path));
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
    if (testOpen) file.tests.sort((a: any, b: any) => Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name)).forEach((t: any) => fileRow(t, depth + 1, true));
  }

  function walk(node: any, depth: number) {
    [...node.dirs.values()].sort((a: any, b: any) => a.name.localeCompare(b.name)).forEach((dir: any) => {
      const open = S.expandedDirs.has(dir.full) || dir.changed;
      const count = countChanged(dir);
      rows.push({ key: "dir:" + dir.full, kind: "dir", depth, name: dir.name, cls: [dir.changed ? "changed" : "", indent(depth)].filter(Boolean).join(" "), full: dir.full, dirCaret: open ? "▾" : "▸", count });
      if (open) walk(dir, depth + 1);
    });
    node.files.sort((a: any, b: any) => a.name.localeCompare(b.name)).forEach((file: any) => fileRow(file, depth, false));
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
