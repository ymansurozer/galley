import { S, api, saveStamp, toast } from "./store";
import { reviewerSlice } from "./save";
import { screenshotsInFlight, screenshotsSettled } from "./uilane";
import { updateAwaitingDom } from "./annotations";

// Confirm the Send modal: the typed note (trimmed; empty → omitted) rides along as the one-time
// overall instruction. Cancel leaves the review untouched. New annotations' screenshots still being
// captured or uploaded go too if they land within SHOTS_WAIT_MS, while the dialog says so; past
// it, those annotations go without them, as when a capture fails.
const SHOTS_WAIT_MS = 15_000;
let sendWait = 0;
export async function sendConfirm() {
  if (S.sendFinishing) return;
  const note = S.sendNote.trim();
  if (screenshotsInFlight()) {
    const wait = ++sendWait;
    S.sendFinishing = true;
    await screenshotsSettled(SHOTS_WAIT_MS);
    // Cancelled while it waited, and maybe confirmed again since.
    if (wait !== sendWait || !S.sendFinishing) return;
    S.sendFinishing = false;
  }
  S.sendOpen = false;
  S.send?.(note);
}
export function sendCancel() {
  S.sendOpen = false;
  S.sendNote = "";
  S.sendFinishing = false;
}

export async function send(overallNote = "") {
  // Post only the reviewer-owned slice — never the whole (multi-MB) ReviewState. Big desks
  // used to cross the server's body cap on Send and 500 ("Could not send review") while the
  // slice-only auto-saves kept succeeding; the server merges this slice and builds the
  // result from its own authoritative state. overallNote is a one-time instruction for the
  // whole review; the server reads it off the body and never persists it (see /api/send).
  const r = await api<{ sent?: boolean }>("/api/send", {
    method: "POST",
    body: JSON.stringify({ ...reviewerSlice(S.state), seen: saveStamp(), overallNote }),
  });
  if (r && r.sent) {
    S.awaitingAgent = true;
    S.undeliveredAsks.clear(); // the questions went with the review
    // The change requests went with it: their held bands go now, not on the next poll.
    updateAwaitingDom();
  } else toast("Could not send review");
}
