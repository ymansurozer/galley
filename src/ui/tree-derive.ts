import type { TreeFile, TreeNode } from "./types";

// Pure Files-tree derivation (store-free, so it's unit-testable — see skim-derive.ts for the
// pattern). The sidebar rows (tree.ts treeRows) and the no-guide review order (treeFileOrder →
// guide.ts navOrder) both read this one tree through this one walk, so "next file" is always the
// row below and the two can't drift.

// The tree over `paths`: folders nest by path segment, a test file (foo.test.ts / foo.spec.ts)
// folds beneath its sibling source file, and every level is sorted in display order — folders by
// name, then files by name, a file's tests changed-first then by name. `index` maps each reviewed
// path to its state.files index (absent → an unchanged project file); a changed test that isn't
// `staged` flags its parent changed.
export function fileTree(
  paths: string[],
  index: Map<string, number>,
  staged: readonly string[],
): TreeNode {
  const root: TreeNode = { name: "", full: "", dirs: new Map(), files: [], changed: false };
  paths.forEach((path) => {
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
    const isChanged = index.has(path);
    // A folder counts as part of the review (open by default) if it holds any reviewed file,
    // staged or not — so staging a file doesn't flip its folder to "unchanged" and collapse it.
    if (isChanged) stack.forEach((n) => (n.changed = true));
    node.files.push({
      name: parts.at(-1) || path,
      index: index.get(path),
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
        if (f.changed && !staged.includes(f.path)) parent.changed = true;
        f.folded = true;
      }
    }
    node.files = node.files.filter((f) => !f.folded);
    for (const child of node.dirs.values()) groupTests(child);
  }
  function sort(node: TreeNode) {
    node.dirs = new Map([...node.dirs].sort(([a], [b]) => a.localeCompare(b)));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    for (const f of node.files)
      f.tests.sort((a, b) => Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name));
    for (const child of node.dirs.values()) sort(child);
  }
  groupTests(root);
  sort(root);
  return root;
}

// Visit the tree top to bottom: a folder's subfolders, then its files, each file followed by its
// tests (one level — a test's own tests never show). `dir` returns whether to descend into the
// folder, `file` whether the file's tests follow it.
export function walkTree(
  node: TreeNode,
  dir: (d: TreeNode, depth: number) => boolean,
  file: (f: TreeFile, depth: number, isTest: boolean) => boolean,
  depth = 0,
) {
  for (const d of node.dirs.values()) if (dir(d, depth)) walkTree(d, dir, file, depth + 1);
  for (const f of node.files)
    if (file(f, depth, false)) for (const t of f.tests) file(t, depth + 1, true);
}

// The reviewed files' state.files indices in the tree's top-to-bottom order with every folder and
// test fold open — the order the reviewer reads the Files tab in.
export function treeFileOrder(root: TreeNode): number[] {
  const order: number[] = [];
  walkTree(
    root,
    () => true,
    (f) => {
      if (f.index !== undefined) order.push(f.index);
      return true;
    },
  );
  return order;
}
