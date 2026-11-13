import type MarkdownIt from "markdown-it";

// Stamp each commentable block-open token with its 1-based source line (1-based
// matches @pierre/diffs' additions-side numbers). Top-level blocks AND list items,
// so a comment can target an individual list item rather than the whole list.
export function sourceLine(mdi: MarkdownIt) {
  // Shiki returns its own <pre>, bypassing markdown-it's rendering of token attributes.
  // Stamp that outer element too, so topic fences can be replaced after sanitising.
  const fence = mdi.renderer.rules.fence!;
  mdi.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const html = fence(tokens, index, options, env, renderer);
    const line = tokens[index]?.attrGet("data-line");
    return line ? html.replace(/^<pre(?=[ >])/, `<pre data-line="${line}"`) : html;
  };
  mdi.core.ruler.push("source_line", (state) => {
    for (const t of state.tokens)
      if (t.map && (t.level === 0 || t.type === "list_item_open"))
        t.attrSet("data-line", String(t.map[0] + 1));
    return true;
  });
}
