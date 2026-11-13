import type { GuideTopic, ReviewState } from "../types";
import { placeBlocks } from "./flow-index";

export function formatTopicShare(lines: number, unskimmed: number): string {
  const n = unskimmed > 0 ? (lines / unskimmed) * 100 : 0;
  if (n > 0 && n < 0.1) return "<0.1%";
  return `${n < 10 ? n.toFixed(1).replace(/^0\.0$/, "0") : n.toFixed(0)}%`;
}

export type TopicPoint =
  | { kind: "page"; path: string }
  | { kind: "code"; path: string; line: number; lines: number };

export function topicPoints(topic: GuideTopic, state: ReviewState): TopicPoint[] {
  const keys = new Set(state.topics?.[topic.id]?.blocks ?? []);
  const items: TopicPoint[] = (topic.pages ?? []).map((path) => ({ kind: "page", path }));
  for (const f of state.files) {
    const ranges = placeBlocks(
      state.changes.filter((c) => c.path === f.path && keys.has(`${c.path}:${c.stableKey}`)),
      f.hunks,
    );
    const count = (span: [number, number] | undefined) =>
      span ? Math.max(0, span[1] - span[0] + 1) : 0;
    if (ranges.length)
      items.push({
        kind: "code",
        path: f.path,
        line: Math.max(1, ranges[0]!.additions?.[0] ?? ranges[0]!.block.lineNumber),
        lines: ranges.reduce((n, r) => n + count(r.additions) + count(r.deletions), 0),
      });
    else if (keys.has(`${f.path}:file`))
      items.push({ kind: "code", path: f.path, line: 1, lines: (f.added ?? 0) + (f.removed ?? 0) });
  }
  return items;
}

export function pointsPage(items: TopicPoint[], count = 10) {
  return { items: items.slice(0, count), more: Math.min(10, Math.max(0, items.length - count)) };
}
