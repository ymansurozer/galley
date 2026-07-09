// Pure file-seek logic for wrap-around navigation. These operate on an explicit `order`
// (file indices in nav order — guide order when a guide is attached, else the file array)
// and a `finished` predicate ("this file is signed off in the current state"), so they're
// unit-testable without the Alpine store. guide.ts holds the thin store-reading wrappers.

// The nav order the wrap/approve-advance seeks walk: guide order first (when guided), then any
// diff file the guide didn't list, in file-array order. Fully-skimmed files (inFlow(i) === false)
// are excluded HERE — the single choke point — so no seek ever lands on one (issue 07). Pure, so
// seek.test can prove the exclusion; guide.ts's navOrder is the thin store-reading wrapper.
export function navFileOrder(
  fileCount: number,
  guideOrder: number[] | null,
  inFlow: (i: number) => boolean,
): number[] {
  const all = Array.from({ length: fileCount }, (_, i) => i);
  if (!guideOrder) return all.filter(inFlow);
  const listed = new Set(guideOrder);
  return guideOrder.concat(all.filter((i) => !listed.has(i))).filter(inFlow);
}

// The next unreviewed file after `cur`, scanning `order` forward and wrapping past the end
// back to the beginning. Used by approve-advance to seek remaining work instead of dead-ending.
// `cur`'s own slot is never returned (a just-approved file counts as finished anyway, but the
// wrap must not land back on the starting file). null when no unreviewed file remains anywhere.
export function nextUnreviewed(
  order: number[],
  cur: number,
  finished: (i: number) => boolean,
): number | null {
  const n = order.length;
  if (!n) return null;
  // `cur` may be absent from the order (a diff file not listed in the guide) — start scanning
  // from the top of the order in that case (pos === -1 makes the first probe order[0]).
  const pos = order.indexOf(cur);
  for (let step = 1; step <= n; step++) {
    const i = order[(pos + step) % n]!;
    if (i === cur) continue;
    if (!finished(i)) return i;
  }
  return null;
}

// The target when plain "next" steps off the LAST file in the order: the first unreviewed
// file if any remains, else the first file (a plain cycle). null only when there are no files.
export function wrapNextTarget(order: number[], finished: (i: number) => boolean): number | null {
  if (!order.length) return null;
  return order.find((i) => !finished(i)) ?? order[0]!;
}

// Mirror of wrapNextTarget for plain "prev" stepping off the FIRST position: the last
// unreviewed file if any remains, else the last file.
export function wrapPrevTarget(order: number[], finished: (i: number) => boolean): number | null {
  if (!order.length) return null;
  for (let i = order.length - 1; i >= 0; i--) if (!finished(order[i]!)) return order[i]!;
  return order[order.length - 1]!;
}
