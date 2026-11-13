import type {
  AnnotationReport,
  ChangeState,
  Decision,
  KeyedChanges,
  ReviewerChanges,
  ReviewerSave,
  UiAnnotationRecord,
} from "../types";

// What a save carries (types.ts, ReviewerChanges): the difference between the reviewer-owned
// fields the desk last confirmed and the tab's own, and that difference applied onto a copy. Pure
// and store-free; store.ts takes the difference when a save is sent, and applies what the reviewer
// changed meanwhile onto the merged review a save's answer brings back. The desk applies the same
// shape with its own rules (state.ts, mergeReviewerSave); the two share no code, and
// review-delta-derive.test.ts holds them to one shape.

// JSON with object keys sorted: two records are the same whatever order their keys were written in.
// A field set to undefined reads as absent, as it does on the wire.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
// A detached copy: the tab's records sit behind Alpine's reactive proxies, which structuredClone
// refuses, and the reviewer-owned fields are plain JSON.
export const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function keyedChanges<T>(
  base: readonly T[],
  now: readonly T[],
  key: (record: T) => string,
): KeyedChanges<T> | undefined {
  const before = new Map(base.map((r) => [key(r), r]));
  const after = new Set(now.map(key));
  const changed = now.filter((r) => {
    const was = before.get(key(r));
    return was === undefined || !same(was, r);
  });
  const removed = [...before.keys()].filter((k) => !after.has(k));
  return changed.length || removed.length ? { changed: copyOf(changed), removed } : undefined;
}

// A changed record takes the place of the one with its key, or joins the end; a removed key goes.
function applyKeyed<T>(
  list: readonly T[],
  changes: KeyedChanges<T> | undefined,
  key: (record: T) => string,
): T[] {
  if (!changes) return [...list];
  const gone = new Set(changes.removed);
  const changed = new Map(changes.changed.map((r) => [key(r), r]));
  const out = list.filter((r) => !gone.has(key(r))).map((r) => changed.get(key(r)) ?? r);
  const have = new Set(out.map(key));
  for (const r of changes.changed) if (!have.has(key(r))) out.push(r);
  return out;
}

type FileSignOff = { path: string; hash?: string };
const fileSignOffs = (s: ReviewerSave): FileSignOff[] =>
  (s.reviewedFiles ?? []).map((path) => {
    const hash = s.reviewedFileHashes?.[path];
    return hash === undefined ? { path } : { path, hash };
  });
const blockSignOffs = (s: ReviewerSave) =>
  Object.entries(s.signedOffBlocks ?? {}).map(([key, hash]) => ({ key, hash }));
const topicSignOffs = (s: ReviewerSave) =>
  Object.entries(s.settledTopics ?? {}).map(([id, t]) => ({ id, ...t }));
const topicSignOffMap = (list: ReturnType<typeof topicSignOffs>) =>
  Object.fromEntries(list.map(({ id, hash, round }) => [id, { hash, round }]));

// Whether its screenshots are stored is the desk's to say, never the tab's (types.ts), so it is no
// change of the tab's. What the page reports by itself (placement, a failed capture) goes as a
// report when it is all that changed: only the reviewer's own edit sends the record whole.
const REPORTED = ["placement", "screenshotCapture"] as const;
function without(a: UiAnnotationRecord, keys: readonly string[]) {
  const rest: Record<string, unknown> = { ...a };
  for (const k of keys) delete rest[k];
  return rest;
}
function annotationChanges(
  base: readonly UiAnnotationRecord[],
  now: readonly UiAnnotationRecord[],
) {
  const before = new Map(base.map((a) => [a.id, a]));
  const after = new Set(now.map((a) => a.id));
  const changed: UiAnnotationRecord[] = [];
  const reports: AnnotationReport[] = [];
  for (const a of now) {
    const was = before.get(a.id);
    if (was && same(without(was, ["screenshots"]), without(a, ["screenshots"]))) continue;
    const reportable =
      was &&
      same(without(was, ["screenshots", ...REPORTED]), without(a, ["screenshots", ...REPORTED])) &&
      (a.screenshotCapture === was.screenshotCapture || a.screenshotCapture === "failed");
    if (!reportable) {
      changed.push(a);
      continue;
    }
    const report: AnnotationReport = { id: a.id };
    if (a.placement !== was.placement) report.placement = a.placement;
    if (a.screenshotCapture !== was.screenshotCapture) report.screenshotCapture = "failed";
    reports.push(report);
  }
  const removed = [...before.keys()].filter((id) => !after.has(id));
  return {
    annotations:
      changed.length || removed.length ? { changed: copyOf(changed), removed } : undefined,
    annotationReports: reports.length ? reports : undefined,
  };
}

// What `now` changed since `base`, the copy the desk last confirmed. Empty ({}) when nothing did.
export function reviewerChanges(base: ReviewerSave, now: ReviewerSave): ReviewerChanges {
  const out: ReviewerChanges = {
    decisions: keyedChanges(base.decisions ?? [], now.decisions ?? [], (d) => d.key),
    comments: keyedChanges(base.comments ?? [], now.comments ?? [], (c) => c.id),
    fileSignOffs: keyedChanges(fileSignOffs(base), fileSignOffs(now), (f) => f.path),
    signedOffBlocks: keyedChanges(blockSignOffs(base), blockSignOffs(now), (b) => b.key),
    settledTopics: keyedChanges(topicSignOffs(base), topicSignOffs(now), (t) => t.id),
    decisionFiles: keyedChanges(base.decisionFiles ?? [], now.decisionFiles ?? [], (p) => p),
    ...annotationChanges(base.annotations ?? [], now.annotations ?? []),
    topicThreads: keyedChanges(base.topicThreads ?? [], now.topicThreads ?? [], (t) => t.id),
  };
  if ((now.lastAnnotationNumber ?? 0) > (base.lastAnnotationNumber ?? 0))
    out.lastAnnotationNumber = now.lastAnnotationNumber;
  for (const k of Object.keys(out) as Array<keyof ReviewerChanges>)
    if (out[k] === undefined) delete out[k];
  return out;
}

export const noChanges = (changes: ReviewerChanges) => Object.keys(changes).length === 0;

function unionKeyed<T>(
  all: ReadonlyArray<KeyedChanges<T> | undefined>,
  key: (record: T) => string,
): KeyedChanges<T> | undefined {
  const given = all.filter((c) => c !== undefined);
  if (!given.length) return undefined;
  const changed = new Map(given.flatMap((c) => c.changed.map((r) => [key(r), r] as const)));
  return { changed: [...changed.values()], removed: [...new Set(given.flatMap((c) => c.removed))] };
}

// Several differences taken to the same current state, as one: what a save sends when saves the
// desk may hold are out beside the confirmed copy (store.ts). Each describes the same current state,
// so a key two of them carry carries the same record (or the same removal) in both. An annotation
// sent whole carries its placement and capture with it, so no report for it goes beside it.
export function unionChanges(all: readonly ReviewerChanges[]): ReviewerChanges {
  const pick = <K extends keyof ReviewerChanges>(k: K) => all.map((c) => c[k]);
  const annotations = unionKeyed(pick("annotations"), (a) => a.id);
  const whole = new Set(annotations?.changed.map((a) => a.id));
  const reports = new Map<string, AnnotationReport>();
  for (const report of all.flatMap((c) => c.annotationReports ?? []))
    if (!whole.has(report.id)) reports.set(report.id, { ...reports.get(report.id), ...report });
  const marks = all.flatMap((c) => c.lastAnnotationNumber ?? []);
  const out: ReviewerChanges = {
    decisions: unionKeyed(pick("decisions"), (d) => d.key),
    comments: unionKeyed(pick("comments"), (c) => c.id),
    fileSignOffs: unionKeyed(pick("fileSignOffs"), (f) => f.path),
    signedOffBlocks: unionKeyed(pick("signedOffBlocks"), (b) => b.key),
    settledTopics: unionKeyed(pick("settledTopics"), (t) => t.id),
    decisionFiles: unionKeyed(pick("decisionFiles"), (p) => p),
    annotations,
    annotationReports: reports.size ? [...reports.values()] : undefined,
    lastAnnotationNumber: marks.length ? Math.max(...marks) : undefined,
    topicThreads: unionKeyed(pick("topicThreads"), (t) => t.id),
  };
  for (const k of Object.keys(out) as Array<keyof ReviewerChanges>)
    if (out[k] === undefined) delete out[k];
  return out;
}

// `changes` applied onto `copy`, as a new copy: what the reviewer did since a save was sent, put
// back over the merged review its answer brought (store.ts).
export function applyReviewerChanges(copy: ReviewerSave, changes: ReviewerChanges): ReviewerSave {
  const c = copyOf(changes);
  const out: ReviewerSave = { ...copyOf(copy) };
  if (c.decisions) out.decisions = applyKeyed(out.decisions ?? [], c.decisions, (d) => d.key);
  if (c.comments) out.comments = applyKeyed(out.comments ?? [], c.comments, (m) => m.id);
  if (c.fileSignOffs) {
    const signed = applyKeyed(fileSignOffs(out), c.fileSignOffs, (f) => f.path);
    const hashes = { ...out.reviewedFileHashes };
    for (const path of c.fileSignOffs.removed) delete hashes[path];
    for (const { path, hash } of c.fileSignOffs.changed)
      if (hash === undefined) delete hashes[path];
      else hashes[path] = hash;
    out.reviewedFiles = signed.map((f) => f.path);
    out.reviewedFileHashes = hashes;
  }
  if (c.signedOffBlocks)
    out.signedOffBlocks = Object.fromEntries(
      applyKeyed(blockSignOffs(out), c.signedOffBlocks, (b) => b.key).map((b) => [b.key, b.hash]),
    );
  if (c.settledTopics)
    out.settledTopics = topicSignOffMap(
      applyKeyed(topicSignOffs(out), c.settledTopics, (t) => t.id),
    );
  if (c.decisionFiles)
    out.decisionFiles = applyKeyed(out.decisionFiles ?? [], c.decisionFiles, (p) => p);
  if (c.annotations)
    out.annotations = applyKeyed(out.annotations ?? [], c.annotations, (a) => a.id);
  for (const report of c.annotationReports ?? []) {
    const a = out.annotations?.find((x) => x.id === report.id);
    if (!a) continue;
    if (report.placement) a.placement = report.placement;
    if (report.screenshotCapture) a.screenshotCapture = report.screenshotCapture;
  }
  if (c.lastAnnotationNumber !== undefined)
    out.lastAnnotationNumber = Math.max(out.lastAnnotationNumber ?? 0, c.lastAnnotationNumber);
  if (c.topicThreads)
    out.topicThreads = applyKeyed(out.topicThreads ?? [], c.topicThreads, (t) => t.id);
  return out;
}

// Each block's status and reviewed hash from its decision record, the source of truth: pending
// where it has none. Run on the tab's blocks once it takes decisions from the desk.
export function stampDecisions(changes: ChangeState[], decisions: readonly Decision[]) {
  const byKey = new Map(decisions.map((d) => [d.key, d]));
  for (const c of changes) {
    const d = byKey.get(`${c.path}:${c.stableKey}`);
    c.status = d?.status ?? "pending";
    if (d?.reviewedHash) c.reviewedHash = d.reviewedHash;
    else delete c.reviewedHash;
  }
}
