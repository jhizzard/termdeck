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
  - **For standalone non-Claude shells (a `codex`/`grok`/`agy` session in a plain terminal, outside TermDeck):** closed by Sprint 68-REDUX via **PATH shims**, not native CLI hooks — third-party hook surfaces proved to be churn we don't control, so capture moved to the process boundary. Shim template + drain at `packages/stack-installer/assets/shims/`; installed to `~/.termdeck/shims/` with a marker-fenced PATH block by `packages/stack-installer/src/index.js::installShellShims`; refresh-only path at `packages/cli/src/init-mnestra.js::refreshShellShims`; uninstall splice at `packages/stack-installer/src/uninstall.js::_removeRcShimBlock`. **Dedup contract (D1′):** inside a panel the shim sees `TERMDECK_PANEL_SESSION` (or a non-empty `TERMDECK_SESSION`, the pre-1.18.0 server-skew fallback) and `exec`s the real binary transparently, so `onPanelClose` remains the only writer. **The drain, not the hook, does the cleaning** — every parser in the hook's `TRANSCRIPT_PARSERS` is a JSON/JSONL parser and returns zero messages on a raw PTY transcript; `assets/shims/drain.js` strips ANSI, collapses CR overdraw, de-chromes, segments, and hands the hook a Gemini-shaped envelope with `sessionType: 'auto'` (**never** the CLI's own name — that selects a JSONL parser and silently yields nothing). The clean+segment algorithm is a deliberate **vendored copy** of `packages/server/src/agent-adapters/agy.js`, and `redact.js` is a byte-identical vendored copy of `packages/mcp-bridge/src/redact.js` — INSTALLER-PITFALLS Class N, change both or neither; the parity fences in `packages/stack-installer/tests/shim-*.test.js` pin them.
  - **Two-artifact transcript semantics for shim sessions (Sprint 68-REDUX, ORCH ruling 2026-08-01).** A standalone shim session leaves **two durable files**, and which one a given field points at is deliberate:
    - `memory_sessions.transcript_path` → the **durable envelope** (`{messages:[{type,content}], raw_transcript_path}`). This is what the hook parsed and therefore what any re-parse must read; pointing it at the raw PTY log would hand every downstream consumer something the hook's parsers return zero messages on.
    - `envelope.raw_transcript_path` → the **raw `script(1)` PTY log** at `~/.termdeck/standalone-transcripts/<agent>-<ts>-<pid>.log`. This is the forensic original, for when the cleaned version lost something you need.
    - **Both are durable, both 0600, both under the same 14-day rotation.** Neither is a temp file. The earlier design pointed `transcript_path` at a `os.tmpdir()` envelope that the drain unlinked on hook-close, which left every stored path dangling within milliseconds of being written — a fence in `shim-drain-payload.test.js` now asserts the path still exists when the hook reads it.
    - **Redaction is applied before either file leaves the machine.** `script(1)` captures the RAW TERMINAL — a `export DATABASE_URL=…` typed mid-session, an `env` dump, an auth screen — so the drain redacts per-message and fails **closed** (`‹redacted:redaction-failed›`, never raw) if a rule throws.
  - **The advisory rule in `~/.claude/CLAUDE.md` § "Before Context Gets Long" stays in place** as the fallback for sessions where neither hook fires (crash mid-compact, hook not yet vendored, env-var-missing) — but it's belt-and-suspenders, not the primary defense. The hooks are the load-bearing mechanism.

## Current state pointer

Live npm: `@jhizzard/termdeck` and `@jhizzard/termdeck-stack`. For exact current versions, prefer `npm view @jhizzard/termdeck version` (ground truth) over this file. Active sprint plans live in `docs/sprint-N-*/`.

This file's "current state" is intentionally a pointer, not a source of truth — version numbers go stale fast, and `git log -1` / `npm view` / `memory_recall` always beat documentation.
