import MarkdownIt from "markdown-it";
import type { TopicOption } from "./types.js";
const parser = new MarkdownIt({ html: false });

// Options are mutually exclusive alternatives, not independent change requests. The desk
// validates and stamps the body's one block so every tab draws and quotes the same list.
// Only top-level fences count; quoted examples and nested code stay markdown.
export function optionBlocks(body: string) {
  const lines = body.split("\n");
  return parser.parse(body, {}).flatMap((t) =>
    t.type === "fence" && t.level === 0 && t.info.trim() === "options" && t.map
      ? [
          {
            line: t.map[0] + 1,
            source: lines.slice(t.map[0], t.map[1]).join("\n"),
            options: parseOptions(t.content),
          },
        ]
      : [],
  );
}

// Keep these checks identical to ui/topics-options-derive.ts: that browser-only copy reads
// reply fences without pulling backend runtime code across the compilation boundary.
export function parseOptions(source: string): TopicOption[] | null {
  try {
    const value: unknown = JSON.parse(source);
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      !value.every(
        (o) =>
          o &&
          typeof o === "object" &&
          !Array.isArray(o) &&
          typeof o.label === "string" &&
          (o.note === undefined || typeof o.note === "string") &&
          (o.ships === undefined || typeof o.ships === "boolean") &&
          (o.recommended === undefined || typeof o.recommended === "boolean"),
      ) ||
      value.filter((o) => o.ships).length > 1
    )
      return null;
    return value.map(({ label, note, ships, recommended }) => ({
      label,
      ...(note !== undefined && { note }),
      ...(ships !== undefined && { ships }),
      ...(recommended !== undefined && { recommended }),
    }));
  } catch {
    return null;
  }
}
