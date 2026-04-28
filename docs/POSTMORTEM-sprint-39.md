# POSTMORTEM — Sprint 39 (Flashback Resurrection 2.0)

**Sprint shipped:** 2026-04-27 22:00 ET (commit `bfff819`, `v0.10.1`)
**Bug duration:** ~9 days (approximate Sprint 26 close 2026-04-18 → Sprint 39 close 2026-04-27)
**Bug class:** Server-emitted WebSocket message dropped silently by client
**Severity:** P0 user-facing — the headline product feature (Flashback toast on shell errors) was completely silent for the project's primary user across 9 days and 14 sprints.
**Author:** Sprint 39 overnight orchestrator (Claude Opus 4.7 1M)

## TL;DR

`packages/client/public/app.js` had no `case 'proactive_memory':` branch in either of its two `ws.onmessage` switches. The server-side WebSocket push of proactive_memory frames was working correctly end-to-end. Every emitted frame went into the void. The fallback path (`status_broadcast` polling for `meta.status === 'errored'`) only catches the ~10–50 ms errored window inside a 2000 ms broadcast cycle (~2.5% of broadcasts), so the client transitioned `active → idle` without ever invoking `triggerProactiveMemoryQuery`. The fix was 3 lines × 2 switch sites. The cause of the 9-day duration was the absence of any test that exercised the WS-emit-to-DOM-toast pipeline end-to-end.

## Timeline

- **Sprint 6 (2026-04-15):** Flashback feature shipped. Server emits `proactive_memory` WS frame on shell error → client renders toast. Working end-to-end on a fresh build.
- **Sprint 21 (2026-04-18, commit `a1e3f92`, `v0.4.3`):** First "Flashback fixed" claim. Last verified-working flashback per Joshua's memory entry. Lane added `[flashback]` diagnostic logging to `onErrorDetected` callback in `index.js` and error detector in `session.js`. Pipeline confirmed via 10 returned rows from Mnestra in T3's smoke probe. **Did not test the client-side toast render path.**
- **Sprint 26 (~2026-04-21):** Approximate point when Joshua's daily-flow Flashback toasts stopped firing. No specific commit identified as the trigger; likely a refactor in `app.js` or a regression in the `status_broadcast` polling path. The change was silent — no failing tests surfaced.
- **Sprint 33 (`6c46725`, `v0.7.1`):** Second "Flashback fixed" claim. Lane diagnosed analyzer-pattern false-negatives in `PATTERNS.error` and added `PATTERNS.shellError` to catch `cat: /foo: No such file or directory` shapes. Test `tests/flashback-e2e.test.js` shipped to assert the proactive_memory WS frame fires. **The test passed against a synthetic transcript that bypassed zsh/bash rcfile loading; it asserted on `proactiveMemoryFrame.memories[]` shape that never matched the production single-hit shape (`hit:` directly), so the assertion was structurally unreachable.**
- **Sprint 34 (`v0.7.2`, 2026-04-26):** Project-tag regression fix. Closed the rag.js writer chain bug. Joshua continued to report no flashback toasts.
- **Sprint 38 (`v0.10.0`, 2026-04-27 19:14 ET):** Knowledge graph + visualization. Mid-sprint, Joshua explicitly reported "I still have not seen a SINGLE FLASHBACK since they stopped appearing." Orchestrator timeline-locked the regression and queued Sprint 39 as the diagnostic-first follow-up.
- **Sprint 39 (`v0.10.1`, 2026-04-27 21:28 → 21:50 ET, 22 minutes):** **Smoking gun found.** Four parallel lanes ran:
  - **T1** instrumented six decision points in the Flashback pipeline + shipped `GET /api/flashback/diag`.
  - **T2** captured 8 zsh/bash startup transcripts, ran them through `PATTERNS.error`/`PATTERNS.shellError`, found **zero matches** in Joshua's actual zsh prod-spawn fingerprint — refuting the rcfile-noise hypothesis for his flow.
  - **T3** audited every project-tag write/read path, found the bridge filters faithfully, and confirmed corpus-side mis-tagging from Joshua's out-of-repo harness hook (290 of 1,237 chopin-nashville rows were actually termdeck/mnestra/rumen/podium/pvb/dor content).
  - **T4** wrote a production-flow e2e test that spawns real `/bin/zsh -i` + `/bin/bash`, sent the cat-trigger, and observed `proactive_memory` WS frames arrive in ~0.7–1.5 s. Server-side end-to-end pipeline confirmed working. T4's diagnostic captured `status_broadcast` frames and noted: **for both shells, every test run, the broadcasts sampled during the test window showed the session as idle or active, never errored.** Mapped the client architecture and found the smoking gun in `app.js:230` (no `case 'proactive_memory':`).

  Orchestrator-applied 3-line client hotfix at `app.js:237` + `app.js:1245`. Migration 011 applied to live petvetbid. Test suite went 335/336 → 391/388 (+56 net new tests, 0 new failures, previously-failing `project-bound flashback` now passes via assertion-shape correction).

## Root cause analysis

### The actual bug

`packages/client/public/app.js` ws.onmessage switch (line 230) handled five message types:
- `'output'`, `'meta'`, `'exit'`, `'status_broadcast'`, `'config_changed'`

It did NOT handle:
- `'proactive_memory'` — the type emitted by `index.js:885` on every successful Flashback Mnestra hit.

A reconnect-path handler at `app.js:1245` had the same gap PLUS was also missing `'config_changed'` (a smaller but related contract drift).

### Why the fallback path looked like it worked

The actually-functional client path was via polling `status_broadcast` frames for `meta.status === 'errored'`:

1. Server `_detectErrors` flips `meta.status = 'errored'` and immediately fires `onStatusChange(...,'errored')`.
2. Server `_updateStatus` flips status back to `'idle'` (default shell branch, line 271) on the next prompt chunk; the field is written immediately, only the *callback* for that transition is debounced 3 s.
3. `index.js:1740` periodic `setInterval(..., 2000)` emits `{ type: 'status_broadcast', sessions: allMeta }`.
4. Client `updateGlobalStats` calls `updatePanelMeta(s.id, s.meta)` per session.
5. `updatePanelMeta` checks `meta.status !== entry.lastKnownStatus`, and on transition to `'errored'` calls `triggerProactiveMemoryQuery(id)`.
6. `triggerProactiveMemoryQuery(id)` POSTs `/api/ai/query` and renders a toast via `showProactiveToast`.

The race: `errored` is live in `meta.status` for ~10–50 ms inside a 2000 ms broadcast cycle. The broadcast catches `'errored'` ~2.5 % of the time. The other ~97 % of broadcasts catch the post-flip `'idle'` state, lastKnownStatus on the client jumps directly from `'active'` to `'idle'` without ever passing through `'errored'`, and `triggerProactiveMemoryQuery` is never invoked.

Earlier in TermDeck's life this fallback DID work consistently — likely because the `_updateStatus` flip-back-to-idle didn't exist or had different timing. A refactor at some point post-Sprint-21 changed the timing such that the race became unwinnable, and there was no test to catch it.

### Why prior fixes missed

- **Sprint 21's diagnostic logging** confirmed the server-side pipeline (10 rows returned from Mnestra). It did not exercise the client toast render path.
- **Sprint 33's PATTERNS.shellError extension** correctly broadened error detection. The accompanying e2e test asserted on `proactiveMemoryFrame.memories[]` — but the production emit shape was `{ type: 'proactive_memory', hit: <single-memory> }`. The assertion was structurally unreachable; the test was always going to pass-or-skip regardless of whether the toast ever rendered.
- **Sprint 34's project-tag regression fix** closed an orthogonal write-path bug. Joshua had no toasts for unrelated reasons; the fix didn't cause it but didn't surface the actual cause either.
- **No sprint added a test that exercised the WS-emit-to-DOM-toast pipeline end-to-end.** The closest test (`flashback-e2e.test.js`) opened a WebSocket and observed the frame, but its assertion never validated the frame's actual shape, and it certainly didn't validate the DOM-render side of the contract. The only path that would have caught the bug was: integration test that opens the dashboard in a headless browser, triggers an error, and asserts a toast appears in the DOM.

### Why Sprint 39 succeeded

Sprint 39 was deliberately **diagnostic-first**. The four lanes did not converge on a single hypothesis at planning time. Instead:
- T1 built observability so the actual production-flow rejection point would be visible.
- T2 + T3 worked the two strongest pre-articulated hypotheses (rcfile noise burning rate limit; project-tag mismatch).
- T4 wrote a NEW e2e test that exercised the production path in a way the existing e2e didn't.

When T2 + T3 both REFUTED their hypotheses (rcfile-noise had 0 hits on Joshua's zsh; bridge passes project tag faithfully), the converging evidence pushed the search downstream of the analyzer and bridge — into the WS push path. T4's test confirmed the WS push works server-side, then mapped the client architecture and surfaced the missing switch case.

The pattern: **when N parallel investigations REFUTE their hypotheses, the answer lies outside the originally-articulated hypothesis space.** Sprint 39's 22-minute wall-clock was possible because diagnostic-first scope made it cheap to learn "hypothesis X is wrong" — that's a positive result, not a wasted lane.

## Lessons learned

### 1. WS message contract drift is a recurring class

The server emits 6 message types (`output`, `meta`, `exit`, `proactive_memory`, `status_broadcast`, `config_changed`). The client has 2 switches that together must handle all 6. A 6 × 2 = 12-cell matrix where one missing cell silently breaks the user-facing feature.

**Sprint 40 T1 mitigation:** `tests/ws-handler-contract.test.js` statically scans both sides and fails CI if any cell is empty (or undocumented in the `ALLOWED_OMISSIONS` map). The test would have caught Sprint 39's bug on first CI run after the gap was introduced.

### 2. E2E tests must validate the actual production frame shape

Sprint 33's `flashback-e2e.test.js:526` asserted on `proactiveMemoryFrame.memories[]`. The production frame emits `{ type: 'proactive_memory', hit: <single-memory> }`. The assertion was structurally unreachable. Tests that pass for the wrong reason are worse than tests that fail.

**Sprint 39 orchestrator-applied fix:** corrected the assertion at `flashback-e2e.test.js:466-501` to match the actual single-hit shape. The previously-failing `project-bound flashback` test now passes — and would now actually fail if the frame shape were broken.

### 3. Polling fallbacks are inherently racy

The `status_broadcast` polling path was designed as a redundant signal alongside the WS push. When the WS push silently broke, the fallback was the only path — and the race math (~10–50 ms / 2000 ms = ~2.5%) made it unreliable. **Defense-in-depth is good; relying on the defense alone is not.**

### 4. Out-of-repo dependencies need explicit ownership

T3 traced the chopin-nashville mis-tagging to `~/.claude/hooks/memory-session-end.js` — Joshua's harness hook outside the TermDeck repo. The lane brief explicitly excluded touching it; orchestrator surfaced it as a hand-off action. **Forward-fixes that live outside the repo can be queued but not closed by sprint orchestration.** The harness hook PROJECT_MAP forward-fix is on Joshua's morning checklist.

### 5. Diagnostic-first sprints are cheap

Sprint 39's hypothesis budget was deliberately wide: T2 owned rcfile-noise, T3 owned project-tag mismatch, T1 owned observability for whatever T2 + T3 missed, T4 owned producing the actual smoking-gun signal. Two of the four hypotheses were refuted within the lane; that's a feature, not a failure. Total wall-clock to "we know exactly what broke and why" was 22 minutes.

## Sprint 40 changes (this sprint)

In response to the lessons above, Sprint 40 ships:

1. **`tests/ws-handler-contract.test.js`** (T1) — static contract test that asserts every server-emitted WS type has a handler in every `ws.onmessage` switch, plus a parity guard that catches drift between the two switches.
2. **Reconnect WS handler `case 'config_changed':` parity fix** (T1) — closed the second contract gap surfaced by the new test.
3. **PATTERNS.error broadening** (T2) — added uppercase `ERROR:`, mixed-case `Fatal`, Node errno colon shapes (`ENOENT:` / `EACCES:` / `ECONNREFUSED:`), HTTP 5xx server-log shape, and `npm ERR!` token to the analyzer. All 3 pre-existing case-sensitivity gaps in `packages/server/tests/session.test.js` close (32/35 → 35/35).
4. **`docs/POSTMORTEM-sprint-39.md`** (this file, T4).
5. **`docs/WS-MESSAGE-CONTRACT.md`** (T4) — the source-of-truth for the WS message types, emit sites, handler sites, and how to add a new type without breaking the contract.

## What is NOT in Sprint 40 (deferred)

- **Server-side `onStatusChange` per-session meta push** (defense-in-depth alongside the client handler — could ship in Sprint 41).
- **Dashboard `/api/flashback/diag` UI surface** (T1 ring buffer is curl-only; rendering it in the dashboard's Memory pane is queued for Sprint 41 since UI work needs browser verification).
- **LLM-classification backfill for the ~876 chopin-nashville "other/uncertain" rows** that migration 011 deliberately left untouched.
- **Sprint 38 follow-up: graph-inference SQL rewrite (LATERAL + HNSW)** — pre-existing, deferred because the 5,500-row pairwise self-join times out before the 150 s Edge Function wall-clock.

## Cross-references

- Sprint 39 lane STATUS.md (full per-lane FINDING / FIX-PROPOSED / DONE entries): [`docs/sprint-39-flashback-resurrection/STATUS.md`](sprint-39-flashback-resurrection/STATUS.md)
- Sprint 39 close commit: `bfff819` (36 files, 2,652 insertions).
- Sprint 40 close commit: see CHANGELOG `[0.10.2]` entry once committed.
- WS message contract: [`docs/WS-MESSAGE-CONTRACT.md`](WS-MESSAGE-CONTRACT.md)
- Migration applied to live `petvetbid`: `packages/server/src/setup/mnestra-migrations/011_project_tag_backfill.sql`
- Morning restart-prompt covering Joshua's hand-off actions: [`docs/RESTART-PROMPT-2026-04-28-morning.md`](RESTART-PROMPT-2026-04-28-morning.md)
