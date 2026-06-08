# Sprint 68 · T1 — Hook scripts + dedup

**Lane:** T1 (Claude worker) · **Sprint:** 68 — Standalone-shell memory capture · **Owner:** Claude

## Boot sequence

Per `PLANNING.md` § Boot sequence: `memory_recall` ×3 → `~/.claude/CLAUDE.md` → `./CLAUDE.md` → `docs/RESTART-PROMPT-2026-05-19-sprint-68-staged.md` → `docs/INSTALLER-PITFALLS.md` → `PLANNING.md` → `STATUS.md` → this file.

## Your mission

Make the two bundled hook scripts usable as **native CLI hooks** for standalone Codex/Gemini/Grok shells, and implement the **D1 dedup guard** (see `PLANNING.md` § Design decisions — D1). You own the hook *scripts* and the TermDeck-side PTY env marker. You do NOT own the installer (T2) or docs (T3).

## Deliverables

**1.1 — Add the `TERMDECK_PANEL_SESSION` PTY marker.**
Audit `spawnTerminalSession` in `packages/server/src/index.js` (the `pty.spawn` env block, ~lines 1380–1410). Confirm whether any `TERMDECK_*` env var already identifies a TermDeck-spawned child. If none, add `TERMDECK_PANEL_SESSION: session.id` to the spawned-child env. This is the marker the native hooks read for D1. Do NOT touch `SHELL_SESSION_*` / `TERM_SESSION_ID` — the existing comments explain why.

**1.2 — `source_agent` resolution in `memory-session-end.js`.**
Resolution order: stdin payload `source_agent` (the TermDeck `onPanelClose` path) → `process.env.TERMDECK_NATIVE_CLI_HOOK` (the native CLI hook path) → existing `sessionType`/inference. Validate the result against the existing `ALLOWED_SOURCE_AGENTS` whitelist. Default/unknown behaves exactly as today.

**1.3 — D1 no-op guard in `memory-session-end.js`.**
Near the top of the run path: if `process.env.TERMDECK_NATIVE_CLI_HOOK` **and** `process.env.TERMDECK_PANEL_SESSION` are both set, `debug()`-log "native CLI hook inside TermDeck — onPanelClose owns this session" and exit 0. Fail-soft (never throw). This is the regression-safe dedup — see `PLANNING.md` D1 for why it leaves Claude's own SessionEnd hook and `onPanelClose` untouched.

**1.4 — Mirror 1.2 + 1.3 in `memory-pre-compact.js`** (for the Gemini `PreCompress` / Grok `PreCompact` native hooks).

**1.5 — Per-CLI native-hook `transcript_path` resolution.**
For each CLI, determine what its *native* session-end / Stop / compaction hook passes as `transcript_path` on stdin, and confirm the existing parsers (`parseTranscript`, `parseGeminiJson`, the Codex/Grok handling) can read it. **Grok is the risk:** `grok-dev` stores sessions in `~/.grok/grok.db` (SQLite), not a transcript file. If Grok's native hook gives no usable file path, port the grok adapter's `grok.db`-by-`session_id` extraction (`packages/server/src/agent-adapters/grok.js`) into the hook. **Post your Grok verdict to STATUS.md as a FINDING early — T2's deliverable 2.2 is blocked on it.**

**1.6 — Unit coverage of the guard.** Provide `node --test` coverage of the D1 guard truth table (the four invocation paths). Coordinate with T3, who owns the broader fence-test suite.

## Files you'll touch

- `packages/server/src/index.js` — the `spawnTerminalSession` env block (1.1)
- `packages/stack-installer/assets/hooks/memory-session-end.js` (1.2, 1.3)
- `packages/stack-installer/assets/hooks/memory-pre-compact.js` (1.4)
- `packages/server/src/agent-adapters/grok.js` — read-only reference for grok.db extraction (1.5)

## Not your lane

Installer functions / config-file merges (T2). Doc corrections + the main test suite (T3). No version bumps, no CHANGELOG edits, no commits.

## Lane discipline

Post to `STATUS.md` with the canonical shape: `### [T1] <VERB> 2026-MM-DD HH:MM ET — <gist>` (VERB ∈ FINDING / FIX-PROPOSED / FIX-LANDED / DONE). The `### ` prefix is required.
