import { S, noteAnswer, noteUnplaced, saveStamp, toast } from "./store";
import { reviewerSlice } from "./save";
import { screenshotsInFlight, screenshotsSettled } from "./uilane";
import { updateAwaitingDom } from "./annotations";
import type { SaveAnswer } from "./types";

// Confirm the Send modal: the typed note (trimmed; empty → omitted) rides along as the one-time
// overall instruction. Cancel leaves the review untouched. New annotations' screenshots still being
// captured or uploaded go too if they land within SHOTS_WAIT_MS, while the dialog says so; past
// it, those annotations go without them, as when a capture fails.
// The dialog closes only once the desk took the review. When it didn't (no answer, or an error
// answer), the dialog stays open with the note as typed and says the review was not sent.
const SHOTS_WAIT_MS = 15_000;
let sendWait = 0;
export async function sendConfirm() {
  if (S.sendFinishing || S.sending) return;
  const note = S.sendNote.trim();
  if (screenshotsInFlight()) {
    const wait = ++sendWait;
    S.sendFinishing = true;
    await screenshotsSettled(SHOTS_WAIT_MS);
    // Cancelled while it waited, and maybe confirmed again since.
    if (wait !== sendWait || !S.sendFinishing) return;
    S.sendFinishing = false;
  }
  S.sendFailed = false;
  S.sending = true;
  const sent = await S.send?.(note);
  S.sending = false;
  if (sent) S.sendOpen = false;
  else if (S.sendOpen) S.sendFailed = true;
  else toast("Could not send review");
}
export function sendCancel() {
  S.sendOpen = false;
  S.sendNote = "";
  S.sendFinishing = false;
  S.sendFailed = false;
}

// Resolves to whether the desk took the review.
export async function send(overallNote = ""): Promise<boolean> {
  // Post only the reviewer-owned slice — never the whole (multi-MB) ReviewState. Big desks
  // used to cross the server's body cap on Send and 500 ("Could not send review") while the
  // slice-only auto-saves kept succeeding; the server merges this slice and builds the
  // result from its own authoritative state. overallNote is a one-time instruction for the
  // whole review; the server reads it off the body and never persists it (see /api/send).
  const res = await fetch("/api/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...reviewerSlice(S.state), seen: saveStamp(), overallNote }),
  }).catch(() => null);
  if (!res) return false;
  noteAnswer();
  const answer = (await res.json().catch(() => null)) as Partial<SaveAnswer> | null;
  if (!res.ok || !answer?.sent) return false;
  noteUnplaced(answer);
  S.awaitingAgent = true;
  S.undeliveredAsks.clear(); // the questions went with the review
  // The change requests went with it: their held bands go now, not on the next poll.
  updateAwaitingDom();
  return true;
}
