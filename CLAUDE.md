# TermDeck — agent read-order

TermDeck is a browser-based terminal multiplexer with metadata overlays, RAG-aware sessions, and a 3-tier TMR stack (TermDeck + Mnestra + Rumen). Published as `@jhizzard/termdeck` on npm.

## 🚨 P0 STATUS — READ BEFORE ANY OTHER WORK

**`docs/CRITICAL-READ-FIRST-2026-05-07.md`** — two P0 investigations opened
2026-05-07. **Both are closed as of Sprint 64.** Read that file in full for
the resolution context and confirm in your first user-facing message that
you have done so before proceeding with normal backlog work.

- **Investigation 1** (cross-agent Mnestra capture on close) — closed by
  Sprint 62 on code/test grounds and Sprint 63 = Wave 2 on acceptance grounds
  (4/4 panels wrote `session_summary` rows at 2026-05-11 14:23 ET on real
  `/exit`).
- **Investigation 2** (auto-commit on context-compaction-near) — closed by
  Sprint 64 T3. Mechanism: PreCompact hook for Claude Code (bundled
  `memory-pre-compact.js`) + TermDeck server-side periodic-capture timer for
  Codex/Gemini/Grok. See § Hard rules § Auto-commit on context-compaction-near
  below for the implementation map.

## Before any task — read order

1. **`memory_recall(project="termdeck", query="<task topic>")`** — always first.
2. **`~/.claude/CLAUDE.md`** — global rules: time check, session-end email, memory-first, 4+1 inject mandate, never-copy-paste-messages.
3. **This file** — you already are.
4. **`docs/CRITICAL-READ-FIRST-2026-05-07.md`** — open P0s; do not skip.
5. **The ONE task-doc that applies:**

| If you're going to... | Read |
|---|---|
| Modify code, add a feature, fix a bug | `docs/ARCHITECTURE.md` |
| Ship a release (`npm publish`, version bump, CHANGELOG) | **`docs/RELEASE.md` — STRICT** |
| Diagnose an install or runtime issue | `docs/ARCHITECTURE.md` § Known issues |
| **Touch the installer / wizard / migration runner / bundled hooks** | **`docs/INSTALLER-PITFALLS.md` — MANDATORY** (10-class failure taxonomy + 11-item pre-ship checklist; every PR in this surface must trace to a class it avoids) |
| Run or coordinate a 4+1 sprint | `~/.claude/CLAUDE.md` § 4+1 mandate + active `docs/sprint-N-<name>/PLANNING.md` |
| Onboard a new TermDeck user | `docs/GETTING-STARTED.md` |
| Pick the next sprint after the active plan ships | `docs/BACKLOG.md` (P0 section + categorized backlog) |

6. **Then begin.**

## Hard rules

- **No TypeScript.** Zero-build-step is a locked architectural decision.
- **Vanilla JS on the client.** No React, no bundler. xterm.js from CDN.
- **CommonJS `require()` in the server.** node-pty doesn't play with ESM.
- **Never `git push` or `npm publish` without reading `docs/RELEASE.md` first.** Publish order matters (npm before push), Passkey-not-OTP matters (`@jhizzard/*` auths via web Passkey — never use `--otp`), stack-installer audit-trail bump matters. (This rule exists because Sprint 35 close-out got all three wrong — the failure that motivated this file.)
- **Inside a 4+1 sprint lane: no version bumps, no CHANGELOG edits, no commits.** Orchestrator handles those at sprint close.
- **Auto-commit on context-compaction-near is enforced, not advisory.** Sprint 64 T3 (Investigation 2 of `docs/CRITICAL-READ-FIRST-2026-05-07.md`) ships two mechanisms that close the compaction-state-loss gap:
  - **For Claude Code panels:** the `PreCompact` harness hook fires `~/.claude/hooks/memory-pre-compact.js` before context compaction, writing a `source_type='pre_compact_snapshot'` row to Mnestra. Wired in `~/.claude/settings.json` under `hooks.PreCompact` with `matcher: "*"`. Bundled source lives at `packages/stack-installer/assets/hooks/memory-pre-compact.js`; installer wiring at `packages/stack-installer/src/index.js::installPreCompactHook`; refresh path at `packages/cli/src/init-mnestra.js::runHookRefresh`.
  - **For non-Claude panels (Codex/Gemini/Grok):** those CLIs have no PreCompact-equivalent. TermDeck's server runs a periodic-capture timer per active non-Claude panel (default 10 min, throttled to skip if the transcript hasn't grown ≥ 1 KB since the last fire). Implementation at `packages/server/src/index.js::onPanelPeriodicCapture` + timer registration in `spawnTerminalSession`. Override interval via `TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS`.
  - **The advisory rule in `~/.claude/CLAUDE.md` § "Before Context Gets Long" stays in place** as the fallback for sessions where neither hook fires (crash mid-compact, hook not yet vendored, env-var-missing) — but it's belt-and-suspenders, not the primary defense. The hooks are the load-bearing mechanism.

## Current state pointer

Live npm: `@jhizzard/termdeck` and `@jhizzard/termdeck-stack`. For exact current versions, prefer `npm view @jhizzard/termdeck version` (ground truth) over this file. Active sprint plans live in `docs/sprint-N-*/`.

This file's "current state" is intentionally a pointer, not a source of truth — version numbers go stale fast, and `git log -1` / `npm view` / `memory_recall` always beat documentation.
