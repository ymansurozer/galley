import { S, toast, api, persist } from "./store";
import { currentFile, fileFinished, fileObjections, flowIndex } from "./changes";
import { render, deferRender } from "./render";
import { currentStep, guideProgress, nextUnreviewedStep, reviewTally, stepSlot } from "./guide";
import {
  captureFileReview,
  clearFileReview,
  recordDecision,
  restoreFileReview,
  signOff,
  signOffStep,
  type FileReview,
} from "./decisions-derive";
import type { Step } from "./steps";
import type { Decision, IndexEntry, ReviewState } from "./types";

type ReviewFile = ReviewState["files"][number];

// Stage a whole file. A working-mode move pair (issue 02) stages BOTH paths — `git add`-ing the
// old (deleted) path records the deletion, so the index ends with a rename. Only in working-repo
// mode: pr approve is a pure verdict, and staged mode can't contain these pairs. stagedFiles
// still records the new path once, as for any file — and only once the index took it. api()
// resolves an error body too, so success is the body's `ok`; false means nothing was staged.
async function stageFile(file: ReviewFile): Promise<boolean> {
  const path = file.path;
  const moved = file.oldPath && file.newPath && file.oldPath !== file.newPath;
  const pairMove = moved && S.state.mode === "repo" && !S.state.staged;
  const body = pairMove ? { paths: [file.oldPath, path] } : { path };
  const res = await api<{ ok?: boolean }>("/api/stage", {
    method: "POST",
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res?.ok) return false;
  S.state.stagedFiles = S.state.stagedFiles || [];
  if (!S.state.stagedFiles.includes(path)) S.state.stagedFiles.push(path);
  return true;
}

// Stage (or take out of the index) single change blocks of a file, by `path:stableKey` key, one
// request at a time since each places its block on the index the last one left. Resolves to the
// keys whose blocks moved (one already that way is skipped) and whether every request went
// through. api() resolves an error body too, so success is the body's `ok`. A stage is recorded
// only once the index took it, as /api/restage records a file's.
async function moveBlocks(
  path: string,
  keys: string[],
  stage: boolean,
): Promise<{ moved: string[]; ok: boolean }> {
  const moved: string[] = [];
  let ok = true;
  for (const key of keys) {
    const res = await api<{ ok?: boolean; skipped?: boolean }>(
      stage ? "/api/stage-change" : "/api/unstage-change",
      { method: "POST", body: JSON.stringify({ path, stableKey: key.slice(path.length + 1) }) },
    ).catch(() => null);
    if (!res?.ok) ok = false;
    else if (!res.skipped) moved.push(key);
  }
  if (stage) {
    S.state.stagedChangeKeys = S.state.stagedChangeKeys || [];
    for (const key of moved)
      if (!S.state.stagedChangeKeys.includes(key)) S.state.stagedChangeKeys.push(key);
  }
  return { moved, ok };
}

// Files whose sign-off (of the file or one of its steps) is still staging. A Reset meanwhile would
// unstage before the stage landed, and the late stage would record the file as staged again under
// Reset's toast.
const signing = new Set<string>();

export function approveCurrentFile() {
  return approveFile(currentFile().path, { advance: true });
}

// ⇧A and the header's action: sign off the step on screen — a part or Rest step on its own, else
// the file.
export function approveCurrentStep() {
  const step = currentStep();
  if (S.preview || step.part === undefined) return approveCurrentFile();
  return approveStep(step, { advance: true });
}

// Sign off on a file (signOff), stage it when it's a clean approval and the "Approve stages file"
// setting is on, then — with `advance`, the ⇧A flow — move on to the next unreviewed file. The
// sidebar's status icon signs off without it: the active file stays put and re-renders in place,
// so a sign-off on the active file shows in its header at once.
export async function approveFile(path: string, { advance }: { advance: boolean }) {
  // A preview (an unchanged file opened to read) isn't in the review: nothing to sign off.
  const file = S.state.files.find((f) => f.path === path);
  if (!file) return;
  signOff(S.state, file);
  // A file with objections (a rejected hunk or open requested-change comment) is "changes
  // requested" — the agent still has work on it, so never stage it. Clean → stage if enabled,
  // except in pr mode, which has no index to stage into.
  const clean = !fileObjections(path);
  const stage = clean && S.settings.stageOnAccept && S.state.mode !== "pr";
  // The sign-off is the verdict and stands either way: a failed stage only leaves it unstaged.
  signing.add(path);
  const stageFailed = stage && !(await stageFile(file)); // never throws: false on any failure
  signing.delete(path);
  persist();
  signedOff(clean, stageFailed ? path : null, advance);
}

// Sign off on one step of a split file, a guide part or its Rest (signOffStep): accept its pending
// blocks and sign each of them off, signing the file off once none of its blocks is left. A clean
// approval stages the step's own stageable blocks when "Approve stages file" is on, outside pr
// mode. Then, as approveFile does, report and (with `advance`) move on to the next unreviewed step.
export async function approveStep(step: Step, { advance }: { advance: boolean }) {
  const slot = stepSlot(step);
  const file = S.state.files[step.fileIndex];
  if (!slot?.blocks || !file) return;
  signOffStep(S.state, file, slot.blocks);
  // Like a file's, a step with objections is "changes requested" and never staged.
  const clean = !flowIndex().stepObjections(slot);
  const stage = clean && S.settings.stageOnAccept && S.state.mode !== "pr";
  const keys = slot.blocks.filter((c) => c.stageable).map((c) => c.id);
  signing.add(file.path);
  const stageFailed = stage && !(await moveBlocks(file.path, keys, true)).ok;
  signing.delete(file.path);
  persist();
  signedOff(clean, stageFailed ? file.path : null, advance);
}

// After a sign-off: toast it, prompt to send the review once every in-flow step is signed off, else
// (with `advance`) seek the next unreviewed step. `unstaged` names a file a wanted stage failed on.
function signedOff(clean: boolean, unstaged: string | null, advance: boolean) {
  const label = clean ? "Approved" : "Marked reviewed";
  const say = (t: string) => toast(unstaged ? `${label} — couldn't stage ${unstaged}` : t);
  // The review-complete gate is over in-flow steps only (issue 01/07): fully-skimmed files and
  // parts and pure renames left the flow, so they never block completion (and are never
  // auto-approved). One flow-index pass instead of per-step predicate rescans (see flow-index.ts).
  const { done, total, parts } = reviewTally();
  // Every in-flow step signed off → the review is done: prompt to send it back to the agent.
  if (done === total) {
    say(`${label} — review complete`);
    render();
    S.promptFinish?.();
    return;
  }
  // Each sign-off toasts the running score ("7 of 12 files · 58%", or steps once the guide splits
  // a file) so progress is felt at the moment it moves, not just visible in the bar. % matches the
  // strip (LOC-weighted by default).
  say(`${label} — ${done} of ${total} ${parts ? "steps" : "files"} · ${guideProgress().pct}%`);
  // Seek the next unreviewed step, wrapping past the end so a reviewer who jumped ahead is
  // carried back to the steps they skipped instead of dead-ending here.
  const next = advance ? nextUnreviewedStep(currentStep()) : null;
  if (next !== null && S.selectStep) S.selectStep(next);
  else render();
}

// The sidebar's status icon: sign a pending file (or, on a Walkthrough row, a part or Rest step)
// off where it stands, or reset a finished one — Reset's Undo is the safety net against a stray
// click. A click while a sign-off of the file stages is ignored.
export function toggleSignOff(path: string, part?: Step["part"]) {
  if (signing.has(path)) return;
  const fileIndex = S.state.files.findIndex((f) => f.path === path);
  if (part !== undefined && fileIndex >= 0) {
    const step = { fileIndex, part };
    const slot = stepSlot(step);
    if (slot && flowIndex().stepFinished(slot)) resetStep(step);
    else void approveStep(step, { advance: false });
    return;
  }
  if (fileFinished(path)) resetReview(path);
  else void approveFile(path, { advance: false });
}

// Undo a file's review: clear hunk decisions, the finished/sign-off marker + its hash, and unstage.
// The toast's Undo puts back exactly what this cleared, the index included.
export function resetReview(path: string) {
  const state = S.state;
  const prior = captureFileReview(state, path);
  clearFileReview(state, path);
  // Unstage is a git-index op the UI state already reflects — fire it without blocking so the
  // re-render (and its indicator) start immediately.
  const unstaged = api<{ ok?: boolean; index?: IndexEntry }>("/api/unstage", {
    method: "POST",
    body: JSON.stringify({ path }),
  }).catch(() => null);
  // Reset restores hunks the approval had collapsed, which re-tokenizes a big file — show the
  // "Rendering…" indicator during it (deferRender(true) shows it for any big file).
  deferRender(true);
  toast("Reset review", { label: "Undo", run: () => void undoReset(state, prior, unstaged) });
  persist();
}

async function undoReset(
  state: ReviewState,
  prior: FileReview,
  unstaged: Promise<{ ok?: boolean; index?: IndexEntry } | null>,
) {
  // A reload since the Reset swapped the state out; the capture describes the one it replaced.
  if (S.state !== state) return toast("Can't undo — the diff changed");
  restoreFileReview(state, prior);
  deferRender(true);
  persist();
  // Once the Reset's unstage has landed, put back the index entry it replaced — exactly what was
  // staged, never the working tree's newer edits — with the staging records the Reset dropped.
  const res = await unstaged;
  const restaged =
    !res?.ok || res.index === undefined
      ? !prior.staged && !prior.stagedChangeKeys.length // nothing to put back, or no way to
      : await restage(prior, res.index);
  toast(restaged ? "Reset undone" : `Restored — couldn't re-stage ${prior.path}`);
}

// A part's (or Rest's) Reset: its blocks' decisions and sign-offs and the file's sign-off clear,
// and the blocks its approval staged leave the index. The toast's Undo puts back exactly what this
// cleared, those blocks' staging included.
export function resetStep(step: Step) {
  const slot = stepSlot(step);
  if (!slot?.blocks) {
    if (slot) resetReview(slot.path);
    return;
  }
  const state = S.state;
  const prior = captureFileReview(state, slot.path, slot.blocks);
  clearFileReview(state, slot.path, slot.blocks);
  // Fired without blocking, as a file's unstage is.
  const unstaged = moveBlocks(slot.path, prior.stagedChangeKeys, false);
  deferRender(true);
  toast("Reset review", { label: "Undo", run: () => void undoStepReset(state, prior, unstaged) });
  persist();
}

async function undoStepReset(
  state: ReviewState,
  prior: FileReview,
  unstaged: Promise<{ moved: string[] }>,
) {
  if (S.state !== state) return toast("Can't undo — the diff changed");
  restoreFileReview(state, prior);
  deferRender(true);
  persist();
  // Once the Reset's unstage has landed, stage again exactly the blocks it took out.
  const { moved } = await unstaged;
  const { ok } = await moveBlocks(prior.path, moved, true);
  toast(ok ? "Reset undone" : `Restored — couldn't re-stage ${prior.path}`);
}

async function restage(prior: FileReview, index: IndexEntry): Promise<boolean> {
  const res = await api<{ ok?: boolean }>("/api/restage", {
    method: "POST",
    body: JSON.stringify({
      path: prior.path,
      index,
      staged: prior.staged,
      stagedChangeKeys: prior.stagedChangeKeys,
    }),
  }).catch(() => null);
  if (!res?.ok) return false;
  if (prior.staged && !S.state.stagedFiles.includes(prior.path))
    S.state.stagedFiles.push(prior.path);
  S.state.stagedChangeKeys = S.state.stagedChangeKeys || [];
  for (const key of prior.stagedChangeKeys)
    if (!S.state.stagedChangeKeys.includes(key)) S.state.stagedChangeKeys.push(key);
  return true;
}

// Reject a whole file in one action, for the oversized-file card (issue 05): its blocks aren't
// visible there, so the honest equivalent of per-block reject is to reject every change block
// through the SAME decisions path. They flow into result.rejected like any rejected hunk — no new
// verdict kind, no new result semantics. Only meaningful when the file has change blocks (a
// hunk-less added file has none — the card hides the action there).
export async function rejectFile(path: string) {
  const blocks = S.state.changes.filter((c) => c.path === path);
  if (!blocks.length) return;
  for (const c of blocks) {
    c.status = "rejected";
    c.reviewedHash = c.contentHash;
    recordDecision(S.state, c, "rejected");
  }
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(path)) S.state.decisionFiles.push(path);
  toast("Rejected file");
  render();
  persist();
}

// Per-hunk accept/reject is now a pure verdict — staging happens only when the file is approved
// (so a changes-requested file is never left partially staged).
export async function acceptChange(id: string, status: Decision["status"]) {
  const change = S.state.changes.find((c) => c.id === id);
  if (!change || change.status === status) return;
  change.status = status;
  change.reviewedHash = change.contentHash;
  recordDecision(S.state, change, status);
  S.state.decisionFiles = S.state.decisionFiles || [];
  if (!S.state.decisionFiles.includes(change.path)) S.state.decisionFiles.push(change.path);
  // No need to apply the decision to D.fileDiff here: renderCenter unconditionally rebuilds
  // D.fileDiff from the raw diff (parse → ensureChanges → replayDecisions) every render, so a
  // pre-render mutation is thrown away — the replay below picks the new status up from the record.
  toast(status === "rejected" ? "Rejected" : "Accepted");
  render();
  persist();
}
