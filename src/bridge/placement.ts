import type { UiMark, UiPlacement } from "../types";
import { refind, stands, type Found } from "./refind";

// When the bridge looks for its marks' targets, and what it tells the desk. A page that has just
// loaded (or changed route in-page) is still rendering: its scripts run, its data arrives, a live
// reload swaps parts of it. So the bridge looks once the page settles: a grace period after the
// navigation, then a quiet spell without DOM changes (or, on a page that never stops changing, a
// bounded wait). A target found there is placed. One not found is looked for again at each later
// quiet spell, and is unplaced only once `cap` has passed since the page's scripts ran (or since
// its mark came, if later) and the page has gone `idle` without changing its DOM or loading
// anything: a dev server still serving modules, or data still arriving, isn't taken for a missing
// target. A page that never idles gives up after `giveUp`. After that, every DOM change has the
// marks checked again: a mark whose elements left the page (a re-render, a closed dialog) is
// looked for anew, and an unplaced one may turn up. The desk hears each mark's first answer, then
// only changes.

export const SETTLE = {
  grace: 600,
  quiet: 400,
  maxWait: 2000,
  cap: 4000,
  idle: 1500,
  giveUp: 30_000,
};

// Time, passed in so tests can run it by hand: `after` runs `fn` once in `ms`, and returns a cancel.
export type Clock = { now: () => number; after: (ms: number, fn: () => void) => () => void };
export type Placement = { id: string; placement: Exclude<UiPlacement, "unvisited"> };

type Entry = {
  mark: UiMark;
  // The target as it came, to tell a changed one from the same one sent again.
  target: string;
  found: Found | null;
  state: "pending" | Placement["placement"];
  // When it was last set looking (it came, or its target left the page).
  since: number;
  reported?: Placement["placement"];
};

export function marksPlacer(
  doc: Document,
  clock: Clock,
  // The marks whose placement the desk hasn't heard yet.
  report: (placements: Placement[]) => void,
  // After every look, whether or not anything changed: redraw.
  looked: () => void,
) {
  const entries = new Map<string, Entry>();
  let navAt = clock.now();
  let lastChange = navAt;
  // The last DOM change or resource load: the page is idle once this is `idle` behind.
  let lastBusy = navAt;
  // When the page's scripts had run (DOMContentLoaded): no target is unplaced before that.
  let readyAt: number | null = null;
  // Since when a look is due because the page changed or a mark came; null when none is.
  let dueSince: number | null = null;
  let cancel: (() => void) | null = null;

  // When a mark still looked for is unplaced: past its cap with the page idle, or past giving up.
  const deadline = (e: Entry) => {
    if (readyAt === null) return Infinity;
    const from = Math.max(readyAt, e.since);
    return Math.min(Math.max(from + SETTLE.cap, lastBusy + SETTLE.idle), from + SETTLE.giveUp);
  };

  function look() {
    cancel = null;
    const now = clock.now();
    dueSince = null;
    const changed: Placement[] = [];
    for (const [id, e] of entries) {
      if (!(e.state === "placed" && e.found && stands(e.found))) {
        let found: Found | null = null;
        try {
          found = refind(doc, e.mark.target);
        } catch {
          // A target this page can't be searched for (a selector it can't parse) isn't on it.
        }
        e.found = found;
        if (found) e.state = "placed";
        else {
          if (e.state === "placed") Object.assign(e, { state: "pending", since: now });
          if (e.state === "pending" && now >= deadline(e)) e.state = "unplaced";
        }
      }
      if (e.state !== "pending" && e.state !== e.reported) {
        e.reported = e.state;
        changed.push({ id, placement: e.state });
      }
    }
    if (changed.length) report(changed);
    looked();
    arm();
  }

  // The next look: once the page is quiet while one is due, and at the earliest deadline of a mark
  // still looked for.
  function arm() {
    cancel?.();
    cancel = null;
    let at = Infinity;
    if (dueSince !== null)
      at = Math.max(
        navAt + SETTLE.grace,
        Math.min(lastChange + SETTLE.quiet, dueSince + SETTLE.maxWait),
      );
    for (const e of entries.values()) if (e.state === "pending") at = Math.min(at, deadline(e));
    if (at < Infinity) cancel = clock.after(Math.max(0, at - clock.now()), look);
  }

  const due = () => {
    dueSince ??= clock.now();
    arm();
  };

  return {
    // The desk's marks for this page. A new one (or one whose target changed) is looked for; one
    // sent again keeps what was found for it.
    set(marks: readonly UiMark[]) {
      const now = clock.now();
      const keep = new Set(marks.map((m) => m.id));
      for (const id of entries.keys()) if (!keep.has(id)) entries.delete(id);
      let added = false;
      for (const mark of marks) {
        const target = JSON.stringify(mark.target);
        const e = entries.get(mark.id);
        if (e?.target === target) e.mark = mark;
        else {
          entries.set(mark.id, { mark, target, found: null, state: "pending", since: now });
          added = true;
        }
      }
      if (added) due();
    },
    // The page's DOM changed.
    changed() {
      lastChange = lastBusy = clock.now();
      if (entries.size) due();
    },
    // The page loaded a resource (a module, a stylesheet, data): it's still busy, so a target not
    // found yet isn't unplaced yet.
    fetched() {
      lastBusy = clock.now();
    },
    // The page's scripts have run.
    ready() {
      readyAt ??= clock.now();
      arm();
    },
    // The desk forgot what it heard (it marked every annotation unvisited after `galley reload`):
    // look again, and tell it every mark's answer, changed or not.
    relook() {
      for (const e of entries.values()) e.reported = undefined;
      if (entries.size) due();
    },
    // The route changed in-page: what it renders next settles anew.
    navigated() {
      navAt = lastChange = lastBusy = clock.now();
    },
    // What a placed mark was found as; null while it's looked for, or unplaced.
    found(id: string): Found | null {
      const e = entries.get(id);
      return e?.state === "placed" ? e.found : null;
    },
    placement(id: string): Entry["state"] | undefined {
      return entries.get(id)?.state;
    },
  };
}
