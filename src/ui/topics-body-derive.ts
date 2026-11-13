import MarkdownIt from "markdown-it";

// A `lines` fence is drawn from the desk's stamp of where its lines are now (TopicStamp lineSpans),
// not from its text, so only its place is read here.
export type TopicBodyBlock = {
  kind: "markdown" | "mermaid" | "options" | "lines";
  text: string;
  line: number;
};
const FENCES = new Set(["mermaid", "options", "lines"]);
const parser = new MarkdownIt({ html: false });

// Use markdown's own fence rules so examples inside longer fences, lists and quotes stay prose.
// Source slices preserve the agent's text (including CRLF); token.content normalises it.
export function parseTopicBody(body: string): TopicBodyBlock[] {
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks: TopicBodyBlock[] = [];
  let at = 0;
  for (const token of parser.parse(body, {})) {
    if (token.type !== "fence" || token.level !== 0 || !FENCES.has(token.info.trim()) || !token.map)
      continue;
    const [start, end] = token.map;
    if (start > at)
      blocks.push({ kind: "markdown", text: lines.slice(at, start).join(""), line: at + 1 });
    const closing = lines[end - 1]?.trim() ?? "";
    const closed = new RegExp(`^${token.markup[0]}{${token.markup.length},}$`).test(closing);
    blocks.push({
      kind: token.info.trim() as "mermaid" | "options" | "lines", // one of FENCES
      text: lines.slice(start + 1, closed ? end - 1 : end).join(""),
      line: start + 1,
    });
    at = end;
  }
  if (at < lines.length)
    blocks.push({ kind: "markdown", text: lines.slice(at).join(""), line: at + 1 });
  return blocks;
}
