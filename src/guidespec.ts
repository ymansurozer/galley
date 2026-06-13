// The machine contract for an AI guided review. This is the single source of truth, printed
// by `galley guide-spec` so an installed skill can fetch it at runtime instead of hardcoding a
// copy that drifts from the user's installed binary. Contract only: the schema, the field
// meanings, and the validation/reload behavior. How to *write* a good guide is up to you and
// your agent — Galley renders and validates it, and runs no model.
export const GUIDE_SPEC = `galley guided-review spec

Attach a guide at start:  galley <mode> --guide <file.json>

Write the guide file OUTSIDE the repo working tree (a temp path, e.g. one from \`mktemp\`, or
a gitignored directory). Working-tree review mode surfaces untracked files, so a guide left in
the repo would show up in the review as a stray addition — and could get committed by accident.

The file is one JSON object:

{
  "title": string?,          // optional; the overview heading. Falls back to the branch/ref.
  "overview": string,        // required, non-empty; one-paragraph overview of the whole changeset.
  "prDescription": string?,  // optional; author/PR intent, shown on the overview page.
  "files": [                 // required; non-empty array, one entry per file in the review.
    {
      "path": string,        // required, non-empty; repo-relative path of a file in the diff.
      "summary": string,     // required, non-empty; shown in the file's diff header.
      "order": number?,      // optional; review order, ascending. Defaults to array position.
      "category": string?,   // optional; group label (e.g. Config, Core, Tests). Defaults to "Changes".
      "critical": boolean?,  // optional; flags a file as needing closer review.
      "why": string?         // optional; shown when critical is true.
    }
  ]
}

Rendering:
- the prose fields (overview, prDescription, summary, why) render as markdown — inline \`code\`
  for identifiers/paths, emphasis, lists, links, and fenced code blocks all work. Use them;
  raw HTML is stripped.

Validation:
- overview must be a non-empty string; files must be a non-empty array.
- every file needs a non-empty path and a non-empty summary; all other fields are optional.
- files are sorted by order ascending; a missing order defaults to the entry's position.
- an unreadable file, invalid JSON, or a schema violation aborts the launch and names the offending field.

Lifecycle:
- the guide is attached at start and stamped against the diff it was generated for.
- after \`galley reload\` advances the diff past that point, the desk flags the guide as stale; regenerate it from the new diff and restart with a fresh --guide to refresh.

Galley validates and renders this guide. It does not write it and it runs no model: what goes in each summary, which files you flag, and the order you choose are yours to decide.`;
