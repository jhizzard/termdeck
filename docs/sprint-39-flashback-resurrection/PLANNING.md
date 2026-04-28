# Sprint 39 — Flashback Resurrection 2.0 (P0, diagnostic-first)

**Status:** Planned. Kickoff overnight 2026-04-27 → 2026-04-28.
**Target version:** `@jhizzard/termdeck` v0.10.1 (patch — bug fix only, no new feature surface).

## Goal

End the Flashback regression that has kept Joshua flashback-blind in his daily flow for ~9 days (since approximately Sprint 26). Sprint 21 (`a1e3f92`, v0.4.3) and Sprint 33 (`6c46725`, v0.7.1) both claimed Flashback fixes that passed isolated e2e tests but missed the production-flow regression: **the e2e test in a synthetic harness fires Flashback correctly, but Joshua's actual zsh/bash sessions never surface a toast.** Sprint 39 is a diagnostic-first sprint — the four lanes work to *measure where the pipeline is broken* before applying any fix, so we don't ship Sprint 33's mistake (claim a fix based on e2e green when production is still silent).

## Background — what's known

From `memory_recall` 2026-04-27:

- **Last verified-working flashback:** approximately 2026-04-18 (Sprint 21 close, commit `a1e3f92`). 9+ days flashback-blind in production.
- **Strong hypothesis (NOT root-caused):** `session.js PATTERNS.error` is matching zsh/bash rcfile noise in real shells (e.g., the noise emitted at shell startup before the user's first command). Each match starts/extends the 30s per-session rate limit, so by the time a real error occurs the limiter has already burned out the window. The synthetic e2e test harness doesn't load rcfiles — explains why isolated tests pass.
- **Alternate hypothesis:** project-tag mismatch. TermDeck's `rag.js` writes to legacy `mnestra_*` tables; Flashback's RPC queries `memory_items`. If the project tag the bridge filters on differs from what the session was created with, the bridge returns empty even when matching memories exist. Recent test failure at `tests/flashback-e2e.test.js:526` matches exactly this shape: "proactive_memory frame.memories is empty even though 5 termdeck-tagged memories match the probe — the bridge is filtering on a different project tag than the session was created with."
- **Other hypotheses to rule out:** `proactive_memory` WS frame timing (race between WS close and frame emit), `RAGIntegration.enabled` gating the wrong code path, `setBridge` wiring not happening before the first error, environmental DATABASE_URL missing on real-flow shells (the running TermDeck server's `/api/health/full` showed `mnestra-pg: fail` because secrets weren't sourced — could mean Flashback queries silently fail in production).
- **What pre-existing tests fail today:** `tests/flashback-e2e.test.js: project-bound flashback…` (exactly the project-tag mismatch case). Plus 3 in `packages/server/tests/session.test.js` (stripAnsi CSI + two `PATTERNS.error` cases) — the analyzer-pattern failures may be the *same* root cause as the rcfile-noise hypothesis.

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Daily-flow instrumentation** | Add structured logging at every Flashback decision point: PATTERNS.error match (with the matched line), onErrorDetected entry/exit (with rate-limit state), proactive_memory emit attempt (with WS readyState + frame size), RAGIntegration enabled check, bridge.queryMnestra call (with project tag + result count). New endpoint `GET /api/flashback/diag` returns the structured log for the last N events. After T1 lands, Joshua should be able to trigger an error in a real shell and read the diag stream to see exactly which decision dropped the toast. | `packages/server/src/session.js`, `packages/server/src/index.js`, `packages/server/src/rag.js`, `packages/server/src/mnestra-bridge/index.js`, NEW route in `packages/server/src/index.js` |
| **T2 — zsh/bash rcfile-noise filter audit** | Test the strong hypothesis directly. Reproduce: open a fresh PTY in TermDeck against `/bin/zsh -i`, capture the output stream, run the existing `session.js PATTERNS.error` regex against each line, count false positives. If false positives ≥ 1 per shell start, the hypothesis is confirmed. Then propose a fix: tighten PATTERNS.error to require `error|fail|exception|fatal|denied|cannot|not found|no such` followed by either an explicit colon-or-bracket structure OR a non-rcfile context marker. Ship the tightened regex with regression tests covering the actual rcfile noise patterns observed. | `packages/server/src/session.js` (PATTERNS array + matcher), `tests/session.test.js` (extend with rcfile-noise corpus), NEW `tests/rcfile-noise-fixtures/*.txt` (captured zsh/bash startup transcripts) |
| **T3 — Project-tag write-path verification** | Audit the cross-table data flow. Map every write path that lands a memory in either `memory_items` (queried by Flashback) or the legacy `mnestra_*` tables (still receiving rag.js telemetry writes). For each path, identify what `project` tag is stamped + how it's resolved. Specifically test: when a TermDeck session has `meta.project='termdeck'`, does the bridge's RPC query filter on `'termdeck'` or something else? Answer the open question raised by `tests/flashback-e2e.test.js:526` ("bridge is filtering on a different project tag than the session was created with"). | `packages/server/src/rag.js`, `packages/server/src/mnestra-bridge/index.js`, `packages/server/src/session.js` (project resolution), `~/Documents/Graciella/engram/src/recall.ts` (the RPC consumer side) |
| **T4 — Production-flow e2e test** | Build an e2e test that runs against the user's actual shell stream — not a synthetic transcript. Spawn a real zsh subprocess via node-pty, send it the same `cat /nonexistent/file/path` trigger the existing test uses, but let zsh load its rcfiles first (existing test bypasses them). Assert the proactive_memory WS frame fires within 5 seconds AND contains non-empty memories. This is the test that should be failing today and should pass after T2 + T3 land. | NEW `tests/flashback-production-flow.test.js`, refactor of `tests/flashback-e2e.test.js` to share fixtures |

## Out of scope (Sprint 40+)

- "Easy way to track questions and blockers across panels" (Brad's feature request from 2026-04-26 — backlog item).
- MCP-load-after-TermDeck-restart issue (Brad's finding 2026-04-26 — separate stale-process diagnosis).
- Per-source-type recency half-life in `memory_recall_graph` (Sprint 38 follow-up).
- T2 graph-inference SQL rewrite (Sprint 38 follow-up, task #19).

## Open design questions

1. **Where does the `/api/flashback/diag` log live?** In-memory ring buffer (lost on restart) or persisted to a small SQLite-side table? Default: in-memory ring buffer of last 200 events; persistence is Sprint 40+ if needed.
2. **What's the granularity of the rate-limit log?** Per-session (current design) or per-pattern-match? T1's diag should expose both so T2 can see which pattern hit how often.
3. **If T2's hypothesis is wrong** (rcfile noise isn't the burner), what's the fallback diagnosis? T1's instrumentation should make this answerable — if PATTERNS.error matches are NOT the rate-limit burners, what is?

## Acceptance criteria

1. After T1 lands, `GET /api/flashback/diag` returns a structured log of the last 200 Flashback decisions in production. Joshua can trigger a real-shell error and see exactly which gate dropped the toast.
2. After T2 lands, the tightened PATTERNS.error regex matches zero false positives across a fixture corpus of 50+ captured zsh/bash startup transcripts.
3. After T3 lands, the project-tag write-path is documented and verified end-to-end. The mnestra-bridge RPC's project filter exactly matches the session's `meta.project`.
4. After T4 lands, **`tests/flashback-production-flow.test.js` fails on `git stash` (current state) and passes on the post-fix state.**
5. Joshua sees a Flashback toast in his actual daily flow within 24 hours of v0.10.1 install.

## Sprint contract

Append-only STATUS.md, lane discipline, no version bumps in lane.

## Dependencies on prior sprints

- Sprints 21, 33 made multiple Flashback fix attempts that passed e2e tests but missed production. Sprint 39 explicitly does NOT trust the existing e2e test — T4 ships a new test that exercises the production path.
- Sprint 38 substrate (memory_recall_graph, expand_memory_neighborhood) is unrelated; Flashback uses the existing vector recall path. T1's instrumentation should cover BOTH the legacy vector recall path (current Flashback) AND the new graph-recall path (when `rag.graphRecall: true` is set), so future Flashback-via-graph queries are also observable.
- Sprint 39 ships as `@jhizzard/termdeck@0.10.1` — no Mnestra or stack-installer bump needed unless T3's audit surfaces a server-side schema gap.
