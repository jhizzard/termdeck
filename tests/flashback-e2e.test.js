'use strict';

// End-to-end test for the Flashback pipeline (Sprint 10 T2).
//
// Proves the chain fires under real conditions:
//
//   PTY stdout → session.analyzeOutput → _detectErrors
//              → onStatusChange → rag.onStatusChanged → rag_events
//              → onErrorDetected → mnestra-bridge.queryMnestra
//              → (optional) proactive_memory WS frame
//
// We use the rag_events `status_changed → errored` row as the authoritative
// signal that the analyzer fired, because session.meta.status can legitimately
// flip back to 'idle' one event loop later when the shell prompt lands in the
// next PTY chunk — that flap is a property of the analyzer, not a pipeline
// failure.
//
// Requires a running TermDeck server with Mnestra reachable. Skips gracefully
// when either is unavailable so CI without a live stack stays green.
//
// Run: node --test tests/flashback-e2e.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

// Sprint 39 T4 refactor: shared utilities extracted to _flashback-helpers.js
// so tests/flashback-production-flow.test.js can reuse the same probe / poll
// / fetch primitives. Behavior unchanged — pure mechanical move.
const {
  BASE_URL,
  WS_URL,
  REQUEST_TIMEOUT_MS,
  EVENT_POLL_TIMEOUT_MS,
  EVENT_POLL_INTERVAL_MS,
  sleep,
  fetchWithTimeout,
  pollUntil,
  probeServer,
} = require('./_flashback-helpers');

let skipAll = false;
let skipReason = '';
let createdSessionId = null;

before(async () => {
  // Probe the server + verify Mnestra is reachable. Flashback can't fire
  // without Mnestra, so testing the pipeline end-to-end requires both.
  const probe = await probeServer();
  if (probe.skip) {
    skipAll = true;
    skipReason = probe.reason;
  }
});

after(async () => {
  if (!createdSessionId) return;
  try {
    await fetchWithTimeout(`${BASE_URL}/api/sessions/${createdSessionId}`, { method: 'DELETE' });
  } catch {
    // best-effort cleanup — server may already be gone
  }
});

test('error in PTY → output analyzer → mnestra-bridge query pipeline fires', async (t) => {
  if (skipAll) return t.skip(skipReason);

  // ---- Sprint 33 T4 Phase A instrumentation ----------------------------------
  // When this test fails it has historically been a black hole — the only
  // signal is "no status_changed→errored event in 8s." That doesn't tell us
  // whether (a) bash never echoed the error, (b) the analyzer didn't match the
  // error pattern, (c) the analyzer matched but onStatusChange didn't fire,
  // or (d) onStatusChange fired but rag_events insert never happened. The
  // instrumentation below captures all four signals and dumps them to test
  // diagnostics on failure.
  const startTs = Date.now();
  const ms = () => Date.now() - startTs;
  const wsFrames = [];               // every WS frame received: { ms, type, raw_preview }
  const sessionMetaSamples = [];     // session.meta snapshots over time
  const ragEventsForSession = [];    // rag_events with this session_id (any type)
  const dumpDiagnostics = (label) => {
    const wsTypeCounts = wsFrames.reduce((acc, f) => {
      acc[f.type] = (acc[f.type] || 0) + 1; return acc;
    }, {});
    t.diagnostic(`---- T4 PHASE-A DIAGNOSTICS (${label}) ----`);
    t.diagnostic(`elapsed_ms=${ms()} session=${createdSessionId}`);
    t.diagnostic(`ws frames: total=${wsFrames.length} types=${JSON.stringify(wsTypeCounts)}`);
    if (wsFrames.length > 0) {
      const sample = wsFrames.slice(0, 12).map((f) => `  [${f.ms}ms] ${f.type}: ${f.raw_preview}`).join('\n');
      t.diagnostic(`ws first 12 frames:\n${sample}`);
    }
    t.diagnostic(`session.meta samples (${sessionMetaSamples.length}):`);
    for (const s of sessionMetaSamples) {
      t.diagnostic(`  [${s.ms}ms] status=${s.status} statusDetail=${JSON.stringify(s.statusDetail || null)} lastCommand=${JSON.stringify(s.lastCommand || null)}`);
    }
    t.diagnostic(`rag_events for session (${ragEventsForSession.length}):`);
    for (const e of ragEventsForSession.slice(0, 20)) {
      t.diagnostic(`  [${e.observed_ms}ms] type=${e.event_type} payload=${JSON.stringify(e.payload).slice(0, 180)}`);
    }
  };

  // 1. Create a bash session. bash is picked so `cat /nonexistent` hits the
  //    real filesystem and produces a "No such file or directory" line that
  //    the error regex in session.js will match.
  const createRes = await fetchWithTimeout(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'bash', label: 'flashback-e2e' }),
  });
  assert.equal(createRes.status, 201, 'POST /api/sessions must return 201');
  const session = await createRes.json();
  assert.ok(session.id, 'session response must include an id');
  createdSessionId = session.id;
  t.diagnostic(`[T4] session created at ${ms()}ms id=${session.id} pid=${session.pid} initialStatus=${session.meta?.status}`);

  if (session.meta?.status === 'errored') {
    // PTY spawn itself failed — can't exercise the pipeline.
    return t.skip(`session failed to spawn: ${session.meta.statusDetail || 'unknown'}`);
  }

  // 2. Attach a WebSocket to watch for proactive_memory frames. Best-effort:
  //    Mnestra may not have a matching memory, in which case no frame is sent.
  //    Reaching that branch proves the bridge was queried end-to-end.
  let proactiveMemoryFrame = null;
  let wsOpen = false;
  const ws = new WebSocket(`${WS_URL}?session=${createdSessionId}`);
  ws.on('message', (raw) => {
    const text = raw.toString();
    try {
      const msg = JSON.parse(text);
      // Capture every frame for diagnostic dump. Trim binary/output frames so
      // the diagnostic log stays readable (output frames carry full PTY chunks).
      const preview = msg.type === 'output'
        ? `len=${(msg.data || '').length} sample=${JSON.stringify((msg.data || '').slice(0, 80))}`
        : JSON.stringify(msg).slice(0, 200);
      wsFrames.push({ ms: ms(), type: msg.type || '<unknown>', raw_preview: preview });
      if (msg.type === 'proactive_memory') proactiveMemoryFrame = msg.hit;
    } catch {
      wsFrames.push({ ms: ms(), type: '<non-json>', raw_preview: text.slice(0, 80) });
    }
  });
  await new Promise((resolve) => {
    const done = () => resolve();
    ws.once('open', () => { wsOpen = true; done(); });
    ws.once('error', done);
    setTimeout(done, 2000).unref?.();
  });
  t.diagnostic(`[T4] ws ${wsOpen ? 'open' : 'failed-or-timed-out'} at ${ms()}ms`);

  // 3. Let the PTY finish spawning the shell before we write to it. Bash
  //    prints its prompt within a few ms, but give it a bit of slack.
  await sleep(500);

  // 4. Inject an error-triggering command. The bash stderr line matches
  //    PATTERNS.error in session.js, which flips meta.status to 'errored'
  //    AND fires onStatusChange (→ rag.onStatusChanged → rag_events insert)
  //    AND fires onErrorDetected (→ mnestra-bridge.queryMnestra).
  const inputRes = await fetchWithTimeout(`${BASE_URL}/api/sessions/${createdSessionId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'cat /nonexistent/file/path\n' }),
  });
  assert.equal(inputRes.status, 200, 'POST /api/sessions/:id/input must return 200');
  t.diagnostic(`[T4] input posted at ${ms()}ms`);

  // 5. Poll /api/rag/events for a status_changed row transitioning this
  //    session into 'errored'. We poll rag_events rather than session.meta
  //    because the analyzer can legitimately flip status back to 'idle' when
  //    the bash prompt lands in the next chunk; the rag_events row is
  //    write-once and durable proof the analyzer fired.
  //
  //    Phase A instrumentation: every poll iteration also samples
  //    /api/sessions/:id (session.meta) and captures ALL rag_events for this
  //    session_id, not just the matching status_changed→errored one. That way
  //    a failure dump shows whether the analyzer fired with a different shape
  //    (e.g. status flipped to 'idle' or 'thinking', or no rag_event at all).
  const erroredEvent = await pollUntil(async () => {
    // Sample session.meta — non-blocking, failure-safe.
    try {
      const sRes = await fetchWithTimeout(`${BASE_URL}/api/sessions/${createdSessionId}`);
      if (sRes.ok) {
        const s = await sRes.json();
        const last = sessionMetaSamples[sessionMetaSamples.length - 1];
        // Only push if status changed to keep the log compact.
        if (!last || last.status !== s.meta?.status || last.lastCommand !== s.meta?.lastCommand) {
          sessionMetaSamples.push({
            ms: ms(),
            status: s.meta?.status,
            statusDetail: s.meta?.statusDetail,
            lastCommand: s.meta?.lastCommand,
          });
        }
      }
    } catch {
      // ignore — diagnostic only
    }

    try {
      const res = await fetchWithTimeout(`${BASE_URL}/api/rag/events?limit=200`);
      if (!res.ok) return null;
      const events = await res.json();
      // Capture every rag_event for this session, not just the matching one.
      // De-dup by id so repeated polls don't multiply the log.
      const seenIds = new Set(ragEventsForSession.map((e) => e.id));
      for (const e of events) {
        if (e.session_id === createdSessionId && !seenIds.has(e.id)) {
          ragEventsForSession.push({ ...e, observed_ms: ms() });
        }
      }
      return events.find((e) =>
        e.session_id === createdSessionId &&
        e.event_type === 'status_changed' &&
        e.payload?.to === 'errored'
      ) || null;
    } catch {
      return null;
    }
  }, { timeoutMs: EVENT_POLL_TIMEOUT_MS, intervalMs: EVENT_POLL_INTERVAL_MS });

  // Sample bash transcript so we know whether the "No such file or directory"
  // line actually emerged. If bash never emitted that string, the analyzer
  // had nothing to match — that points at PATTERNS.error or the input flow,
  // not the rag_events insertion path.
  try {
    const tRes = await fetchWithTimeout(`${BASE_URL}/api/transcripts/${createdSessionId}`);
    if (tRes.ok) {
      const transcript = await tRes.json();
      const text = (transcript?.chunks || []).map((c) => c.data || '').join('');
      const matchesNoSuch = /No such file or directory/i.test(text);
      const matchesError = /error/i.test(text);
      t.diagnostic(`[T4] transcript bytes=${text.length} contains "No such file or directory"=${matchesNoSuch} contains /error/i=${matchesError}`);
      if (text.length > 0) {
        t.diagnostic(`[T4] transcript tail: ${JSON.stringify(text.slice(-400))}`);
      }
    } else {
      t.diagnostic(`[T4] transcript fetch returned ${tRes.status}`);
    }
  } catch (err) {
    t.diagnostic(`[T4] transcript fetch failed: ${err.message}`);
  }

  if (!erroredEvent) {
    dumpDiagnostics('TIMEOUT — no status_changed→errored event');
  } else {
    dumpDiagnostics('SUCCESS — errored event seen');
  }

  assert.ok(
    erroredEvent,
    `no status_changed→errored event appeared for session ${createdSessionId} within ${EVENT_POLL_TIMEOUT_MS}ms — output analyzer did not detect the error`
  );
  assert.equal(erroredEvent.payload.to, 'errored', 'rag event must log transition to "errored"');

  // 6. The mnestra-bridge call is fire-and-forget, so a failing Mnestra must
  //    not take the server down. Confirm /api/health still responds.
  const postHealth = await fetchWithTimeout(`${BASE_URL}/api/health`);
  assert.ok(postHealth.ok, 'server must remain responsive after pipeline fires');

  // 7. If Mnestra had a hit, the bridge will have pushed a proactive_memory
  //    frame over the WS. We don't require it — the test store may not match
  //    — but emit a diagnostic so reviewers see when the full happy path
  //    lit up. The mnestra-bridge fetch is async and fires after rag_events
  //    is already written, so give the frame up to 3s to arrive before we
  //    close the socket (closing too early = dropped hit, not a real failure).
  if (wsOpen && !proactiveMemoryFrame) {
    await pollUntil(() => proactiveMemoryFrame || null, {
      timeoutMs: 3000,
      intervalMs: 100,
    });
  }
  if (wsOpen && proactiveMemoryFrame) {
    const preview = JSON.stringify(proactiveMemoryFrame).slice(0, 200);
    t.diagnostic(`proactive_memory frame received: ${preview}`);
  }

  try { ws.close(); } catch { /* already closed */ }
});

// Sprint 26 T1 — bridge contract test.
//
// Sprint 21 T1 fixed a 15-sprint regression where queryDirect sent
// `recency_weight` / `decay_days` keys to an 8-arg PostgREST RPC, causing
// every Flashback query to silently 404. The trigger fired, but the bridge
// returned an error every time, so the user-visible behavior was "Flashback
// is silent." That class of regression is invisible to the trigger-side
// pipeline test above, because it succeeds even when the bridge is broken.
//
// This test asks the bridge for a string that cannot match anything and
// asserts the response shape: HTTP 200 with `{ memories: [], total: 0 }`.
// If a future change to the bridge adds an unsupported RPC parameter, breaks
// the function name, drifts on the SQL signature, or fails to map the response
// row shape, the bridge will return an error response and this test will fail
// loudly instead of degrading to "no Flashback."
test('mnestra bridge returns well-shaped response when there are zero hits', async (t) => {
  if (skipAll) return t.skip(skipReason);

  const res = await fetchWithTimeout(`${BASE_URL}/api/ai/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Random ASCII salad guaranteed to miss every real memory. Includes a
      // unique sentinel so log greppers can find this query if it ever fires
      // a real-world false positive.
      question: 'flashback-contract-test-zzqx-no-real-memory-should-match-this-12345',
      project: 'flashback-contract-test-nonexistent-project'
    })
  });

  assert.equal(
    res.status, 200,
    'POST /api/ai/query must return 200 even when there are zero hits — non-200 means the bridge layer (RPC signature, RPC name, auth, response mapping) regressed'
  );

  const body = await res.json();
  assert.ok(Array.isArray(body.memories), '`memories` must be an array');
  assert.equal(body.memories.length, 0, 'unique salad query must produce zero memories');
  assert.equal(typeof body.total, 'number', '`total` must be a number');
  assert.equal(body.total, 0, '`total` must be 0 when there are no hits');
});

// Sprint 34 T3 — project-bound Flashback content test.
//
// The first test in this file proves the trigger pipeline fires with
// meta.project=null. v0.7.1 unblocked that path. This test covers the
// project-bound path: a session created with project='termdeck' must, on
// hitting the canonical shell error, surface a proactive_memory frame
// whose memories array is non-empty AND whose memory.project values are
// 'termdeck' or null (never 'chopin-nashville' for TermDeck content).
//
// Pre-flight: the test queries /api/ai/query with project='termdeck'. If
// the corpus has zero matching memories (T2's backfill hasn't run yet, or
// fresh install), the test reports "needs-backfill" via t.skip with a
// specific message rather than a generic 8s timeout — a black-hole skip
// would mask a real regression.

const PROJECT_PROBE_QUESTION = 'shell error cat no such file or directory';

test('project-bound flashback: termdeck session surfaces termdeck/null memories (not chopin-nashville)', async (t) => {
  if (skipAll) return t.skip(skipReason);

  // 0. Pre-flight: confirm the corpus has at least one memory tagged
  //    'termdeck' so the trigger path has something to hit. If zero, this
  //    is the v0.7.2-pre / pre-backfill state — skip with a directive
  //    message so a reviewer reading test output sees what's needed.
  let preflightMemories = null;
  try {
    const probe = await fetchWithTimeout(`${BASE_URL}/api/ai/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: PROJECT_PROBE_QUESTION, project: 'termdeck' }),
    });
    if (probe.ok) {
      const body = await probe.json();
      preflightMemories = Array.isArray(body.memories) ? body.memories : [];
    }
  } catch {
    // ignore — we'll skip below
  }
  if (preflightMemories === null) {
    return t.skip('mnestra bridge probe failed — cannot confirm corpus state');
  }
  if (preflightMemories.length === 0) {
    return t.skip(
      'corpus has zero memories tagged project="termdeck" — needs-backfill: ' +
      'run scripts/migrate-chopin-nashville-tag.sql (Sprint 34 T2) to reclassify ' +
      'mis-tagged chopin-nashville rows before this assertion can be exercised.'
    );
  }
  t.diagnostic(`preflight: ${preflightMemories.length} termdeck-tagged memories matched probe question`);

  // 1. Spawn a bash session bound to project='termdeck'. The server resolves
  //    cwd from config.projects['termdeck'].path when present; if that path
  //    is missing in config.yaml we fall back to the home dir, which is
  //    fine for the writer test — the project tag itself is what matters.
  const startTs = Date.now();
  const ms = () => Date.now() - startTs;
  const createRes = await fetchWithTimeout(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'bash',
      label: 'flashback-e2e-project-bound',
      project: 'termdeck',
    }),
  });
  assert.equal(createRes.status, 201, 'POST /api/sessions must return 201');
  const session = await createRes.json();
  assert.ok(session.id, 'session response must include an id');
  const sessionId = session.id;
  t.diagnostic(`[T3] project-bound session created at ${ms()}ms id=${sessionId} project=${session.project ?? session.meta?.project}`);

  if (session.meta?.status === 'errored') {
    try {
      await fetchWithTimeout(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
    } catch { /* best-effort cleanup */ }
    return t.skip(`session failed to spawn: ${session.meta.statusDetail || 'unknown'}`);
  }

  // The server must echo back project='termdeck' on the created session.
  // If it doesn't, the session-create handler is dropping the field and
  // every subsequent assertion would be testing the wrong thing.
  const echoedProject = session.project ?? session.meta?.project;
  assert.equal(
    echoedProject, 'termdeck',
    `created session.project should echo 'termdeck'; got ${JSON.stringify(echoedProject)}. ` +
    `If null, the API is dropping the project field on session-create.`
  );

  // 2. Watch the WS for proactive_memory frames bound to this session.
  let proactiveMemoryFrame = null;
  let wsOpen = false;
  const ws = new WebSocket(`${WS_URL}?session=${sessionId}`);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'proactive_memory') proactiveMemoryFrame = msg.hit;
    } catch {
      // ignore non-JSON frames
    }
  });
  await new Promise((resolve) => {
    const done = () => resolve();
    ws.once('open', () => { wsOpen = true; done(); });
    ws.once('error', done);
    setTimeout(done, 2000).unref?.();
  });
  t.diagnostic(`[T3] ws ${wsOpen ? 'open' : 'failed-or-timed-out'} at ${ms()}ms`);

  if (!wsOpen) {
    try {
      await fetchWithTimeout(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
    } catch { /* best-effort */ }
    return t.skip('websocket failed to open — cannot observe proactive_memory frame');
  }

  try {
    // Let the shell prompt land before we write to it.
    await sleep(500);

    // 3. Trigger the canonical shell error. v0.7.1's PATTERNS.shellError
    //    extension makes bash's "No such file or directory" a flashback
    //    trigger; v0.7.2's writer fix is what makes the resulting bridge
    //    query return termdeck-tagged content.
    const inputRes = await fetchWithTimeout(`${BASE_URL}/api/sessions/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'cat /nonexistent/file/path\n' }),
    });
    assert.equal(inputRes.status, 200, 'POST /api/sessions/:id/input must return 200');

    // 4. Wait for the proactive_memory WS frame. The bridge fires the
    //    Mnestra query asynchronously after rag_events writes, so give
    //    it a generous budget. EVENT_POLL_TIMEOUT_MS already accounts
    //    for the analyzer + bridge + WS roundtrip.
    await pollUntil(() => proactiveMemoryFrame || null, {
      timeoutMs: EVENT_POLL_TIMEOUT_MS,
      intervalMs: EVENT_POLL_INTERVAL_MS,
    });

    assert.ok(
      proactiveMemoryFrame,
      `no proactive_memory frame received within ${EVENT_POLL_TIMEOUT_MS}ms for project='termdeck' session — ` +
      `either the bridge is not being queried with project='termdeck' or the corpus mis-tag is hiding all matches.`
    );

    // 5. The frame's hit must carry non-empty content. The production
    //    emit shape is { type: 'proactive_memory', hit: <single memory> }
    //    (server: index.js _onErrorDetected → JSON.stringify({type, hit})).
    //    Line 416 above stores msg.hit directly into proactiveMemoryFrame,
    //    so proactiveMemoryFrame IS the single hit — not a wrapping frame
    //    with a .memories[] array. Sprint 39 T4 corrected the prior
    //    .memories[]-shaped assertion that was structurally unreachable.
    t.diagnostic(`[T3] proactive_memory hit received: project=${JSON.stringify(proactiveMemoryFrame.project)} similarity=${proactiveMemoryFrame.similarity}`);

    assert.ok(
      proactiveMemoryFrame.content && proactiveMemoryFrame.content.length > 0,
      `proactive_memory frame.hit.content is empty even though ${preflightMemories.length} termdeck-tagged memories ` +
      `match the probe — the bridge is filtering on a different project tag than the session was created with.`
    );

    // 6. The hit must be tagged 'termdeck' or null. Anything tagged
    //    'chopin-nashville' for a project='termdeck' session is the v0.7.1
    //    regression we shipped v0.7.2 to fix; it must never come back
    //    silently. (null is acceptable because some legitimate cross-
    //    project memories — universal patterns, e.g. — are written without
    //    a project tag.)
    const hitProject = proactiveMemoryFrame.project;
    const offending = hitProject != null && hitProject !== 'termdeck';
    if (offending) {
      t.diagnostic(`[T3] offending hit: project=${JSON.stringify(hitProject)} content=${JSON.stringify((proactiveMemoryFrame.content || '').slice(0, 80))}`);
    }
    assert.ok(
      !offending,
      `proactive_memory hit returned to a project='termdeck' session carries a non-termdeck, non-null project tag ` +
      `(${JSON.stringify(hitProject)}) — Sprint 34 regression. Expected only 'termdeck' or null.`
    );
  } finally {
    try { ws.close(); } catch { /* already closed */ }
    try {
      await fetchWithTimeout(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' });
    } catch { /* best-effort cleanup */ }
  }
});
