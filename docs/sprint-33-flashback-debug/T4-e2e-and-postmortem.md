# T4 — End-to-end probe + POSTMORTEM

You are Terminal 4 in Sprint 33 / Flashback debug. Your lane is the integrating one: run the existing e2e test against current code + a live Mnestra, watch what fails (or succeeds), and write the converged narrative as `POSTMORTEM.md` once T1/T2/T3 post their findings.

## Read first
1. `docs/sprint-33-flashback-debug/PLANNING.md` — sprint overview
2. `docs/sprint-33-flashback-debug/STATUS.md` — your trigger condition is "T1, T2, T3 all posted FINDING or DONE"
3. `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. `tests/flashback-e2e.test.js` — the e2e test that exercises the full pipeline
5. `tests/failure-injection.test.js` — adjacent suite, gives you the live-server pattern

## You own
- `tests/flashback-e2e.test.js` — run it, debug it, extend it with regression coverage for whatever T1/T2/T3 find
- NEW `docs/sprint-33-flashback-debug/POSTMORTEM.md` — the converged diagnosis document

## You do NOT touch
- All T1/T2/T3 source files (session.js, rag.js, mnestra-bridge, index.js, anything in ~/Documents/Graciella/engram/, preflight.js)

## Phase A — start immediately

1. **Run `tests/flashback-e2e.test.js`** against current code. The test spawns a local TermDeck and probes the full pipeline. Does it pass? Capture the output verbatim. If it fails, capture which assertion fails and at which step (PTY input, status-flip, bridge call, WS frame received).
2. **Run it against the live TermDeck Josh is using** if the test supports an external server (read the test — some bypass server-spawn via env var). Does the same test pass against `http://127.0.0.1:3000`? If not, the test-suite-Mnestra differs from production-Mnestra in a way the test misses.
3. **Manual live probe.** While the four-panel TermDeck is running, open a fifth panel (or use one of the existing ones), do something that should trigger an error with high likelihood of similar past memory:
   ```
   $ psql "postgres://bad@invalid:5432/none" -c 'select 1'   # or similar
   ```
   Watch the panel for a Flashback toast. Capture: did it fire? If yes, what content? If no, did the panel even flip to 'errored' status (check the metadata overlay)?
4. **Browser dev tools** during the manual probe: open the TermDeck dashboard, F12 → Network → WS connection. Filter for `proactive_memory` frames. Did one arrive? Empty corpus / threshold rejection / never-emitted are three different shapes here.

## Phase B — after T1/T2/T3 post FINDING

5. **Synthesize.** Read each Tn's STATUS.md entries. Write `POSTMORTEM.md` with:
   ```
   # Flashback silence — postmortem
   
   ## What was reported
   <Josh's quote, dates>
   
   ## What was found
   T1 (analyzer): <CONFIRMED-OK | BROKEN-AT X>
   T2 (bridge):   <...>
   T3 (mnestra):  <...>
   T4 (e2e):      <test pass/fail, manual probe result>
   
   ## Root cause
   <single-paragraph diagnosis. If multiple converging causes, name the dominant one and the contributing factors.>
   
   ## Fix (if shipped)
   <commit ref, files touched, regression test added>
   
   ## Why it stayed silent (if surfaced now after a v0.4.5 fix)
   <what changed between v0.4.5 and now that re-broke it, OR what gap the v0.4.5 fix didn't cover>
   
   ## Regression defense
   <what test ensures this can't go silent again — likely an extension to flashback-e2e.test.js>
   ```
6. **If a fix was shipped by T1/T2/T3**, add a regression test to `flashback-e2e.test.js` that would have caught this specific failure mode. Run the full test file, confirm it passes (and the new test covers the regression).

## Output

- `FINDING — phase A: <e2e test result, manual probe result>` early in the sprint.
- `READY` once POSTMORTEM.md is written and any regression test you wrote is green.
- Do NOT bump versions, do NOT touch CHANGELOG.md, do NOT commit. The orchestrator decides whether this becomes v0.7.1 or feeds Sprint 34.

## Reference memories
- `memory_recall("flashback e2e test pollUntil websocket race")` — past test-suite race condition
- `memory_recall("flashback regression silent for 15 sprints")` — Sprint 21 narrative; the lesson is "don't trust test pass without a real-corpus probe"
