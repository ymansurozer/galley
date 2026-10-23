import type { ReviewComment, ReviewState, UiAnnotationRecord } from "./types";
import { answered, waitingCount } from "./uilane-derive";

// Pure derivations for the top bar: what is under review (title and subtitle) and the agent's
// presence. Store-free, so they unit-test; main.ts wires them to the store.

// The desk-liveness signals the presence reads. awaitingAgent: the review was sent and the agent
// hasn't replied or reloaded. queuedReviews / queuedQuestions: events no `galley await` picked up.
// activity: the agent's latest `galley status` line, null once stale. unansweredAsks: the
// reviewer's questions still waiting on the agent, code and app. Listening is instantaneous;
// recent activity bridges delivery/reply gaps without asserting permanent attachment.
export type PresenceSignals = {
  awaitingAgent: boolean;
  queuedReviews: number;
  queuedQuestions: number;
  activity: string | null;
  agentListening: boolean;
  agentRecentlyActive: boolean;
  unansweredAsks: number;
};

export type Presence = {
  kind: "hidden" | "working" | "answering" | "notAttached";
  line: string;
};

// The agent shows only while it has something in flight: the sent review (the header's status
// line), then an unanswered ask (the line its thread shows). Idle, or just replied, it says nothing:
// a reply lands in its thread.
export function agentPresence(s: PresenceSignals): Presence {
  const active = s.activity || s.agentListening || s.agentRecentlyActive;
  if (s.awaitingAgent && active)
    return { kind: "working", line: s.activity || "Waiting for agent…" };
  if (s.unansweredAsks > 0 && active)
    return {
      kind: "answering",
      line: s.activity ? `Working · ${s.activity}` : "Waiting for agent…",
    };
  if (s.awaitingAgent && s.queuedReviews > 0)
    return { kind: "notAttached", line: "No agent attached — review queued" };
  if (s.unansweredAsks > 0 && s.queuedQuestions > 0)
    return { kind: "notAttached", line: "No agent attached — question queued" };
  return { kind: "hidden", line: "" };
}

// The reviewer's open questions no later agent reply in their thread answers: the code thread's
// waiting line and state.ts's computeOpenQuestions count by the same rule, plus the app's waiting
// annotations. Grouped by thread in one pass, so a desk with many comments doesn't rescan them all
// per question.
export function unansweredAsks(
  comments: readonly ReviewComment[],
  annotations: readonly UiAnnotationRecord[],
) {
  const threads = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const key = `${c.path}\n${c.side}:${c.lineNumber}`;
    const thread = threads.get(key);
    if (thread) thread.push(c);
    else threads.set(key, [c]);
  }
  let code = 0;
  for (const thread of threads.values())
    for (const c of thread)
      if (
        c.status === "open" &&
        c.role !== "agent" &&
        c.intent === "question" &&
        !answered(c, thread)
      )
        code++;
  return code + waitingCount(annotations);
}

const baseName = (p?: string) => p?.replace(/\/+$/, "").split("/").pop() || "";

// What the desk reviews, as the tab title names it: the branch, a pr's head branch, or the file.
// A detached HEAD has no branch, so the session stands in.
export function deskTitle(s: Pick<ReviewState, "mode" | "target" | "branch" | "session">) {
  const name = s.mode === "pr" ? s.target : s.mode === "file" ? baseName(s.target) : s.branch;
  return name || s.session;
}

// "project · mode". A pr review carries neither its number nor its base branch's name (target is
// the head branch it resolved to, base the merge-base), so it reads "pull request". A UI-only desk
// has no diff, only the app.
export function deskSubtitle(
  s: Pick<ReviewState, "mode" | "staged" | "project" | "root">,
  appOnly: boolean,
) {
  const what = appOnly
    ? "app review"
    : s.mode === "file"
      ? "single file"
      : s.mode === "pr"
        ? "pull request"
        : s.staged
          ? "staged changes"
          : "uncommitted changes";
  return `${s.project ?? baseName(s.root)} · ${what}`;
}
