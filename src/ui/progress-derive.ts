// Pure derivations for the top bar's progress edge, from progressDetail()'s values and its inputs
// (store-free, so they unit-test). progress.ts is the store-reading side; the computation of
// progress itself stays progressDetail's.

export type Progress = { done: number; total: number; pct: number };

// The open step as progress sees it: its weight (changed lines, or 1 counting files), whether it
// left the flow (fully skimmed or a pure rename), and its review state.
export type OpenFile = {
  weight: number;
  outOfFlow: boolean;
  state: "pending" | "approved" | "changes-requested";
};

// What ⇧A on the open file would add: the tail ahead of the fill, in points of the bar, and where
// the bar would land. Progress credits a file once it's signed off, so only a pending in-flow file
// has a tail. `after` rounds as progressDetail rounds, so the fill glides exactly into the tail.
export function approvePreview(
  p: Progress,
  open: OpenFile | null,
): { tail: number; after: number } | null {
  if (!open || open.outOfFlow || open.state !== "pending" || !p.total) return null;
  const after = Math.round(((p.done + open.weight) / p.total) * 100);
  return { tail: after - p.pct, after };
}
