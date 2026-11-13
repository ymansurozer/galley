import type { ReviewState, ReviewerSave } from "./types";

// The reviewer-owned slice of the state — never the whole (multi-MB) ReviewState. The server
// holds rawDiff/file contents/changes/etc. authoritatively; a save carries what changed in these
// fields since the copy the desk last confirmed (store.ts), worked out from two of these slices.
// Enumerating keys explicitly (rather than deleting server fields off a clone) guarantees the wire
// never carries file contents.
export function reviewerSlice(state: ReviewState): ReviewerSave {
  return {
    decisions: state.decisions,
    comments: state.comments,
    reviewedFiles: state.reviewedFiles,
    reviewedFileHashes: state.reviewedFileHashes,
    signedOffBlocks: state.signedOffBlocks,
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
// The trailing save re-reads getPayload() at send time (the changes since the desk's confirmed
// copy, store.ts), so it reflects the newest state, not whatever was current when the
// intermediate triggers fired. send/getPayload are injected so the coalescing logic is
// unit-testable without a browser or fetch.
//
// A save has landed only when send resolves to true (the desk answered with success). Anything
// else, a rejection included, leaves the reviewer's work unsaved: the saver keeps it busy, so the
// poll never replaces it with the desk's review, and retries on a backoff until it lands.
export type Saver = {
  // Request a save. Sends immediately if idle (or waiting out a failed save's backoff);
  // otherwise schedules exactly one trailing save.
  trigger: () => void;
  // Request a save that can wait (what the app page reports, not what the reviewer did): one
  // trigger a second later however many arrive meanwhile, or none if a trigger() saves first, since
  // its snapshot carries them. Not busy while it waits, so full reads can start meanwhile;
  // their generation check rejects snapshots that predate newer deferred save activity.
  triggerSoon: () => void;
  // The desk answered something else (a poll): retry an unsaved save now, not on its backoff.
  retryNow: () => void;
  // Monotonic local save activity, including deferred/coalesced requests and their dispatch.
  // A full snapshot begun before this changes is unsafe even after the save has drained.
  generation: () => number;
  // In flight, a trailing save pending, or a failed save not yet landed. The poll's reload branch
  // checks this so it never adopts server state over local mutations that haven't been persisted
  // yet (see poll.ts).
  isBusy: () => boolean;
  // A save attempt is out, its answer not in yet.
  inFlight: () => boolean;
  // The last attempt failed and none has landed since.
  unsaved: () => boolean;
  // When the current run of failed attempts began (Date.now()), or null when the last one landed.
  failingSince: () => number | null;
  // Whether everything triggered so far has landed: true once it has, false as soon as an attempt
  // fails, at once while a failed save waits out its backoff. It never waits through an outage, so
  // a caller that needs the saved record (an Ask, a screenshot upload) takes its failure path.
  settled: () => Promise<boolean>;
};

const SOON_MS = 1000;
// The wait before each retry of a failed save; past the list, every 5 s.
const BACKOFF_MS = [1000, 2000, 4000];
const BACKOFF_MAX_MS = 5000;

export function createSaver<T>(getPayload: () => T, send: (payload: T) => Promise<boolean>): Saver {
  let inFlight = false;
  let generation = 0;
  let pending = false;
  let soon: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let failingSince: number | null = null;
  let waiters: Array<(landed: boolean) => void> = [];

  const answer = (landed: boolean) => {
    const waiting = waiters;
    waiters = [];
    for (const resolve of waiting) resolve(landed);
  };

  const run = () => {
    clearTimeout(retry);
    retry = undefined;
    inFlight = true;
    Promise.resolve(send(getPayload()))
      .then(
        (landed) => landed === true,
        () => false,
      )
      .then((landed) => {
        inFlight = false;
        if (landed) {
          failures = 0;
          failingSince = null;
        } else {
          failures++;
          failingSince ??= Date.now();
          answer(false);
        }
        // A trailing save carries a newer snapshot: it goes at once either way, and a failed one
        // never strands it.
        if (pending) {
          pending = false;
          run();
          return;
        }
        if (landed) answer(true);
        else retry = setTimeout(run, BACKOFF_MS[failures - 1] ?? BACKOFF_MAX_MS);
      });
  };

  const trigger = () => {
    generation++;
    clearTimeout(soon);
    soon = undefined;
    if (inFlight) pending = true;
    else run();
  };

  return {
    trigger,
    triggerSoon() {
      generation++;
      soon ??= setTimeout(trigger, SOON_MS);
    },
    retryNow() {
      if (retry !== undefined) run();
    },
    generation: () => generation,
    isBusy() {
      return inFlight || pending || failures > 0;
    },
    inFlight: () => inFlight,
    unsaved: () => failures > 0,
    failingSince: () => failingSince,
    settled() {
      if (inFlight) return new Promise((resolve) => waiters.push(resolve));
      return Promise.resolve(failures === 0);
    },
  };
}
