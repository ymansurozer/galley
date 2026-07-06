---
name: galley
description: Drive Galley — a living browser surface where a human reviews a git diff (accept/reject changes, leave comments) and the coding agent acts on their decisions and replies in the same tab. Use after making code changes the user should review, when the user asks to "open the Galley", or to collaborate on a diff turn-by-turn.
license: MIT
metadata:
  homepage: https://github.com/ymansurozer/galley
---

# Galley

Galley is a **living** browser surface for a git diff (working tree or staged). A human reviews the diff — accepting/rejecting changes and leaving comments — and clicks **Send to Agent**. The desk does **not** close on send: it keeps running across rounds. The agent attaches to it, receives each send, posts replies that appear in the open tab live, and the human keeps going in the same tab.

The review is the human's; the agent acts on the decisions and answers questions. No model runs inside the desk.

## When to use it

Reach for Galley when the user should review something turn-by-turn: **code changes you made** (the working tree or staged diff), **a markdown plan or single artifact**, or **a branch / PR**. Use it when the user asks to "open the Galley", or whenever a diff is better reviewed interactively than pasted into chat.

## Getting the tool

`galley` is a small Node CLI (Node 20+ and `git` required). To use it across any repo, install it globally: `npm install -g galley-diff`. To use it in just one project, add it there as a dev dependency (`npm install -D galley-diff`) and run it with `npx galley-diff`. Either way, invoke it as `galley …`.

## Quickstart

Three ways to start a review desk (each runs in the background and stays alive across rounds):

- **Changes you made** → `galley --session <id> &` (working tree; `--diff staged` for staged only).
- **A markdown plan / single artifact** → `galley file <path> &`.
- **A branch / PR** → `galley pr <ref> &`.

## The authoritative contract: `galley spec`

**For the full contract — review modes, the `await`/`comment`/`reload` loop, `await` exit semantics, the `ReviewResult` shape, how to act on a review, the guided-review schema, reload-vs-restart, concurrency, settings, and errors — run `galley spec` and follow it.** Do this once per session before your first review.
