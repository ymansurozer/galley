// Pure file-bar derivations (store-free, so they're unit-testable). filebar.ts reads the open
// file's state off the store and draws what these return.

export type FileBarState = {
  finished: boolean; // signed off, and the sign-off is current (fileFinished)
  objections: boolean; // a rejected change or an open change request (fileObjections)
  blockers: number; // what the blockers chip would list (fileBlockers)
  hasDecisions: boolean; // the file carries hunk decisions (decisionFiles)
  skimExpanded: boolean; // a skim-flagged file the reviewer has expanded
};

export type FileBarAction =
  | "collapse" // fold the expanded skimmed file back
  | "reset" // the per-file reset (its toast offers Undo)
  | "blockers" // the "N blockers" chip and its jump list
  | "approve" // Approve File ⇧A (filled green)
  | "mark" // Mark Reviewed ⇧A (filled orange)
  | "approved" // the quiet "✓ Approved" state
  | "reviewed"; // the quiet "Reviewed with requests" state

// The open file's actions, left to right. An unfinished file ends on its one filled sign-off
// button, with Reset leading only once it has hunk decisions to clear. A finished file swaps the
// button for a quiet state and always offers Reset, which undoes the sign-off. Collapse leads
// either way while a skimmed file is expanded, as the counterpart to its strip's Expand.
export function fileBarActions(s: FileBarState): FileBarAction[] {
  const out: FileBarAction[] = [];
  if (s.skimExpanded) out.push("collapse");
  if (s.finished) {
    if (s.blockers) out.push("blockers");
    out.push(s.objections ? "reviewed" : "approved", "reset");
    return out;
  }
  if (s.hasDecisions) out.push("reset");
  if (s.blockers) out.push("blockers");
  out.push(s.objections ? "mark" : "approve");
  return out;
}

// A path as the bar draws it: the folder, which gives way first when the bar runs short, and
// the filename, which stays.
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf("/") + 1;
  return { dir: path.slice(0, cut), name: path.slice(cut) };
}
