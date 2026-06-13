# Galley — AGENTS.md / CLAUDE.md snippet

Paste the block below into your agent's instruction file (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, …) so the agent always routes plan/PR/change review through Galley. It's deliberately short and points at `galley spec` for the full contract (modes, the event loop, CLI options, `ReviewResult`, and how to act).

---

## Reviewing with Galley

When the user should review a plan, a PR, or code changes you've made, hand it to **Galley** — a living browser review desk. Three ways to start (each stays alive across rounds):

- **Changes you made** → `galley --session <task-id> &` (working tree; `--diff staged` for staged only).
- **A markdown plan / single artifact** → `galley file <path> &`.
- **A branch / PR** → `galley pr <ref> &`.

**For the full contract — the `await`/`comment`/`reload` loop, event shapes, `ReviewResult`, how to act on accepted/rejected/requested changes, the guided-review schema, and all options — run `galley spec` and follow it (once per session before your first review).**
