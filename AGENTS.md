# Agent Instructions

## Reviewing with Galley

When the user should review a plan, a PR, or code changes you've made, hand it to **Galley** — a living browser review desk.

- **Changes you made** → `galley --session <task-id> &` (working tree; `--diff staged` for staged only).
- **A markdown plan / single artifact** → `galley file <path> &`.
- **A branch / PR** → `galley pr <ref> &`.

Then loop: `galley await --session <task-id>` blocks for the next event and prints a tagged JSON envelope.
- `{"kind":"question",…}` → answer **now** with `galley comment --path … --line … --side … --body "…"` at the question's location.
- `{"kind":"review","result":{…}}` → act on `result`: revert **rejected**, make **requestedChanges**, leave **accepted** alone, don't touch **stagedFiles** unless a change requires it.

After editing code, run `galley reload --session <task-id>` so your edits show in the open tab, then `galley await` again for the next round. The desk stays open across rounds — don't reopen it.

Full reference (modes, options, exit semantics, `ReviewResult`): **`skills/galley/SKILL.md`**.
