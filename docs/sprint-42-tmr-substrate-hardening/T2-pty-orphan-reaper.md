# Sprint 42 — T2: TermDeck PTY orphan reaper

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

The TermDeck server should detect when a Claude Code session's parent process terminates and reap the orphan node-pty children. Add a periodic check (every 30s) walking process children, comparing PIDs to a registry of known parent-PID-to-PTY mappings, killing orphans. Add a `/api/pty-reaper/status` route surfacing live count + reaped-history for observability.

## Files
- NEW `packages/server/src/pty-reaper.js`
- `packages/server/src/index.js` — wire the reaper at server boot
- NEW `tests/pty-reaper.test.js`
- NEW `/api/pty-reaper/status` route (read-only)

## Acceptance criteria
1. Live PTY count via `lsof | wc -l` drops within 60s of a Claude Code session terminating.
2. `/api/pty-reaper/status` surfaces a non-empty `reaped_history` after running for 5 min in a heavy-use environment.
3. New tests pass deterministically.

## Lane discipline
- Append-only STATUS.md updates with `T2: FINDING / FIX-PROPOSED / DONE` lines
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close
- Stay in lane: T2 owns server-side reaper logic + `/api/pty-reaper/status`. Does NOT touch graph-inference (T1), packaging (T3), or dashboard UI (T4)

## Pre-sprint context
- 2026-04-28 morning incident: `forkpty: Device not configured` blocked Joshua from opening any new terminal.
- Root cause: 585 PTY/tty references open vs `kern.tty.ptmx_max = 511`.
- Eight live `claude` Claude Code sessions, each with 2 MCP children (rag-system + imessage-mcp), holding ~16 PTYs from MCP alone.
- For Joshua at $25/mo Pro tier this was annoying; for any heavier user it's catastrophic.
- Substrate-reliability gap that would surface as "TermDeck breaks after a week of heavy use" for any production user.
- Mirror Sprint 39's flashback-diag observability pattern (in-memory ring buffer + structured log + per-session filter) for `/api/pty-reaper/status`.
