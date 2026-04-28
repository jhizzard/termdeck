# Sprint 39 — T4: Production-flow Flashback e2e test

**Lane goal:** Build the e2e test that should be failing today (catches the regression) and that passes after T1+T2+T3 land. The existing `tests/flashback-e2e.test.js` passes against a synthetic transcript and has done so since Sprint 21+. Joshua's daily-flow toasts haven't fired since ~Sprint 26. Two prior fix attempts (Sprint 21 + Sprint 33) shipped against the existing e2e test — both passed it, both missed the production regression. T4 ships a new test that **fails on `git stash` (current state)** and **passes after the rest of the sprint lands**.

**Target deliverable:**
1. NEW `tests/flashback-production-flow.test.js` — drives a real interactive zsh/bash subprocess (with rcfile loading) through TermDeck's session machinery and asserts the proactive_memory WS frame fires with non-empty memories within 5 seconds.
2. Test FAILS on the current `git stash`-baseline. Documented baseline-failure-on-purpose flag in the test description.
3. Test PASSES after T2's PATTERNS.error tightening AND/OR T3's project-tag fix lands (depending on which hypothesis turns out to be the root cause).

## Why this lane exists

`tests/flashback-e2e.test.js` (the synthetic-transcript version) uses a controlled input stream that bypasses zsh/bash rcfile loading. The harness pumps a known-error string into a session that already has memories pre-seeded with the matching project tag. That isolates the WS frame round-trip but **misses every production-flow concern**:

- rcfile noise that pre-burns the rate limiter (T2's hypothesis)
- project-tag resolution mismatches between session creation and bridge query (T3's hypothesis)
- WS open/close timing in real browser sessions
- whatever-else hypotheses haven't been articulated yet

T4's new test exercises ALL of these. It's the test that was missing for ~9 days of regression silence.

## Test design

```js
// tests/flashback-production-flow.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const WebSocket = require('ws');

test('production-flow flashback: real zsh + rcfile + cat error → toast', async () => {
  // 1. Boot TermDeck server in test mode, grab WS URL + session create endpoint.
  const server = await startTestServer();

  // 2. Pre-seed Mnestra (or the bridge fixture) with 5 termdeck-tagged memories
  //    that should match the error text "cat /nonexistent/file".
  await seedMemories({
    project: 'termdeck',
    content: ['cat-fails-with-no-such-file', 'enoent-on-cat', /* ... */],
  });

  // 3. Create a TermDeck session that spawns /bin/zsh -i (interactive, loads rcfiles).
  const session = await createSession(server, {
    command: '/bin/zsh',
    args: ['-i'],
    env: { ...process.env, TERM: 'xterm-256color' },
    meta: { project: 'termdeck' },
  });

  // 4. Open a WebSocket client subscribed to the session's frames.
  const ws = await connectWS(server, session.id);
  const proactiveFrames = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'proactive_memory') proactiveFrames.push(msg);
  });

  // 5. Wait for the prompt (~1-2s after rcfile load).
  await waitForPrompt(session, '~ ');

  // 6. Inject the trigger error.
  await sendInput(server, session.id, 'cat /nonexistent/file/path\n');

  // 7. Wait up to 5 seconds for a proactive_memory frame.
  await pollUntil(() => proactiveFrames.length > 0, { timeout: 5000 });

  // 8. Assert the frame contains non-empty memories with project='termdeck'.
  assert.ok(proactiveFrames.length >= 1, 'expected at least one proactive_memory frame');
  const frame = proactiveFrames[proactiveFrames.length - 1];
  assert.ok(frame.memories?.length > 0, 'frame.memories is empty');
  assert.ok(
    frame.memories.every(m => m.project === 'termdeck' || m.project === null),
    'frame.memories contains foreign project tags'
  );

  // 9. Cross-check against /api/flashback/diag (T1's instrumentation):
  //    — confirm `pattern_match` fired on the cat error line, NOT on rcfile noise.
  //    — confirm `bridge_query` fired with `project_tag_in_filter='termdeck'`.
  //    — confirm `bridge_result` returned >0 memories with `top_3_project_tags=['termdeck',...]`.
  //    — confirm `proactive_memory_emit` outcome === 'emitted', not 'dropped_*'.
  const diag = await fetchDiag(server, { sessionId: session.id });
  const events = diag.events;
  const matches = events.filter(e => e.event === 'pattern_match');
  const errorLineMatches = matches.filter(m => /cat\s+\/nonexistent/.test(m.matched_line));
  assert.ok(errorLineMatches.length >= 1, 'pattern_match did not fire on the cat error');
  // ...

  await server.close();
});
```

## Baseline-failure flag

Document explicitly that this test is **expected to fail on current main** until T2 + T3 ship. Add a comment at the top:

```js
// SPRINT 39 BASELINE: this test fails on git stash baseline (current main as of
// 2026-04-27). The failure mode is the proactive_memory frame being empty (matching
// the pattern from tests/flashback-e2e.test.js:526). T2 (rcfile noise) and T3
// (project-tag mismatch) are the candidate root causes; this test should pass
// once whichever is correct (or both) lands. Do NOT skip this test — its failure
// IS the regression signal.
```

If both T2 and T3 ship and this test still fails, the actual root cause is a third hypothesis we haven't articulated. T1's diag log gives the data to find it.

## Test fixtures

NEW `tests/fixtures/flashback-production-flow/`:
- Pre-seeded memory snapshots (5+ termdeck-tagged rows matching `cat /nonexistent` patterns).
- Optional: a pre-captured zsh rcfile noise transcript (so the test doesn't depend on the runner's actual zsh config — make it deterministic).

## Primary files

- NEW `tests/flashback-production-flow.test.js` — the lane's headline deliverable.
- NEW `tests/fixtures/flashback-production-flow/` — fixture data (memory snapshots, optional zsh transcript).
- `tests/flashback-e2e.test.js` — REFACTOR ONLY: extract any shared helpers (createSession, fetchDiag, pollUntil) into `tests/_flashback-helpers.js` so the production-flow test reuses them. Don't change the existing tests' assertions.

## Coordination notes

- **T1 (instrumentation)** must ship before T4 can fully validate. T4's diag-cross-check assertions (step 9 above) depend on T1's `/api/flashback/diag` route. If T1 lands first (most likely), T4 wires to it directly. If T1 is slow, T4 can ship with diag assertions stubbed-out and add them in a follow-up.
- **T2 (rcfile audit)** ships the tightened patterns. T4's test triggers a real shell error that should match T2's tightened patterns. If T4 stops triggering, T2 over-tightened.
- **T3 (project-tag verification)** ships the project-tag fix (if the hypothesis holds). T4's `frame.memories` assertion depends on T3's filter-correctness work.

## Test plan

- Unit (helper functions only): pollUntil, fetchDiag, seedMemories shape assertions.
- Integration: this lane's headline test IS the integration test. Run it on `git stash` baseline → fail. Run it on post-T2+T3 working tree → pass.
- CI considerations: this test spawns a real zsh subprocess, so it requires zsh to be present on the runner. Skip with `process.platform === 'darwin' && !fs.existsSync('/bin/zsh')`-style guards if the CI environment lacks it. Joshua's box has zsh; Brad's likely-Linux box has bash, so add a bash variant of the test for parity.

## Out of scope

- Don't fix the regression itself — T2 + T3 own that.
- Don't add the diag instrumentation — T1 owns that.
- Don't backfill historical mis-tagged memories — separate data-cleanup sprint.
- Don't replace the existing `tests/flashback-e2e.test.js` — it stays as a faster smoke test for the synthetic path.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-39-flashback-resurrection/STATUS.md` under `## T4`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
