# T1 — Crash class (PTY-leak + WS ioctl + body-parser)

You are T1 in Sprint 63 = Wave 2. Your lane closes three acute failure modes from Brad's r730 logs, all on the TermDeck server surface.

## Boot sequence

1. `mcp__mnestra__memory_recall(project="termdeck", query="PTY leak session.pty null WS ioctl body-parser")`
2. `mcp__mnestra__memory_recall(query="recent decisions and bugs 2026-05-08 through 2026-05-11")`
3. Read `~/.claude/CLAUDE.md` (global rules — 3+1+1 hardening + RLS hygiene + no-forbidden-literals)
4. Read `./CLAUDE.md` (TermDeck project read-order)
5. Read `docs/CRITICAL-READ-FIRST-2026-05-07.md` (Investigation 1 resolution + Investigation 2 still-open)
6. Read `docs/sprint-63-wave-2/PLANNING.md`
7. Read `docs/sprint-63-wave-2/STATUS.md`
8. Read this file in full

Then begin.

## Scope

Three sub-tasks; ship as a single FIX-PROPOSED block once all three are coherent.

### 1.1 — PTY-leak fix: `session.pty = null` on `term.onExit`

Root cause (Joshua's 2026-05-08/09 overnight `kern.tty.ptmx_max=511` exhaustion — 516 fds for 4 sessions): the `Session` object retains a strong reference to the exited `pty` instance after `term.onExit` fires, blocking GC and pinning the fd.

Fix shape (Brad's 2026-05-07 patch suggestion #1):
```js
// in session.js, inside the onExit handler chain
session.pty = null;  // after kill or natural exit; before onPanelClose callback
```

Then audit every `if (session.pty)` guard in the codebase — they become correct as side-effect-free truthiness checks. Existing `meta.status === 'exited'` checks from Sprint 59 stay; they're a different invariant.

**Risk:** memory races if `term.kill()` and `term.onExit` interleave with `session.pty = null`. Order the nulling AFTER `onExit` fires so the `onPanelClose` chain still has `session.pty` to read. T4-CODEX will be looking for this race.

### 1.2 — WS ioctl race guard

Brad's r730 log signature (25× over 13h):
```
ws message handler error: Error: ioctl(2) failed, EBADF/ENOTTY
```

Race: WS `resize`/`setSize` event arrives after the PTY reaper has closed the fd but before the session's exit propagates to the WS bookkeeping.

Fix shape (Brad's 2026-05-07 patch suggestion #2):
- In the WS resize handler, gate `pty.resize(cols, rows)` on `session.pty && !session.pty._destroyed`.
- Downgrade EBADF/ENOTTY errors caught here to `console.debug(...)` (not `console.error(...)`).
- Plus: `POST /api/sessions/:id/resize` returns `410 Gone` (NOT `409 Conflict`) when PTY has exited. Semantically correct per Brad's #3.

### 1.3 — body-parser hardening with raw-body capture

Brad's r730 log signature (9× over 13h):
```
SyntaxError: Bad control character in string literal in JSON at position 9
```

Express receives PTY output as JSON body without sanitization.

Fix shape:
- Custom `verify` callback on `express.json()` that captures `req.rawBody = buf` for the error middleware to use.
- Error middleware: hex-escape a 32-byte prefix of `req.rawBody` into a warn-level log line so the operator can identify WHICH caller is sending bad JSON (without exposing full body — PII-conservative).
- Alternative path: per-route raw-body parser with explicit JSON.parse + try/catch returning 400 with a structured error.

Brad's exact patch is in `~/termdeck-fix-plan-bodyparser-ws-2026-05-07.md` (his r730) and `~/termdeck-github-issue-bodyparser-ws.md`. Re-verify against the v1.1.1 baseline; the underlying signals were also patched in v1.0.14 hotfix per CHANGELOG.

## Files of interest

- `packages/server/src/index.js` — body-parser config, WS resize/setSize handler, `/api/sessions/:id/resize` route
- `packages/server/src/session.js` — `term.onExit` handler, session.pty management
- `packages/server/tests/` — add fence tests for each sub-task

## Acceptance criteria

For this lane to close (post `### [T1] DONE`):
- `npm test` root green (regression-clean; expect 48 → 51+ tests with fences for each sub-task).
- Brad's three log signatures (body-parser SyntaxError flood, WS ioctl flood, PTY accumulation) — diff the fix locally against a synthetic reproducer if possible, or call out the manual verification path Brad can run post-upgrade.
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles those at sprint close.

## Post discipline

`### [T1] STATUS-VERB 2026-05-11 HH:MM ET — <gist>`

Status verbs: BOOTED → FINDING (as needed) → FIX-PROPOSED → FIX-LANDED → DONE. Use `### ` prefix on every post (rule 2 from global CLAUDE.md hardening). No bare `[T1]` posts.

If you hit a scope question, post `### [T1] FINDING ... — scope question: <X>` and idle-poll for `### [ORCH] SCOPE ...` adjudication.
