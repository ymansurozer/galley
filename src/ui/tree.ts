import { S, $, esc } from "./store";
import { render } from "./render";
import { stageFile, unstageFile } from "./decisions";

export function buildFileTree() {
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
  const out: string[] = [];
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
  function walk(node: any, depth: number) {
    [...node.dirs.values()].sort((a: any, b: any) => a.name.localeCompare(b.name)).forEach((dir: any) => {
      const changedCount = countChanged(dir);
      const open = S.expandedDirs.has(dir.full) || dir.changed;
      out.push(`<div class="node ${dir.changed ? "changed" : ""} indent-${Math.min(depth, 3)}" data-dir="${esc(dir.full)}"><span>${open ? "▾" : "▸"}</span><span>${esc(dir.name)}</span><span class="count">${changedCount || ""}</span></div>`);
      if (open) walk(dir, depth + 1);
    });
    node.files.sort((a: any, b: any) => a.name.localeCompare(b.name)).forEach((file: any) => renderFile(file, depth));
  }
  function renderFile(file: any, depth: number) {
    const comments = S.state.comments.filter((c: any) => c.path === file.path);
    const openComments = comments.filter((c: any) => c.status === "open" && c.role !== "agent").length;
    const reviewed = S.state.reviewedFiles?.includes(file.path);
    const staged = S.state.stagedFiles?.includes(file.path);
    const decisions = S.state.changes.filter((c: any) => c.path === file.path);
    const decided = decisions.length > 0 && decisions.every((c: any) => c.status !== "pending");
    const active = file.index === S.fileIndex;
    const clickable = file.index !== undefined;
    const hasTests = file.tests.length > 0;
    const changedTests = file.tests.some((t: any) => t.changed && !S.state.stagedFiles?.includes(t.path));
    const changedish = (file.changed || changedTests) && !staged;
    const open = hasTests && (S.expandedDirs.has(`tests:${file.path}`) || changedTests);
    const git = file.changed || staged ? `<button class="git-action ${staged ? "unstage" : "stage"}" data-git-path="${esc(file.path)}" data-git-action="${staged ? "unstage" : "stage"}" title="${staged ? "Unstage file" : "Stage file"}">${staged ? "−" : "+"}</button>` : "";
    const statuses = `<span class="status-pack">${!decided && file.changed && !staged ? '<span class="state-icon pending-decisions" title="Unresolved changes">◇</span>' : ""}${openComments ? '<span class="state-icon comments-open" title="Unresolved comments">⋯</span>' : ""}${reviewed ? '<span class="state-icon viewed" title="Viewed">✓</span>' : ""}</span>`;
    out.push(`<div class="node ${active ? "active" : ""} ${changedish ? "changed" : ""} indent-${Math.min(depth, 3)}" ${clickable ? `data-file="${file.index}"` : ""}><span>${esc(file.name)}</span>${hasTests && !reviewed && !decided && !comments.length ? `<span data-test-dir="tests:${esc(file.path)}">${open ? "▾" : "▸"}</span>` : statuses}${git}</div>`);
    if (open) file.tests.sort((a: any, b: any) => Number(b.changed) - Number(a.changed) || a.name.localeCompare(b.name)).forEach((t: any) => renderTestFile(t, depth + 1));
  }
  function renderTestFile(file: any, depth: number) {
    const comments = S.state.comments.filter((c: any) => c.path === file.path);
    const openComments = comments.filter((c: any) => c.status === "open" && c.role !== "agent").length;
    const reviewed = S.state.reviewedFiles?.includes(file.path);
    const staged = S.state.stagedFiles?.includes(file.path);
    const decisions = S.state.changes.filter((c: any) => c.path === file.path);
    const decided = decisions.length > 0 && decisions.every((c: any) => c.status !== "pending");
    const active = file.index === S.fileIndex;
    const clickable = file.index !== undefined;
    const git = file.changed || staged ? `<button class="git-action ${staged ? "unstage" : "stage"}" data-git-path="${esc(file.path)}" data-git-action="${staged ? "unstage" : "stage"}" title="${staged ? "Unstage file" : "Stage file"}">${staged ? "−" : "+"}</button>` : "";
    const statuses = `<span class="status-pack">${!decided && file.changed && !staged ? '<span class="state-icon pending-decisions" title="Unresolved changes">◇</span>' : ""}${openComments ? '<span class="state-icon comments-open" title="Unresolved comments">⋯</span>' : ""}${reviewed ? '<span class="state-icon viewed" title="Viewed">✓</span>' : ""}</span>`;
    out.push(`<div class="node ${active ? "active" : ""} ${file.changed && !staged ? "changed" : ""} test indent-${Math.min(depth, 3)}" ${clickable ? `data-file="${file.index}"` : ""}><span>${esc(file.name)}</span>${statuses}${git}</div>`);
  }
  function countChanged(node: any): number {
    let n = node.files.filter((f: any) => (f.changed && !S.state.stagedFiles?.includes(f.path)) || f.tests.some((t: any) => t.changed && !S.state.stagedFiles?.includes(t.path))).length;
    for (const child of node.dirs.values()) n += countChanged(child);
    return n;
  }
  groupTests(root);
  walk(root, 0);
  return out.join("");
}

export function sync() {
  document.body.classList.toggle("single", (S.state.files?.length || 0) <= 1);
  document.body.classList.toggle("file-mode", S.state.mode === "file");
  $("files").innerHTML = buildFileTree();
  document.querySelectorAll("[data-file]").forEach((n: any) => (n.onclick = () => { S.fileIndex = Number(n.dataset.file); S.fileDiff = null; render(); }));
  document.querySelectorAll("[data-dir]").forEach((n: any) => (n.onclick = () => { const dir = n.dataset.dir; if (S.expandedDirs.has(dir)) S.expandedDirs.delete(dir); else S.expandedDirs.add(dir); sync(); }));
  document.querySelectorAll("[data-test-dir]").forEach((n: any) => (n.onclick = (e: any) => { e.stopPropagation(); const dir = n.dataset.testDir; if (S.expandedDirs.has(dir)) S.expandedDirs.delete(dir); else S.expandedDirs.add(dir); sync(); }));
  document.querySelectorAll("[data-git-path]").forEach((n: any) => (n.onclick = async (e: any) => { e.stopPropagation(); const path = n.dataset.gitPath; if (n.dataset.gitAction === "unstage") await unstageFile(path); else await stageFile(path); }));
}
