import type { Side } from "./types";

// @pierre tags each rendered row (both its gutter cell and its code cell) with a data-line-type
// — "addition", "deletion", "change-addition", "context", etc. In Stacked (unified) view one
// column carries both sides, so horizontal pointer geometry can't tell which side a dragged row
// belongs to; the row's own type can. Returns the side a data-line-type names, or null when it
// names neither (context / unknown) so the caller can fall back to geometry.
export function sideFromLineType(lineType: string | null | undefined): Side | null {
  if (!lineType) return null;
  if (lineType.includes("deletion")) return "deletions";
  if (lineType.includes("addition")) return "additions";
  return null;
}
