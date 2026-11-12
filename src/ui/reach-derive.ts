import type { ReviewState } from "../types";

// Pure derivations for whether the tab can reach its desk (store-free, so they unit-test).
// reach.ts is the store-reading side: it feeds these from the poll, the saver and a clock.

// Two missed polls (poll.ts ticks every 1.5 s).
export const UNREACHABLE_MS = 3000;

// What the banner under the top bar says. "unreachable": the desk has not answered for
// UNREACHABLE_MS, so the cure is restarting it. "unsaved": the desk answers but its saves have failed
// for that long; the saver keeps retrying, and restarting a desk that answers is no cure.
export type Reach = { kind: "unreachable" | "unsaved"; unsaved: boolean } | null;

// `shown`: what the banner says now. While a save is out its answer decides, so the banner keeps
// what it says: it goes once the held save has landed, not the moment a poll answers.
export function deskReach(
  input: {
    now: number;
    // The last time the desk answered anything (a poll or a save), as Date.now().
    lastAnswerAt: number;
    // When the saver's current run of failed attempts began, or null (save.ts, failingSince).
    failingSince: number | null;
    // The tab holds changes the desk has not taken.
    unsaved: boolean;
    // A save attempt is out (save.ts, inFlight).
    saving: boolean;
  },
  shown: Reach,
): Reach {
  const { now, lastAnswerAt, failingSince, unsaved, saving } = input;
  if (saving && shown) return shown;
  if (now - lastAnswerAt >= UNREACHABLE_MS) return { kind: "unreachable", unsaved };
  // A failed save whose retry lands within the grace never shows.
  if (failingSince !== null && now - failingSince >= UNREACHABLE_MS)
    return { kind: "unsaved", unsaved: true };
  return null;
}

// What the banner says: what happened, then what it means for the reviewer's work.
export function reachMessage(reach: NonNullable<Reach>): { title: string; detail: string } {
  if (reach.kind === "unsaved")
    return {
      title: "The desk isn't saving your changes.",
      detail: "They're kept in this tab, and saving keeps retrying.",
    };
  return {
    title: "Can't reach the desk.",
    detail: reach.unsaved
      ? "Your unsaved changes are kept in this tab and save once it's back."
      : "Everything you did is saved.",
  };
}

// The command that starts this review's desk again, on its session (cli.ts): a restarted desk on
// the same repo and session binds the same port, so the open tab picks it up by itself.
export function restartCommand(
  state: Pick<ReviewState, "mode" | "session" | "target" | "staged">,
): string {
  const words = ["galley"];
  if (state.mode === "pr" || state.mode === "file") words.push(state.mode, state.target ?? "");
  else if (state.staged) words.push("--staged");
  words.push("--session", state.session);
  return words.map(shellWord).join(" ");
}

// A word as a POSIX shell reads it back: bare when it holds nothing the shell treats specially,
// else single-quoted, with each ' closed, escaped and reopened.
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
