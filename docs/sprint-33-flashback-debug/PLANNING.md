# Sprint 33 — Flashback debug

**Started:** 2026-04-26 evening
**Pattern:** 4+1 orchestration. Four parallel Claude Code panels investigate non-overlapping layers of the Flashback pipeline. Orchestrator (this conversation) reads `STATUS.md` and integrates.
**Time-box:** 15–30 minutes. If a fix is found, ship as v0.7.1. If not, the output is a precise diagnosis document (`POSTMORTEM.md`) that becomes Sprint 34's input.

## The complaint

> "It is almost as if Flashbacks are vaporware. They never happen, never any suggestions." — Josh, 2026-04-26

Flashback is the headline feature of TermDeck — *"the terminal that remembers what you fixed last month."* The whole product pitch rests on it firing when a panel hits an error. Memory shows it was fixed in Sprint 21 (v0.4.5: `queryDirect` was sending wrong arg count to an 8-arg SQL function) and audited again in Sprints 22–26. Either the fix regressed, an adjacent change broke it, or the original fix was incomplete.

## What "Flashback fires" requires (the full pipeline)

```
PTY output bytes
  → packages/server/src/session.js — output analyzer
    → PATTERNS.error / PATTERNS.errorLineStart matches
      → meta.status = 'errored'
        → onErrorDetected(session, { lastCommand, tail }) callback
          → packages/server/src/rag.js — handleSessionError
            → packages/server/src/mnestra-bridge/ — direct/webhook/MCP query
              → Mnestra hybrid_search RPC against memory_items
                → results filtered by similarity threshold + project tag
                  → response sent back through bridge
                    → server.js emits proactive_memory WS frame to the panel
                      → packages/client/public/app.js — toast renderer
```

**Any single broken link silences Flashback.** Each Tn audits one slice.

## Lane assignments

| Tn | Layer | Files OWNED (read + edit if a fix is needed) | Files OFF-LIMITS |
|----|-------|-----------------------------------------------|------------------|
| T1 | Analyzer / error detection | `packages/server/src/session.js` (PATTERNS.error, status transition, onErrorDetected wiring), tests/analyzer-error-fixtures.test.js | T2/T3/T4 files |
| T2 | Bridge event flow | `packages/server/src/rag.js`, `packages/server/src/mnestra-bridge/index.js` (and any subfiles), `packages/server/src/index.js` (the proactive_memory WS emit ONLY — single block), tests/failure-injection.test.js | T1/T3/T4 files |
| T3 | Mnestra query path | Mnestra source repo `~/Documents/Graciella/engram/` (READ-ONLY unless a Mnestra-side bug requires a fix and Josh approves), live SQL probe against petvetbid Supabase via `~/.termdeck/secrets.env`, `packages/server/src/preflight.js` (Mnestra reachability) | T1/T2/T4 files |
| T4 | End-to-end + postmortem | `tests/flashback-e2e.test.js` (run it; debug it; extend it), NEW `docs/sprint-33-flashback-debug/POSTMORTEM.md` (the converged diagnosis) | All source code in T1/T2/T3 lanes — read freely, do NOT write |

## Acceptance criteria

By end of sprint, EACH Tn posts to STATUS.md a finding of one of these shapes:

- **CONFIRMED OK** — your layer is working correctly; no regression here. Include the evidence (log lines, test output, manual probe results).
- **BROKEN-AT** — your layer is broken; here's what's wrong; here's the surgical fix. If the fix is < 30 LOC and clearly safe, ship it (commit-free, T4 will integrate). If the fix is bigger, post the diagnosis and let the orchestrator decide.
- **AMBIGUOUS** — your layer might or might not be broken; here's what you'd need to check next.

**T4's POSTMORTEM.md** synthesizes the four findings into a single narrative: "Flashback was silent because X. Here's the timeline. Here's the fix. Here's how we'll prevent regression."

## Ground truth: how to test Flashback locally without guessing

The existing `tests/flashback-e2e.test.js` exercises the full pipeline against a live server. Run it first:

```bash
node --test tests/flashback-e2e.test.js 2>&1 | tail -30
```

If it passes against current code + a live Mnestra, Flashback IS firing in tests but somehow not in Josh's day-to-day usage — narrow the gap (rate limit? threshold? error-pattern mismatch on his actual error shapes?). If it fails, the failure points at the broken layer.

For manual probing, Josh's TermDeck is on `http://127.0.0.1:3000` with Mnestra reachable (4,669+ memory_items, project `petvetbid`). T3 can run direct SQL probes against his store using `~/.termdeck/secrets.env` `DATABASE_URL`.

## Coordination protocol

Same as Sprint 32. Append to `docs/sprint-33-flashback-debug/STATUS.md`:

- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] CLAIM <file>` — before any read-heavy investigation that might suggest a fix
- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] FINDING — <CONFIRMED-OK | BROKEN-AT | AMBIGUOUS>: <evidence>`
- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] FIX-PROPOSED — <description, LOC, safety>`
- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] DONE — <one-line>` once your lane is fully audited and STATUS.md captures your findings

Use `date -u +%Y-%m-%dT%H:%M:%SZ`.

## What ships at the end

If Sprint 33 finds and fixes the bug:
- v0.7.1 patch release with the fix
- Regression test added (so the next time it can't go silent without breaking CI)
- POSTMORTEM.md committed alongside

If Sprint 33 finds the bug but the fix is non-trivial:
- POSTMORTEM.md committed with the diagnosis
- Sprint 34 ships the fix

If all four lanes report CONFIRMED-OK:
- POSTMORTEM.md committed with what was checked + what specifically was working
- The complaint becomes "investigate the actual scenario Josh was in" — likely a usability gap (rate limit too aggressive, threshold too high, his particular errors not matching the analyzer)

## Reference memories
- `memory_recall("flashback queryDirect 8-argument SQL function")` — Sprint 21 fix
- `memory_recall("flashback regression sprint")` — anything related
- `memory_recall("Brad incident sprint 32 v0.7.0")` — recent context
- `memory_recall("PVB 1599 memories Mnestra largest")` — store size + project tag history
- `memory_recall("chopin-nashville tag bug")` — past project-tag bug that broke filtering
