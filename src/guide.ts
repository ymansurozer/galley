import type {
  Cover,
  Guide,
  GuideFile,
  GuideGroup,
  GuideLink,
  GuideStage,
  GuideTopic,
} from "./types.js";

export type GuideValidation = { ok: true; guide: Guide } | { ok: false; reason: string };

type PartLines = NonNullable<GuideFile["part"]>["lines"];

// A part's `lines`: a non-empty array of single line numbers and [start, end] pairs, a reversed
// pair ordered ascending (as skimBlocks spans are). null when the shape is wrong.
function partLines(raw: unknown): PartLines | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: PartLines = [];
  for (const span of raw) {
    if (typeof span === "number" && Number.isFinite(span)) lines.push(span);
    else if (
      Array.isArray(span) &&
      span.length === 2 &&
      span.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      const [a, b] = span as [number, number];
      lines.push(a <= b ? [a, b] : [b, a]);
    } else return null;
  }
  return lines;
}

// A non-empty string, or undefined.
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

// The fields every stage, group and topic shares: an object with a non-empty `id` and its required
// strings. Its error names the field at `at`, with the entry's id once it has one, so the agent can
// find it.
type Entry = { ok: true; at: string; raw: Record<string, unknown> } | { ok: false; reason: string };
function entry(raw: unknown, at: string, required: string[]): Entry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: `${at} must be an object` };
  const r = raw as Record<string, unknown>;
  if (!text(r.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
  const named = `${at} (${JSON.stringify(r.id)})`;
  for (const field of required)
    if (!text(r[field]))
      return { ok: false, reason: `${named}.${field} must be a non-empty string` };
  return { ok: true, at: named, raw: r };
}

// A topic's covers: a non-empty array of { path, lines? }, `lines` shaped as a part's are. Shape
// only — whether each resolves to a change in the diff is resolveCovers' check, on attach.
function covers(
  raw: unknown,
  at: string,
): { ok: true; covers: Cover[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0)
    return { ok: false, reason: `${at}.covers must be a non-empty array` };
  const out: Cover[] = [];
  for (const [i, c] of raw.entries()) {
    const path = c && typeof c === "object" ? text((c as Record<string, unknown>).path) : undefined;
    if (!path) return { ok: false, reason: `${at}.covers[${i}].path must be a non-empty string` };
    const cover: Cover = { path };
    const rawLines = (c as Record<string, unknown>).lines;
    if (rawLines !== undefined) {
      const lines = partLines(rawLines);
      if (!lines)
        return {
          ok: false,
          reason: `${at}.covers[${i}].lines (on ${JSON.stringify(path)}) must be a non-empty array of line numbers and [start, end] pairs`,
        };
      cover.lines = lines;
    }
    out.push(cover);
  }
  return { ok: true, covers: out };
}

function topic(
  raw: unknown,
  at: string,
): { ok: true; topic: GuideTopic } | { ok: false; reason: string } {
  const e = entry(raw, at, ["title", "recorded", "body"]);
  if (!e.ok) return e;
  const r = e.raw;
  // A topic thread's target names a topic by id, or the Overview by this one.
  if (r.id === "overview")
    return { ok: false, reason: `${e.at}.id "overview" is taken: it names the Overview` };
  const c = covers(r.covers, e.at);
  if (!c.ok) return c;
  const t: GuideTopic = {
    id: r.id as string,
    title: r.title as string,
    recorded: r.recorded as string,
    body: r.body as string,
    covers: c.covers,
  };
  if (text(r.concern)) t.concern = r.concern as string;
  if (text(r.flag)) t.flag = r.flag as string;
  if (r.pages !== undefined) {
    if (!Array.isArray(r.pages) || !r.pages.every((p) => typeof p === "string" && p.trim()))
      return { ok: false, reason: `${e.at}.pages must be an array of strings` };
    if (r.pages.length) t.pages = r.pages as string[];
  }
  return { ok: true, topic: t };
}

// A non-empty array at `at.field`, or the reason it isn't.
function list(raw: Record<string, unknown>, at: string, field: string) {
  const v = raw[field];
  return Array.isArray(v) && v.length
    ? { ok: true as const, items: v as unknown[] }
    : { ok: false as const, reason: `${at}.${field} must be a non-empty array` };
}

// The guide's stages, groups and topics, shape-checked. Ids are unique within their kind, so a
// sidebar row, a sign-off or a thread finds its stage, group or topic by id alone.
function stages(raw: unknown): { ok: true; stages: GuideStage[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0)
    return { ok: false, reason: "guide.stages must be a non-empty array" };
  const out: GuideStage[] = [];
  const seen = { stages: new Set<string>(), groups: new Set<string>(), topics: new Set<string>() };
  const unique = (kind: keyof typeof seen, id: string) => {
    if (seen[kind].has(id)) return `guide: two ${kind} share the id ${JSON.stringify(id)}`;
    seen[kind].add(id);
  };
  for (const [si, rawStage] of raw.entries()) {
    const s = entry(rawStage, `guide.stages[${si}]`, ["label"]);
    if (!s.ok) return s;
    const groupList = list(s.raw, s.at, "groups");
    if (!groupList.ok) return groupList;
    const groups: GuideGroup[] = [];
    for (const [gi, rawGroup] of groupList.items.entries()) {
      const g = entry(rawGroup, `guide.stages[${si}].groups[${gi}]`, ["title"]);
      if (!g.ok) return g;
      const topicList = list(g.raw, g.at, "topics");
      if (!topicList.ok) return topicList;
      const topics: GuideTopic[] = [];
      for (const [ti, rawTopic] of topicList.items.entries()) {
        const t = topic(rawTopic, `guide.stages[${si}].groups[${gi}].topics[${ti}]`);
        if (!t.ok) return t;
        const dup = unique("topics", t.topic.id);
        if (dup) return { ok: false, reason: dup };
        topics.push(t.topic);
      }
      const group: GuideGroup = { id: g.raw.id as string, title: g.raw.title as string, topics };
      if (text(g.raw.summary)) group.summary = g.raw.summary as string;
      const dup = unique("groups", group.id);
      if (dup) return { ok: false, reason: dup };
      groups.push(group);
    }
    const dup = unique("stages", s.raw.id as string);
    if (dup) return { ok: false, reason: dup };
    out.push({ id: s.raw.id as string, label: s.raw.label as string, groups });
  }
  return { ok: true, stages: out };
}

// The longest a link's label may be. The map gives a label a short run between two boxes; this is
// the only limit Galley puts on the map's data (stage and group counts are the skill's guidance).
export const LINK_LABEL_MAX = 40;

// The guide's links: each joins two different groups of the guide, once, with a short label.
function links(
  raw: unknown,
  stageList: GuideStage[],
): { ok: true; links: GuideLink[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "guide.links must be an array" };
  const groups = new Set(stageList.flatMap((s) => s.groups.map((g) => g.id)));
  const out: GuideLink[] = [];
  const seen = new Set<string>();
  for (const [i, l] of raw.entries()) {
    const at = `guide.links[${i}]`;
    if (!l || typeof l !== "object" || Array.isArray(l))
      return { ok: false, reason: `${at} must be an object` };
    const r = l as Record<string, unknown>;
    for (const field of ["from", "to"])
      if (!text(r[field]))
        return { ok: false, reason: `${at}.${field} must be a non-empty string` };
    const link = { from: r.from as string, to: r.to as string };
    const named = `${at} (${link.from} → ${link.to})`;
    if (!text(r.label)) return { ok: false, reason: `${named}.label must be a non-empty string` };
    const label = r.label as string;
    for (const id of [link.from, link.to])
      if (!groups.has(id))
        return { ok: false, reason: `${named}: ${JSON.stringify(id)} is not a group id` };
    if (link.from === link.to) return { ok: false, reason: `${named} joins a group to itself` };
    // Counted in characters as the reader sees them, not UTF-16 units.
    const length = [...label].length;
    if (length > LINK_LABEL_MAX)
      return {
        ok: false,
        reason: `${named}: the label is ${length} characters; the limit is ${LINK_LABEL_MAX}`,
      };
    // A link is found again by its two ends (a comment on it, its line on the map), so a pair
    // joins once; say both things in one label.
    const key = `${link.from}>${link.to}`;
    if (seen.has(key)) return { ok: false, reason: `${named} repeats a link` };
    seen.add(key);
    out.push({ ...link, label });
  }
  return { ok: true, links: out };
}

// Validate + normalize an agent-supplied guide. Required: a non-empty `overview`, and `files`,
// `stages` or both. `stages` (stages → groups → topics) is shape-checked by stages() above. A
// `files` array, when given, is non-empty, and its every entry has a `path` and (unless
// `skim: true`) an `orientation`. `order` and `category` are optional (default to the entry's position /
// "Changes"); `flag` is an optional note whose presence raises the file's flag. Returns the
// normalized guide with files sorted by `order`, or a reason the input was rejected. Pure —
// no IO — so it's the same check on the server and CLI.
export function validateGuide(input: unknown): GuideValidation {
  if (!input || typeof input !== "object") return { ok: false, reason: "guide must be an object" };
  const g = input as Record<string, unknown>;
  if (typeof g.overview !== "string" || !g.overview.trim())
    return { ok: false, reason: "guide.overview must be a non-empty string" };
  if (g.files === undefined && g.stages === undefined)
    return { ok: false, reason: "guide needs files or stages (or both)" };
  let topicStages: GuideStage[] | undefined;
  if (g.stages !== undefined) {
    const s = stages(g.stages);
    if (!s.ok) return s;
    topicStages = s.stages;
  }
  let topicLinks: GuideLink[] | undefined;
  if (g.links !== undefined) {
    if (!topicStages) return { ok: false, reason: "guide.links needs stages" };
    const l = links(g.links, topicStages);
    if (!l.ok) return l;
    topicLinks = l.links;
  }
  if (g.skims !== undefined && !topicStages)
    return { ok: false, reason: "guide.skims needs stages" };
  const skims: NonNullable<Guide["skims"]> = [];
  if (g.skims !== undefined) {
    if (!Array.isArray(g.skims)) return { ok: false, reason: "guide.skims must be an array" };
    for (const [i, raw] of g.skims.entries()) {
      const at = `guide.skims[${i}]`;
      if (!raw || typeof raw !== "object" || !text(raw.reason))
        return { ok: false, reason: `${at}.reason must be a non-empty string` };
      if (raw.rule !== undefined && !text(raw.rule))
        return { ok: false, reason: `${at}.rule must be a non-empty string` };
      const c = covers(raw.covers, at);
      if (!c.ok) return c;
      skims.push({
        reason: raw.reason,
        ...(raw.rule === undefined ? {} : { rule: raw.rule }),
        covers: c.covers,
      });
    }
  }
  const rawFiles = g.files ?? [];
  if (!Array.isArray(rawFiles)) return { ok: false, reason: "guide.files must be an array" };
  if (rawFiles.length === 0 && !topicStages)
    return { ok: false, reason: "guide.files must not be empty" };
  const files: GuideFile[] = [];
  for (let i = 0; i < rawFiles.length; i++) {
    const raw = rawFiles[i];
    if (!raw || typeof raw !== "object")
      return { ok: false, reason: `guide.files[${i}] must be an object` };
    const f = raw as Record<string, unknown>;
    if (typeof f.path !== "string" || !f.path.trim())
      return { ok: false, reason: `guide.files[${i}].path must be a non-empty string` };
    // A whole-file skim leaves the review flow, so the reviewer never reads its orientation —
    // optional there (skimReason says why). Partial skims (skimBlocks) stay in the flow and
    // keep it required. Present or not, an orientation is never blank.
    if (
      (f.orientation !== undefined || f.skim !== true) &&
      (typeof f.orientation !== "string" || !f.orientation.trim())
    )
      return { ok: false, reason: `guide.files[${i}].orientation must be a non-empty string` };
    const file: GuideFile = {
      path: f.path,
      order: typeof f.order === "number" && Number.isFinite(f.order) ? f.order : i,
      category: typeof f.category === "string" && f.category.trim() ? f.category : "Changes",
    };
    if (typeof f.orientation === "string") file.orientation = f.orientation;
    if (typeof f.flag === "string" && f.flag.trim()) file.flag = f.flag;
    // Skim fields (focused review). File-level `skim`/`skimReason` collapse the whole file;
    // `skimBlocks` are new-side line spans. This is SHAPE validation only — whether a span
    // actually resolves to a change block is diff-aware and checked later (resolveSkim in
    // state.ts), because validateGuide is pure (no diff in hand).
    if (f.skim === true) file.skim = true;
    if (typeof f.skimReason === "string" && f.skimReason.trim()) file.skimReason = f.skimReason;
    if (f.skimBlocks !== undefined) {
      if (!Array.isArray(f.skimBlocks))
        return { ok: false, reason: `guide.files[${i}].skimBlocks must be an array` };
      const blocks: NonNullable<GuideFile["skimBlocks"]> = [];
      for (let j = 0; j < f.skimBlocks.length; j++) {
        const rawBlock = f.skimBlocks[j] as Record<string, unknown> | null | undefined;
        if (!rawBlock || typeof rawBlock !== "object")
          return { ok: false, reason: `guide.files[${i}].skimBlocks[${j}] must be an object` };
        // `lines` is a [start, end] span or a bare number (a single line, normalized to [n, n]).
        const raw = rawBlock.lines;
        let span: [number, number] | null = null;
        if (typeof raw === "number" && Number.isFinite(raw)) span = [raw, raw];
        else if (
          Array.isArray(raw) &&
          raw.length === 2 &&
          typeof raw[0] === "number" &&
          typeof raw[1] === "number" &&
          Number.isFinite(raw[0]) &&
          Number.isFinite(raw[1])
        )
          span = raw[0] <= raw[1] ? [raw[0], raw[1]] : [raw[1], raw[0]];
        if (!span)
          return {
            ok: false,
            reason: `guide.files[${i}].skimBlocks[${j}].lines must be a line number or a [start, end] pair`,
          };
        const block: { lines: [number, number]; reason?: string } = { lines: span };
        if (typeof rawBlock.reason === "string" && rawBlock.reason.trim())
          block.reason = rawBlock.reason;
        blocks.push(block);
      }
      if (blocks.length) file.skimBlocks = blocks;
    }
    // Guide-declared move (issue 03): `movedFrom` is the OLD path a moved+edited file came from.
    // Shape-only here (non-empty string) — whether it resolves to a full deletion + untracked
    // addition is diff-aware (resolveMovedFrom in state.ts). Rejecting movedFrom+skimBlocks on one
    // entry is a real check, not shape: the merge collapses the pair into one section with no
    // rawDiff, so a skimBlocks span (which resolves against rawDiff) could never match. Whole-file
    // `skim` stays allowed (a client-side flag needing no resolution).
    if (f.movedFrom !== undefined) {
      if (typeof f.movedFrom !== "string" || !f.movedFrom.trim())
        return { ok: false, reason: `guide.files[${i}].movedFrom must be a non-empty string` };
      if (file.skimBlocks?.length)
        return {
          ok: false,
          reason: `guide.files[${i}] cannot set both movedFrom and skimBlocks`,
        };
      file.movedFrom = f.movedFrom;
    }
    // Guide parts: shape only here — whether each span claims a change block, and whether two
    // parts claim the same one, is diff-aware (resolveParts in state.ts). A part narrows the
    // entry to some of the file's blocks, so it can't sit with a whole-file skim, nor with
    // movedFrom (a merged move has no rawDiff section for the spans to resolve against).
    // Every part error names the path, and the part's title once it has a usable one.
    if (f.part !== undefined) {
      const part = f.part as Record<string, unknown> | null;
      const on = `on "${f.path}"`;
      if (!part || typeof part !== "object" || Array.isArray(part))
        return {
          ok: false,
          reason: `guide.files[${i}].part (${on}) must be an object with a title and lines`,
        };
      if (typeof part.title !== "string" || !part.title.trim())
        return {
          ok: false,
          reason: `guide.files[${i}].part.title (${on}) must be a non-empty string`,
        };
      const named = `part "${part.title}" ${on}`;
      const lines = partLines(part.lines);
      if (!lines)
        return {
          ok: false,
          reason: `guide.files[${i}].part.lines (${named}) must be a non-empty array of line numbers and [start, end] pairs`,
        };
      for (const field of ["skim", "movedFrom"] as const)
        if (file[field] !== undefined)
          return {
            ok: false,
            reason: `guide.files[${i}] (${named}) cannot set both part and ${field}`,
          };
      file.part = { title: part.title, lines };
    }
    files.push(file);
  }
  // A path listed more than once is a split file, and a split file is split all the way: an entry
  // without a part would claim the whole file a second time, and two steps for one path would
  // collide in the walkthrough and navigation. Its part titles are distinct, since the desk
  // re-finds the reviewer's part by title when a reload or a new guide moves the entries.
  const partless = new Map<string, number>();
  const seen = new Set<string>();
  const titles = new Set<string>();
  for (const [i, file] of files.entries()) {
    if (!file.part && !partless.has(file.path)) partless.set(file.path, i);
    if (seen.has(file.path) && partless.has(file.path))
      return {
        ok: false,
        reason: `guide lists "${file.path}" more than once, so every entry for it needs a part (guide.files[${partless.get(file.path)}] has none)`,
      };
    seen.add(file.path);
    if (!file.part) continue;
    const title = JSON.stringify([file.path, file.part.title]);
    if (titles.has(title))
      return {
        ok: false,
        reason: `guide.files[${i}] repeats part "${file.part.title}" on "${file.path}" — each part of a file needs its own title`,
      };
    titles.add(title);
  }
  files.sort((a, b) => a.order - b.order);
  const guide: Guide = { overview: g.overview };
  if (files.length) guide.files = files;
  if (topicStages) guide.stages = topicStages;
  if (topicLinks?.length) guide.links = topicLinks;
  if (g.skims !== undefined) guide.skims = skims;
  // Focused-review flag (issue 04) — display-only, badges the overview. A boolean or absent;
  // any other type is a schema violation (consistent with the field-shape checks above).
  if (g.focused !== undefined) {
    if (typeof g.focused !== "boolean")
      return { ok: false, reason: "guide.focused must be a boolean" };
    guide.focused = g.focused;
  }
  if (typeof g.title === "string" && g.title.trim()) guide.title = g.title;
  if (typeof g.prDescription === "string" && g.prDescription.trim())
    guide.prDescription = g.prDescription;
  if (typeof g.baseDiffHash === "string" && g.baseDiffHash) guide.baseDiffHash = g.baseDiffHash;
  return { ok: true, guide };
}

// Whether two validated guides say the same thing, whatever diff each was stamped against
// (baseDiffHash). A stored guide is a validated one round-tripped through JSON, so they compare
// as JSON.
export function sameGuide(a: Guide, b: Guide) {
  const bare = (g: Guide) => JSON.stringify({ ...g, baseDiffHash: undefined });
  return bare(a) === bare(b);
}
