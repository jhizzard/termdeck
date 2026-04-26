# T1 — Analyzer + error detection

You are Terminal 1 in Sprint 33 / Flashback debug. Your lane: the layer between PTY bytes and `meta.status='errored'`. If errors aren't being detected, nothing downstream can fire. Audit it.

## Read first
1. `docs/sprint-33-flashback-debug/PLANNING.md` — sprint overview, especially the pipeline diagram
2. `docs/sprint-33-flashback-debug/STATUS.md` — protocol
3. `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. `packages/server/src/session.js` — your primary file. Find PATTERNS.error, PATTERNS.errorLineStart, the analyzer loop, the status transition, the onErrorDetected callback wiring.
5. `tests/analyzer-error-fixtures.test.js` — existing fixture coverage. What does it actually test?

## You own
- `packages/server/src/session.js`
- `tests/analyzer-error-fixtures.test.js`

## You do NOT touch
- T2/T3/T4 files (rag.js, mnestra-bridge, index.js's WS emit block, anything in ~/Documents/Graciella/engram/, anything in tests/flashback-e2e.test.js)

## Audit checklist (post each result to STATUS.md as a FINDING)

1. **Are PATTERNS.error and PATTERNS.errorLineStart actually catching real-world errors?** Pull recent session histories from SQLite (`~/.termdeck/termdeck.db`, table `command_history` and `sessions`). Find rows where the user clearly hit an error (exit_code != 0, or stderr-shaped output). For each, run the analyzer regex against the `output_snippet` or last commands. Does it match? Cite specific examples.
2. **Does the status transition actually fire on match?** Trace `analyzeOutput()` (or whatever the analyzer entry-point is named) from PATTERNS match → `this.meta.status = 'errored'`. Are there any guards that would suppress it (rate limit, already-errored, exit-code check, status-change callback dropping the transition)?
3. **Is the onErrorDetected callback wired?** session.js:380 has a log line: `if (this.onErrorDetected)... else console.log('[flashback] error detected in session ${this.id} but no onErrorDetected handler wired')`. Grep for who SETS `session.onErrorDetected`. If nobody sets it, that's the bug — the analyzer fires, the callback is null, nothing flows downstream.
4. **Is the 30-second rate limit silencing repeated firings?** Check `_lastErrorEventAt` or similar field. If Josh hit the same error twice in a session, the second one is silently suppressed — that might be why he sees zero toasts.
5. **Run `tests/analyzer-error-fixtures.test.js`** — does it pass? Does it cover any error pattern Josh would actually hit?
6. **Live probe**: in a fresh terminal, run `cat /no/such/file` (a known Brad-style cause). Watch for the analyzer fire via:
   ```bash
   tail -f ~/.termdeck/termdeck.db-wal  # crude — watch SQLite WAL grow
   # or
   curl -s http://127.0.0.1:3000/api/sessions/<your-session-id> | jq .meta.status
   ```
   Does meta.status flip to 'errored' within ~2 seconds of the error?

## Decision criteria

- **CONFIRMED-OK**: PATTERNS match Josh-shaped errors; meta.status flips on match; onErrorDetected is wired (you found the setter); rate limit isn't the culprit; live probe hits 'errored' within seconds.
- **BROKEN-AT analyzer**: regex misses common errors → propose tighter or broader patterns + fixture; ship if <30 LOC.
- **BROKEN-AT callback wiring**: `console.log('but no onErrorDetected handler wired')` was being hit because rag.js never registered. Identify whether that's still the case in v0.7.0 — if so, that's the bug.
- **BROKEN-AT rate limit**: 30s suppression too aggressive for Josh's iteration cadence. Propose tunable + a config-knob.

## Output

- Post a `FINDING` line to STATUS.md with one of the categories above and a 2–4-sentence summary.
- If you ship a surgical fix, add a `FIX-PROPOSED` line with diff stats.
- Post `DONE` when your audit is complete.
- Do NOT bump versions, do NOT touch CHANGELOG.md, do NOT commit. T4 + orchestrator handle integration.

## Reference memories
- `memory_recall("flashback onErrorDetected wiring sprint 21")` — past wiring fix
- `memory_recall("PATTERNS error analyzer false positive")` — false-positive history (Sprint 16)
- `memory_recall("Brad cat /no/such/file flashback live probe")` — past live tests
