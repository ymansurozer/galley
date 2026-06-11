# Galley — AGENTS.md / CLAUDE.md snippet

Paste the block below into your agent's instruction file (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, …) so the agent always routes plan/PR/change review through Galley. It's deliberately short and points at the skill (`skills/galley/SKILL.md`) for the full contract — modes, the event loop, CLI options, and the `ReviewResult` shape.

---

## Reviewing with Galley

When the user should review a plan, a PR, or code changes you've made, hand it to **Galley** — a living browser review desk.

- **Changes you made** → `galley --session <task-id> &` (working tree; `--diff staged` for staged only).
- **A markdown plan / single artifact** → `galley file <path> &`.
- **A branch / PR** → `galley pr <ref> &`.

Optionally attach an AI **guided review** so the human gets an overview + a logical, annotated file order: add `--guide guide.json` to the start command (see the skill for the JSON schema).

Then loop: `galley await --session <task-id>` blocks for the next event and prints a tagged JSON envelope.
- `{"kind":"question",…}` → answer **now** with `galley comment --path … --line … --side … --body "…"` at the question's location.
- `{"kind":"review","result":{…}}` → act on `result`: revert **rejected**, make **requestedChanges**, leave **accepted** alone, leave **approvedFiles** (signed off as-is) untouched, don't touch **stagedFiles** unless a change requires it. (Editing an approved file invalidates its approval → it needs re-review next round.)

After editing code, run `galley reload --session <task-id>` so your edits show in the open tab (add `--guide <file>` to swap in a regenerated guide), then `galley await` again for the next round. The desk stays open across rounds and the reviewer keeps **one tab**: starting is idempotent (a live desk is reused, never duplicated) and the port is stable per session, so even after a desk process dies, re-running the start command brings the same tab back to life — never open a second desk for the same session.

Full reference (modes, options, exit semantics, `ReviewResult`): **`skills/galley/SKILL.md`**.
