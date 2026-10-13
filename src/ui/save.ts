import type { ReviewState, ReviewerSave } from "./types";

// The reviewer-owned slice posted to /api/save — never the whole (multi-MB) ReviewState.
// The server holds rawDiff/file contents/changes/etc. authoritatively and merges only these
// fields. It's a full picture of the reviewer-owned state (snapshot semantics), so the
// coalesced trailing save re-derives it and latest wins. Enumerating keys explicitly (rather
// than deleting server fields off a clone) guarantees the wire never carries file contents.
export function reviewerSlice(state: ReviewState): ReviewerSave {
  return {
    decisions: state.decisions,
    comments: state.comments,
    reviewedFiles: state.reviewedFiles,
    reviewedFileHashes: state.reviewedFileHashes,
    decisionFiles: state.decisionFiles,
    annotations: state.annotations,
    lastAnnotationNumber: state.lastAnnotationNumber,
  };
}

// Coalescing auto-saver. There's no manual Save button, so every reviewer mutation
// (decision, comment, sign-off) triggers a save; approving files back-to-back used to
// fire one full-state POST each, saturating the 6-connection-per-origin cap while the
// server block-serialized multi-MB JSON. This keeps at most one save in flight and
// collapses everything requested while one is outstanding into a single TRAILING save.
//
// The trailing save re-reads getPayload() at send time (latest-wins over a full snapshot
// of the reviewer-owned slice), so it reflects the newest state, not whatever was current
// when the intermediate triggers fired. send/getPayload are injected so the coalescing
// logic is unit-testable without a browser or fetch.
export type Saver = {
  // Request a save. Sends immediately if idle; otherwise schedules exactly one trailing save.
  trigger: () => void;
  // Request a save that can wait (what the app page reports, not what the reviewer did): one
  // trigger `soonMs` later however many arrive meanwhile, or none if a trigger() saves first, since
  // its snapshot carries them. Not busy while it waits, so a page reporting in a loop can neither
  // flood the desk with full saves nor hold off the poll's diff adoption.
  triggerSoon: () => void;
  // In-flight OR a trailing save pending — a save is "busy" until the wire is quiet again.
  // The poll's reload branch checks this so it never adopts server state over local
  // mutations that haven't been persisted yet (see poll.ts).
  isBusy: () => boolean;
  // Resolves once the wire is quiet: everything triggered so far has been sent (or failed).
  // A screenshot upload waits on it, since the server takes one only for a saved annotation.
  settled: () => Promise<void>;
};

export function createSaver<T>(
  getPayload: () => T,
  send: (payload: T) => Promise<unknown>,
  soonMs = 1000,
): Saver {
  let inFlight = false;
  let pending = false;
  let soon: ReturnType<typeof setTimeout> | undefined;
  let waiters: Array<() => void> = [];

  const run = () => {
    inFlight = true;
    // .finally (not .then) so a rejected save still drains the trailing one — a failed
    // in-flight save must never strand a queued save. Errors are otherwise swallowed:
    // fire-and-forget, no retry machinery (the next mutation will re-trigger anyway).
    Promise.resolve(send(getPayload()))
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (pending) {
          pending = false;
          run();
          return;
        }
        const quiet = waiters;
        waiters = [];
        for (const resolve of quiet) resolve();
      });
  };

  const trigger = () => {
    clearTimeout(soon);
    soon = undefined;
    if (inFlight) pending = true;
    else run();
  };

  return {
    trigger,
    triggerSoon() {
      soon ??= setTimeout(trigger, soonMs);
    },
    isBusy() {
      return inFlight || pending;
    },
    settled() {
      return inFlight ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve();
    },
  };
}
