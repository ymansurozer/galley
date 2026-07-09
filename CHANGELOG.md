# Changelog


## v0.6.0

[compare changes](https://github.com/ymansurozer/galley/compare/v0.5.0...v0.6.0)

### 🚀 Enhancements

- Inline comment composers and refreshed thread typography ([0171fdb](https://github.com/ymansurozer/galley/commit/0171fdb))
- Wrap-around navigation that seeks unreviewed files ([271fe97](https://github.com/ymansurozer/galley/commit/271fe97))
- Batch question delivery and fold open questions into Send ([f8427cd](https://github.com/ymansurozer/galley/commit/f8427cd))
- Skimmable changes — guide-driven focused reviews ([5b2e67d](https://github.com/ymansurozer/galley/commit/5b2e67d))

### 🔥 Performance

- Slim review saves to the reviewer-owned slice and coalesce bursts ([eba364b](https://github.com/ymansurozer/galley/commit/eba364b))

### 🩹 Fixes

- Make the contract explicit that answering a question is read-only ([adecad0](https://github.com/ymansurozer/galley/commit/adecad0))

### 💅 Refactors

- Drop the Overview file list ([bc70e46](https://github.com/ymansurozer/galley/commit/bc70e46))

### 🤖 CI

- Bump checkout and setup-node actions to v5 ([062225a](https://github.com/ymansurozer/galley/commit/062225a))
- Publish through a pinned fresh npm instead of upgrading in place ([13a7010](https://github.com/ymansurozer/galley/commit/13a7010))

### ❤️ Contributors

- Ymansurozer <ymansurozer@gmail.com>

## v0.5.0

[compare changes](https://github.com/ymansurozer/galley/compare/v0.4.0...v0.5.0)

### 🚀 Enhancements

- Redesign comment threads with bubbles and rich text ([#36](https://github.com/ymansurozer/galley/pull/36))
- Add a floating approve button when scrolled ([#37](https://github.com/ymansurozer/galley/pull/37))
- Improve markdown file rendering and add a default-view setting ([#38](https://github.com/ymansurozer/galley/pull/38))

### 🩹 Fixes

- Open each file scrolled to the top ([#25](https://github.com/ymansurozer/galley/pull/25))
- Keep guided auto-advance working across reloads ([#26](https://github.com/ymansurozer/galley/pull/26))
- Diff PRs against the up-to-date base to avoid unrelated changes ([#27](https://github.com/ymansurozer/galley/pull/27))
- Keep approved test files visible in the tree ([#28](https://github.com/ymansurozer/galley/pull/28))
- Keep comments near their line when the code is lightly edited ([#31](https://github.com/ymansurozer/galley/pull/31))
- Drop the redundant checkmark on walkthrough category rows ([#33](https://github.com/ymansurozer/galley/pull/33))
- Cap the comment composer height on narrow screens ([#34](https://github.com/ymansurozer/galley/pull/34))
- Calmer line-selection highlight that clears on Escape ([#35](https://github.com/ymansurozer/galley/pull/35))

### 💅 Refactors

- Drop summaryMarkdown and the duplicate review artifact ([#32](https://github.com/ymansurozer/galley/pull/32))

### 📖 Documentation

- Add PRD for moved-code badges ([#29](https://github.com/ymansurozer/galley/pull/29))

### 🏡 Chore

- Rename npm package to galley-diff ([#30](https://github.com/ymansurozer/galley/pull/30))

### ❤️ Contributors

- Yusuf Mansur Özer <ymansurozer@gmail.com>

## v0.4.0

[compare changes](https://github.com/ymansurozer/galley/compare/v0.3.0...v0.4.0)

### 🚀 Enhancements

- Confirm before sending a review to the agent ([#19](https://github.com/ymansurozer/galley/pull/19))
- Attach an optional overall note when sending a review ([#20](https://github.com/ymansurozer/galley/pull/20))
- Collapse the file tree into a drawer on narrow screens ([#24](https://github.com/ymansurozer/galley/pull/24))

### 🩹 Fixes

- Keep walkthrough sections in provided order when a category repeats ([#21](https://github.com/ymansurozer/galley/pull/21))
- Walkthrough indicators for new files + consistent churn spacing ([#22](https://github.com/ymansurozer/galley/pull/22))
- Align sidebar tab bar and guide bar bottom borders ([#23](https://github.com/ymansurozer/galley/pull/23))

### 💅 Refactors

- ⚠️  Reframe guide file fields as orientation + flag ([#18](https://github.com/ymansurozer/galley/pull/18))

#### ⚠️ Breaking Changes

- ⚠️  Reframe guide file fields as orientation + flag ([#18](https://github.com/ymansurozer/galley/pull/18))

### ❤️ Contributors

- Yusuf Mansur Özer <ymansurozer@gmail.com>

## v0.3.0

[compare changes](https://github.com/ymansurozer/galley/compare/v0.2.4...v0.3.0)

### 🩹 Fixes

- Show untracked files in working-tree review ([#16](https://github.com/ymansurozer/galley/pull/16))

### 💅 Refactors

- ⚠️  Make `galley spec` the single source of truth for the agent contract ([#17](https://github.com/ymansurozer/galley/pull/17))

#### ⚠️ Breaking Changes

- ⚠️  Make `galley spec` the single source of truth for the agent contract ([#17](https://github.com/ymansurozer/galley/pull/17))

### ❤️ Contributors

- Yusuf Mansur Özer <ymansurozer@gmail.com>

## v0.2.4

[compare changes](https://github.com/ymansurozer/galley/compare/v0.2.3...v0.2.4)

### 🚀 Enhancements

- Go to line by typing its number ([#9](https://github.com/ymansurozer/galley/pull/9))
- Render guide prose as markdown and promote guidance typography ([#11](https://github.com/ymansurozer/galley/pull/11))
- Make review progress visible, animated, and always-on ([#12](https://github.com/ymansurozer/galley/pull/12))
- Add walkthrough sidebar tab and overview file list ([#13](https://github.com/ymansurozer/galley/pull/13))
- Ephemeral agent status line and agent-presence signal in the desk ([#14](https://github.com/ymansurozer/galley/pull/14))

### 🩹 Fixes

- Make the active Split/Stacked tab visibly selected ([#10](https://github.com/ymansurozer/galley/pull/10))
- Keep the accept/reject bar directly under its hunk when a comment shares the line ([#15](https://github.com/ymansurozer/galley/pull/15))

### ❤️ Contributors

- Yusuf Mansur Özer <ymansurozer@gmail.com>

## v0.2.3

[compare changes](https://github.com/ymansurozer/galley/compare/v0.2.2...v0.2.3)

### 🚀 Enhancements

- Open files from the review desk ([#4](https://github.com/ymansurozer/galley/pull/4))

### 🩹 Fixes

- Tree indent depth cap and staged-diff baseline ([#6](https://github.com/ymansurozer/galley/pull/6))
- Unify pointer and keyboard line highlight in the diff ([#7](https://github.com/ymansurozer/galley/pull/7))
- Kbd symbol rendering and overview category overflow ([#8](https://github.com/ymansurozer/galley/pull/8))

### 📖 Documentation

- Replace AGENTS.md with a CLAUDE.md codebase guide ([1583f9f](https://github.com/ymansurozer/galley/commit/1583f9f))

### ❤️ Contributors

- Yusuf Mansur Özer <ymansurozer@gmail.com>
- Burak Fidancı ([@burakfidanci](https://github.com/burakfidanci))
- Ymansurozer <ymansurozer@gmail.com>

## v0.2.2

[compare changes](https://github.com/ymansurozer/galley/compare/v0.2.1...v0.2.2)

## v0.2.1

[compare changes](https://github.com/ymansurozer/galley/compare/v0.2.0...v0.2.1)

### 📖 Documentation

- Lead README with Getting Started, then Features and Principles ([#3](https://github.com/ymansurozer/galley/pull/3))

### ❤️ Contributors

- Yusuf Mansur Özer <ymansurozer@gmail.com>

