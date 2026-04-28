'use strict';

// Production-flow Flashback e2e (Sprint 39 T4).
//
// SPRINT 39 BASELINE: this test is expected to FAIL on the git-stash baseline
// (HEAD = 876ecae, "v0.10.0 + sprint-39 docs", as of 2026-04-27 evening). The
// failure mode is the same one Joshua has been hitting in his daily flow for
// ~9 days: a real interactive shell is spawned, its rcfile noise is fed through
// the analyzer, and either:
//
//   (a) PATTERNS.error matches an rcfile-noise line, burning the per-session
//       30s rate limit before the user's `cat /nonexistent/file/path` ever
//       fires onErrorDetected. No bridge call → no proactive_memory frame.
//       (T2's strong hypothesis.)
//   (b) The bridge IS queried but with a project tag that doesn't match the
//       termdeck-tagged corpus, so it returns zero memories or chopin-nashville-
//       polluted memories. (T3's hypothesis.)
//
// Both could be true. T1's /api/flashback/diag log makes the actual rejection
// point visible — every gate writes a structured event, and this test cross-
// checks the log post-trigger to print exactly which decision dropped the
// toast. When this test fails, read the diag dump in the test diagnostic
// output to know which lane fixed (or didn't fix) what.
//
// DO NOT skip this test — its failure IS the regression signal. The two
// existing tests in flashback-e2e.test.js cover the SYNTHETIC path (canned
// PTY output, no rcfile loading) and have been passing for sprints while
// production stayed silent. This test exercises the path the user actually
// hits.
//
// Run: node --test tests/flashback-production-flow.test.js
// Requires: a running TermDeck server with Mnestra reachable and at least one
// termdeck-tagged memory in the corpus.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const {
  BASE_URL,
  EVENT_POLL_INTERVAL_MS,
  sleep,
  fetchWithTimeout,
  pollUntil,
  probeServer,
  preflightProbeProject,
  createSession,
  deleteSession,
  sendInput,
  attachWS,
  fetchDiag,
} = require('./_flashback-helpers');

const PROJECT = 'termdeck';
// Question used to confirm corpus has termdeck-tagged content. Worded to
// match the kind of memory that would surface when the user hits the cat
// trigger in their daily flow.
const PROBE_QUESTION = 'shell error cat no such file or directory';
// Trigger string sent into the PTY. Same as the existing flashback-e2e test
// uses, so any divergence in behavior between the synthetic and production
// flows is attributable to the harness (rcfile loading, real shell init),
// not to a different trigger surface.
const TRIGGER_TEXT = 'cat /nonexistent/file/path\n';
// Time to let the shell load its rcfile + emit prompt before sending the
// trigger. 2.5s is enough to flush every reasonable .zshrc/.bashrc through
// the analyzer (Joshua's typical .zshrc loads in <500ms, even with many
// plugins). Critical: this is the window in which PATTERNS.error CAN match
// rcfile noise and burn the rate limiter — the production-flow concern.
const RCFILE_SETTLE_MS = 2500;
// Budget for the proactive_memory frame to arrive after the trigger fires.
// Includes: PTY echo (<10ms) + analyzer chunk processing (<50ms) + bridge
// query round-trip (typical 400-700ms direct mode, P99 ~2-3s) + WS send
// (<10ms). 5s per the brief.
const FRAME_BUDGET_MS = 5000;

let skipAll = false;
let skipReason = '';
const cleanupSet = new Set();

before(async () => {
  const probe = await probeServer();
  if (probe.skip) {
    skipAll = true;
    skipReason = probe.reason;
  }
});

after(async () => {
  for (const id of cleanupSet) {
    await deleteSession(id);
  }
});

// Look at the captured transcript chunks for any line that PATTERNS.error
// (or shellError) WOULD match. If we find one, that's the rcfile noise that
// burns the rate limiter — diagnostic gold. We mirror the regex from
// session.js exactly so the test's view of "what would fire" matches the
// server's view at runtime.
const PATTERNS_ERROR = /(?:^|\n)\s*(?:Error:\s+\S|error:\s+\S|Traceback \(most recent call last\):|npm ERR!|error\[E\d+\]:|Uncaught Exception|Fatal:)/m;
const PATTERNS_SHELL_ERROR = /(?:^|\n)(?:[^\n]*:\s+(?:.*?:\s+)?(?:No such file or directory|Permission denied|Is a directory|Not a directory|command not found)\b|[^\n]*?\(\d+\)\s+Could not resolve host\b|\s*ModuleNotFoundError:\s+\S|\s*Segmentation fault\b|\s*fatal:\s+\S)/m;
function findRcfileNoiseMatches(text) {
  const matches = [];
  const errMatch = text.match(PATTERNS_ERROR);
  if (errMatch) matches.push({ pattern: 'PATTERNS.error', sample: errMatch[0].slice(0, 160) });
  const shellMatch = text.match(PATTERNS_SHELL_ERROR);
  if (shellMatch) matches.push({ pattern: 'PATTERNS.shellError', sample: shellMatch[0].slice(0, 160) });
  return matches;
}

// Pull transcript bytes for this session. Returns the concatenated text or
// '' on any failure. Diagnostic-only — never throws.
async function fetchTranscript(sessionId) {
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/transcripts/${sessionId}`);
    if (!res.ok) return '';
    const body = await res.json();
    return (body?.chunks || []).map((c) => c.data || '').join('');
  } catch {
    return '';
  }
}

// Run one production-flow probe: real interactive shell + rcfile + cat
// trigger + WS frame assertion. `shellName` selects which interpreter to
// spawn ('zsh' or 'bash' — both are PLAIN_SHELLS in spawnTerminalSession,
// so they get spawned interactively with no -c wrapper).
async function runProductionFlowCase(t, { shellName, shellPath }) {
  if (skipAll) return t.skip(skipReason);
  if (!fs.existsSync(shellPath)) {
    return t.skip(`${shellPath} not present on this runner`);
  }

  // Pre-flight: the test only proves anything if there's at least one
  // termdeck-tagged memory in the corpus to surface. Without it, the
  // bridge will correctly return zero hits and the assertion would fail
  // for a non-regression reason.
  const corpusCount = await preflightProbeProject(PROBE_QUESTION, PROJECT);
  if (corpusCount === null) {
    return t.skip('mnestra bridge probe failed — cannot confirm corpus state');
  }
  if (corpusCount === 0) {
    return t.skip(
      `corpus has zero memories tagged project="${PROJECT}" matching "${PROBE_QUESTION}" — ` +
      `needs-backfill: run Sprint 39 T3's 011_project_tag_backfill.sql to reclassify ` +
      `mis-tagged chopin-nashville rows before this assertion can be exercised.`
    );
  }
  t.diagnostic(`preflight: ${corpusCount} ${PROJECT}-tagged memories matched "${PROBE_QUESTION}"`);

  const startTs = Date.now();
  const ms = () => Date.now() - startTs;

  // 1. Spawn an interactive shell session bound to the termdeck project.
  //    spawnTerminalSession sees command='zsh' or 'bash' as a plain shell
  //    and invokes pty.spawn(shellName, []) with stdin = PTY (a TTY),
  //    which makes the shell enter interactive mode and load its rcfile.
  const session = await createSession({
    command: shellName,
    project: PROJECT,
    label: `flashback-production-flow-${shellName}`,
  }, cleanupSet);
  t.diagnostic(`[T4] session created at ${ms()}ms id=${session.id} project=${session.meta?.project}`);

  if (session.meta?.status === 'errored') {
    return t.skip(`${shellName} session failed to spawn: ${session.meta.statusDetail || 'unknown'}`);
  }
  assert.equal(
    session.meta?.project, PROJECT,
    `created session must echo project='${PROJECT}'; got ${JSON.stringify(session.meta?.project)}. ` +
    `If null, the API is dropping the project field on session-create.`
  );

  // 2. Attach WS BEFORE sending input so server-side session.ws is set
  //    and any proactive_memory frame the bridge emits can reach us.
  const wsHandle = attachWS(session.id);
  const opened = await wsHandle.opened;
  if (!opened) return t.skip('WebSocket failed to open — cannot observe proactive_memory frame');
  t.diagnostic(`[T4] ws open at ${ms()}ms`);

  // 3. Let the shell load its rcfile and emit the prompt. THIS is the
  //    window the production-flow regression lives in: any rcfile output
  //    that matches PATTERNS.error fires _detectErrors (writes a
  //    pattern_match diag event, sets _lastErrorFireAt, and burns the
  //    30s rate limit). When the cat trigger arrives 2.5s later, it gets
  //    rate-limited → no bridge call → no proactive_memory frame. That's
  //    the production silence Joshua has been seeing for ~9 days.
  await sleep(RCFILE_SETTLE_MS);

  // 4. Capture the transcript before the trigger so we can SEE whether
  //    rcfile noise contained any PATTERNS.error-matching lines. This is
  //    the smoking-gun diagnostic — when the test fails on the baseline,
  //    the rcfile noise dump tells the reader (and T2) exactly which
  //    line burned the limiter.
  const preTriggerTranscript = await fetchTranscript(session.id);
  const rcfileNoise = findRcfileNoiseMatches(preTriggerTranscript);
  t.diagnostic(
    `[T4] pre-trigger transcript: ${preTriggerTranscript.length} bytes, ` +
    `${rcfileNoise.length} PATTERNS.error/shellError match(es)`
  );
  for (const m of rcfileNoise) {
    t.diagnostic(`  rcfile noise: ${m.pattern} matched ${JSON.stringify(m.sample)}`);
  }

  // 5. Inject the canonical Unix shell error.
  await sendInput(session.id, TRIGGER_TEXT);
  t.diagnostic(`[T4] trigger sent at ${ms()}ms (${JSON.stringify(TRIGGER_TEXT.trim())})`);

  // 6. Poll the WS frame collector for a proactive_memory frame. The bridge
  //    runs async after rag_events writes, so give it the full budget.
  const hitFrame = await pollUntil(() => {
    const hits = wsHandle.getProactiveHits();
    return hits.length > 0 ? hits[hits.length - 1] : null;
  }, { timeoutMs: FRAME_BUDGET_MS, intervalMs: EVENT_POLL_INTERVAL_MS });

  // 6.5. Observability for the status_broadcast race (the likely actual
  //      production-flow regression). The client at app.js:2434+ depends on
  //      status_broadcast frames carrying this session with status='errored'
  //      to fire triggerProactiveMemoryQuery. status_broadcast is polled
  //      every 2s server-side; the analyzer flips status off 'errored' to
  //      'idle' within ~10-50ms of the next bash/zsh prompt chunk. So the
  //      client-pull path almost always misses the errored window.
  //      Diagnostic only — proves whether the race is in play this run.
  const broadcasts = wsHandle.frames.filter((f) => f && f.type === 'status_broadcast');
  const erroredBroadcasts = broadcasts.filter((f) =>
    Array.isArray(f.sessions) && f.sessions.some((s) => s.id === session.id && s.meta?.status === 'errored')
  );
  t.diagnostic(
    `[T4] status_broadcast frames captured: ${broadcasts.length}; ` +
    `frames showing this session as 'errored': ${erroredBroadcasts.length} ` +
    `(if 0/${broadcasts.length}, the client-pull flashback path is losing the 2s-vs-50ms race — Sprint 39 hypothesis)`
  );

  // 7. Diag cross-check (T1 dependency). If /api/flashback/diag returns
  //    non-JSON, the server is pre-T1-restart — log a stub diagnostic and
  //    skip these assertions. Otherwise, dump per-event-type counts and
  //    samples so the failure mode is observable in test output.
  const diag = await fetchDiag({ sessionId: session.id, limit: 200 });
  const events = diag?.events || [];
  if (!diag) {
    t.diagnostic('[T4] /api/flashback/diag unavailable — server is pre-T1-restart. Skipping diag-cross-check assertions.');
  } else {
    const byType = events.reduce((acc, e) => {
      acc[e.event] = (acc[e.event] || 0) + 1;
      return acc;
    }, {});
    t.diagnostic(`[T4] diag events for session: ${events.length} total, by-type=${JSON.stringify(byType)}`);
    const sample = (type, n = 3) =>
      events.filter((e) => e.event === type).slice(-n);
    for (const e of sample('pattern_match')) {
      t.diagnostic(`  pattern_match: pattern=${e.pattern} matched=${JSON.stringify((e.matched_line || '').slice(0, 120))}`);
    }
    for (const e of sample('rate_limit_blocked')) {
      t.diagnostic(`  rate_limit_blocked: ${e.rate_limit_remaining_ms}ms left in window`);
    }
    for (const e of sample('bridge_query')) {
      t.diagnostic(`  bridge_query: project_tag_in_filter=${JSON.stringify(e.project_tag_in_filter)} mode=${e.mode} duration_ms=${e.duration_ms}`);
    }
    for (const e of sample('bridge_result')) {
      t.diagnostic(`  bridge_result: count=${e.result_count} top3=${JSON.stringify(e.top_3_project_tags)}${e.error_message ? ` error=${e.error_message}` : ''}`);
    }
    for (const e of sample('proactive_memory_emit')) {
      t.diagnostic(`  proactive_memory_emit: outcome=${e.outcome} ws_ready_state=${e.ws_ready_state} frame_size=${e.frame_size_bytes}`);
    }
  }

  // 8. The headline assertion: a proactive_memory frame fired within budget.
  //    Failure here means one of:
  //      • rcfile noise burned the rate limiter (check rcfileNoise above
  //        and rate_limit_blocked count in diag dump)
  //      • bridge query returned zero matches (check bridge_result.count;
  //        if zero with project_tag_in_filter='termdeck' and corpus probe
  //        confirmed >0, T3's project-tag mismatch hypothesis is in play)
  //      • bridge query errored (check bridge_result.error_message)
  //      • WS not open at emit time (check proactive_memory_emit.outcome)
  //      • some other gate we haven't articulated — diag log will name it
  assert.ok(
    hitFrame,
    `no proactive_memory frame received within ${FRAME_BUDGET_MS}ms after trigger ` +
    `for ${shellName} session ${session.id} (project=${PROJECT}). ` +
    `Pre-trigger rcfile noise matches: ${rcfileNoise.length}. ` +
    `${diag ? `Diag events captured: ${events.length}.` : 'Diag endpoint unavailable.'} ` +
    `See test diagnostics above for the full timeline.`
  );

  // 9. Frame shape: production emits { type: 'proactive_memory', hit: <single memory> }
  //    where `hit` is index.js:865's `(result.memories || [])[0]` — i.e. ONE
  //    memory object with content/source_type/project/similarity/created_at.
  //    NOT a wrapper carrying a `.memories[]` array. (Confirmed against
  //    packages/server/src/index.js:872 as of HEAD 876ecae.)
  assert.ok(hitFrame.hit, 'proactive_memory frame must carry a `hit` field (single memory)');
  assert.ok(
    typeof hitFrame.hit.content === 'string' && hitFrame.hit.content.length > 0,
    'hit.content must be a non-empty string'
  );

  // 10. Project filter: a session created with project='termdeck' must
  //     surface only termdeck-tagged or null-tagged content. A non-null,
  //     non-termdeck tag (most likely 'chopin-nashville', given the
  //     1090-of-1139-row mis-tagging Sprint 35/36 left behind) is the
  //     T3-hypothesis regression.
  const hitProject = hitFrame.hit.project;
  assert.ok(
    hitProject == null || hitProject === PROJECT,
    `hit.project must be ${JSON.stringify(PROJECT)} or null; got ${JSON.stringify(hitProject)}. ` +
    `If 'chopin-nashville', the writer-side mis-tagging documented in Sprint 35/36 ` +
    `is leaking into Flashback queries — Sprint 39 T3 backfill not applied yet.`
  );

  // 11. Diag-cross-check assertions (skip when /api/flashback/diag isn't
  //     wired yet on the live server — see step 7). These narrow the
  //     failure to a specific gate when the test does fail and confirm
  //     the happy path was exercised end-to-end when it passes.
  if (diag) {
    const patternMatches = events.filter((e) => e.event === 'pattern_match');
    const errorLineMatches = patternMatches.filter(
      (e) => /cat[\s:]/.test(e.matched_line || '') || /No such file or directory/.test(e.matched_line || '')
    );
    assert.ok(
      errorLineMatches.length >= 1,
      `pattern_match did not fire on the ${TRIGGER_TEXT.trim()} error line. ` +
      `Total pattern_match events for session: ${patternMatches.length}. ` +
      `If 0, the analyzer never saw the cat error in the PTY chunk window. ` +
      `If >0 but none mention 'cat'/'No such file', PATTERNS over-fired on rcfile noise.`
    );

    const bridgeQueries = events.filter((e) => e.event === 'bridge_query');
    const termdeckQueries = bridgeQueries.filter((e) => e.project_tag_in_filter === PROJECT);
    assert.ok(
      termdeckQueries.length >= 1,
      `no bridge_query fired with project_tag_in_filter='${PROJECT}'. ` +
      `bridge_query count: ${bridgeQueries.length}. ` +
      `If >0 but none had project='${PROJECT}', the writer is dropping the project ` +
      `field between session-create and bridge.queryMnestra — Sprint 39 T3 territory.`
    );

    const emits = events.filter((e) => e.event === 'proactive_memory_emit');
    const emitted = emits.filter((e) => e.outcome === 'emitted');
    assert.ok(
      emitted.length >= 1,
      `no proactive_memory_emit event with outcome='emitted'. ` +
      `Outcomes seen: ${JSON.stringify(emits.map((e) => e.outcome))}. ` +
      `'dropped_empty' = bridge returned zero hits (T3 territory). ` +
      `'dropped_no_ws' = WS closed before emit (timing issue). ` +
      `'error' = WS send threw.`
    );
  }

  wsHandle.close();
}

test('production-flow flashback (zsh): real /bin/zsh -i + rcfile + cat error → toast within 5s', async (t) => {
  await runProductionFlowCase(t, { shellName: 'zsh', shellPath: '/bin/zsh' });
});

test('production-flow flashback (bash): real /bin/bash + rcfile + cat error → toast within 5s', async (t) => {
  await runProductionFlowCase(t, { shellName: 'bash', shellPath: '/bin/bash' });
});
