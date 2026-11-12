import { S, lastAnswer, saver } from "./store";
import { deskReach, reachMessage, restartCommand } from "./reach-derive";

// Whether the tab can reach its desk, for the banner under the top bar and the close warning
// (reach-derive.ts holds the rules). The poll refreshes it on every tick, answered or not; a clock
// refreshes it between ticks, since a desk that stopped answering produces no event of its own.

// A hidden tab's timers are throttled (to once a minute, after a while), so its polls stop
// answering on time though the desk is fine. Silence counts only from when the tab was last shown.
let shownAt = 0;

export function refreshReach() {
  if (document.hidden) return;
  const next = deskReach(
    {
      now: Date.now(),
      lastAnswerAt: Math.max(lastAnswer(), shownAt),
      failingSince: saver.failingSince(),
      unsaved: saver.isBusy(),
      saving: saver.inFlight(),
    },
    S.reach,
  );
  // Written only on a change: the clock ticks every second, and each write would redraw.
  if (next?.kind !== S.reach?.kind || next?.unsaved !== S.reach?.unsaved) S.reach = next;
}

// Alpine evaluates the banner's bindings before the first state is in, while it is hidden.
export const deskRestartCommand = () => (S.state ? restartCommand(S.state) : "");
export const deskReachMessage = () => (S.reach ? reachMessage(S.reach) : { title: "", detail: "" });

export function installReach() {
  setInterval(refreshReach, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) shownAt = Date.now();
  });
  installCloseWarning();
}

// Closing or reloading the tab drops what the desk hasn't taken, so the browser asks first. Only
// then: a tab whose work is saved closes without a prompt.
export function installCloseWarning() {
  window.addEventListener("beforeunload", (event) => {
    if (!saver.isBusy()) return;
    event.preventDefault();
    // Older browsers ask only when returnValue is set.
    event.returnValue = "";
  });
}
