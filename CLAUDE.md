# TermDeck — agent read-order

TermDeck is a browser-based terminal multiplexer with metadata overlays, RAG-aware sessions, and a 3-tier TMR stack (TermDeck + Mnestra + Rumen). Published as `@jhizzard/termdeck` on npm.

## Before any task — read order

1. **`memory_recall(project="termdeck", query="<task topic>")`** — always first.
2. **`~/.claude/CLAUDE.md`** — global rules: time check, session-end email, memory-first, 4+1 inject mandate, never-copy-paste-messages.
3. **This file** — you already are.
4. **The ONE task-doc that applies:**

| If you're going to... | Read |
|---|---|
| Modify code, add a feature, fix a bug | `docs/ARCHITECTURE.md` |
| Ship a release (`npm publish`, version bump, CHANGELOG) | **`docs/RELEASE.md` — STRICT** |
| Diagnose an install or runtime issue | `docs/ARCHITECTURE.md` § Known issues |
| Run or coordinate a 4+1 sprint | `~/.claude/CLAUDE.md` § 4+1 mandate + active `docs/sprint-N-<name>/PLANNING.md` |
| Onboard a new TermDeck user | `docs/GETTING-STARTED.md` |
| Pick the next sprint after the active plan ships | `docs/BACKLOG.md` (P0 section + categorized backlog) |

5. **Then begin.**

## Hard rules

- **No TypeScript.** Zero-build-step is a locked architectural decision.
- **Vanilla JS on the client.** No React, no bundler. xterm.js from CDN.
- **CommonJS `require()` in the server.** node-pty doesn't play with ESM.
- **Never `git push` or `npm publish` without reading `docs/RELEASE.md` first.** Publish order matters (npm before push), Passkey-not-OTP matters (`@jhizzard/*` auths via web Passkey — never use `--otp`), stack-installer audit-trail bump matters. (This rule exists because Sprint 35 close-out got all three wrong — the failure that motivated this file.)
- **Inside a 4+1 sprint lane: no version bumps, no CHANGELOG edits, no commits.** Orchestrator handles those at sprint close.

## Current state pointer

Live npm: `@jhizzard/termdeck` and `@jhizzard/termdeck-stack`. For exact current versions, prefer `npm view @jhizzard/termdeck version` (ground truth) over this file. Active sprint plans live in `docs/sprint-N-*/`.

This file's "current state" is intentionally a pointer, not a source of truth — version numbers go stale fast, and `git log -1` / `npm view` / `memory_recall` always beat documentation.
