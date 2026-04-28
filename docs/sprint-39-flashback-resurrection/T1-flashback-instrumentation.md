# Sprint 39 — T1: Daily-flow Flashback instrumentation

**Lane goal:** Add structured logging at every decision point in the Flashback pipeline so Joshua (and future debugging sessions) can trigger a real-shell error and read out exactly which gate dropped the toast. Without this, Sprints 21 and 33 each shipped fixes that passed e2e tests but missed the production-flow regression — they had no observability into the actual decision tree at runtime. After T1 lands, `GET /api/flashback/diag` returns the last 200 Flashback events with full decision context.

**Target deliverable:**
1. Structured logging at six decision points (listed below) writing to an in-memory ring buffer.
2. NEW `GET /api/flashback/diag` endpoint returning the buffer as JSON, optionally filtered by sessionId or event type.
3. Tests that pin the log shape so future regressions surface as test failures, not silent gaps.

## Six decision points to instrument

Every Flashback decision flows through these six gates. Each gate emits one event to the diag ring buffer with timestamp, sessionId, and decision-specific fields:

1. **`pattern_match`** — `packages/server/src/session.js`, `PATTERNS.error` matcher. Fields: `pattern_index`, `matched_line` (truncated to 200 chars), `output_chunk_size`. Emit on every match, even ones that don't trigger Flashback.
2. **`error_detected`** — `packages/server/src/session.js`, `onErrorDetected` callback entry. Fields: `error_text`, `rate_limit_remaining_ms`, `last_emit_at`. Emit at function entry, before the rate-limit check.
3. **`rate_limit_blocked`** — same callback, when the 30s per-session limiter rejects. Fields: `rate_limit_remaining_ms`. Emit only when the call is rate-limited (so the `error_detected` count vs `rate_limit_blocked` count tells you the rejection rate).
4. **`bridge_query`** — `packages/server/src/mnestra-bridge/index.js`, `queryMnestra` or `queryDirect`. Fields: `project_tag_in_filter`, `query_text` (truncated), `mode` (`direct`/`webhook`/`mcp`), `rpc_args` (the actual params sent), `duration_ms`. Emit on call return — both success and error.
5. **`bridge_result`** — same site, after the response. Fields: `result_count`, `error_message?`, `top_3_project_tags` (from the returned memories). The `top_3_project_tags` answers the project-mismatch question T3 is investigating.
6. **`proactive_memory_emit`** — `packages/server/src/index.js`, the WS emit block. Fields: `ws_ready_state` (numeric, 0–3), `frame_size_bytes`, `result_count_in_frame`, `outcome` (`emitted` | `dropped_no_ws` | `dropped_empty`). Emit on every attempt, including drops.

## Ring buffer design

```js
// packages/server/src/flashback-diag.js (NEW)
const RING_SIZE = 200;
let ring = [];

function log(event) {
  ring.push({ ts: new Date().toISOString(), ...event });
  if (ring.length > RING_SIZE) ring = ring.slice(-RING_SIZE);
}

function snapshot({ sessionId, eventType, limit = 200 } = {}) {
  let out = ring;
  if (sessionId) out = out.filter(e => e.sessionId === sessionId);
  if (eventType) out = out.filter(e => e.event === eventType);
  return out.slice(-limit);
}

module.exports = { log, snapshot, _resetForTest: () => { ring = []; } };
```

In-memory ring buffer. Lost on server restart by design (cheap, no schema). If persistence is needed later, swap the storage layer; the public `log` / `snapshot` API stays.

## Endpoint design

```js
// packages/server/src/index.js — new route
app.get('/api/flashback/diag', (req, res) => {
  const { sessionId, eventType, limit } = req.query;
  const events = require('./flashback-diag').snapshot({
    sessionId,
    eventType,
    limit: limit ? Math.min(parseInt(limit, 10), 200) : 200,
  });
  res.json({ count: events.length, events });
});
```

Optional query params:
- `?sessionId=<uuid>` — filter to one session
- `?eventType=pattern_match` — filter to one event type
- `?limit=N` — cap return (max 200)

## Wiring sites

Each instrumentation site is one `require('./flashback-diag').log({...})` call inside the existing branch. Examples:

```js
// session.js — PATTERNS.error matcher
for (let i = 0; i < PATTERNS.length; i++) {
  if (PATTERNS[i].test(line)) {
    flashbackDiag.log({
      sessionId: this.id,
      event: 'pattern_match',
      pattern_index: i,
      matched_line: line.slice(0, 200),
      output_chunk_size: chunk.length,
    });
    this.onErrorDetected(line);
    break;
  }
}

// session.js — onErrorDetected entry
onErrorDetected(line) {
  flashbackDiag.log({
    sessionId: this.id,
    event: 'error_detected',
    error_text: line.slice(0, 200),
    rate_limit_remaining_ms: this._lastErrorAt
      ? Math.max(0, 30000 - (Date.now() - this._lastErrorAt))
      : 0,
    last_emit_at: this._lastErrorAt || null,
  });
  if (this._lastErrorAt && Date.now() - this._lastErrorAt < 30000) {
    flashbackDiag.log({
      sessionId: this.id,
      event: 'rate_limit_blocked',
      rate_limit_remaining_ms: 30000 - (Date.now() - this._lastErrorAt),
    });
    return;
  }
  // ... existing emit path ...
}
```

## Primary files

- NEW `packages/server/src/flashback-diag.js` — the ring buffer module.
- `packages/server/src/session.js` — instrument PATTERNS.error matcher + onErrorDetected.
- `packages/server/src/mnestra-bridge/index.js` — instrument queryMnestra/queryDirect at call boundary.
- `packages/server/src/rag.js` — instrument the RAGIntegration recall hand-off (if Flashback flows through it).
- `packages/server/src/index.js` — instrument the proactive_memory WS emit block + register the new route.
- NEW `tests/flashback-diag.test.js` — pins the ring buffer shape, snapshot filtering, route handler shape.

## Coordination notes

- **T2 (rcfile audit)** consumes T1's `pattern_match` events to count false positives. T1 should ship first OR in parallel — T2 can grep server logs as a fallback if T1's diag isn't ready.
- **T3 (project-tag verification)** consumes T1's `bridge_query` + `bridge_result` events. The `project_tag_in_filter` and `top_3_project_tags` fields are how T3 confirms or refutes the project-mismatch hypothesis.
- **T4 (production-flow e2e)** asserts on the diag log to verify the pipeline fired correctly. T4's test calls `GET /api/flashback/diag?sessionId=<test-session-id>` after each scenario.

## Test plan

- Unit: `flashback-diag.log({...})` appends; `snapshot()` returns last N; sessionId + eventType filters work; ring caps at 200.
- Integration: hit the route on a running server, get back a JSON shape that matches the schema. Use the sprint-runner test pattern for in-process Express harness.
- Manual smoke: trigger an error in a TermDeck session, `curl http://localhost:3000/api/flashback/diag?sessionId=<id>` → expect `pattern_match` + `error_detected` + (`bridge_query`/`bridge_result` if rate limit allowed) + `proactive_memory_emit` events in order.

## Out of scope

- Don't fix the rate-limit / rcfile-noise issue — T2 owns that.
- Don't fix the project-tag mismatch — T3 owns that.
- Don't write the production-flow e2e test — T4 owns that.
- Don't add a UI for the diag log — sprint 40+ feature; for now, curl is the interface.
- Don't bump the version, edit CHANGELOG, or commit. Orchestrator handles those at close.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-39-flashback-resurrection/STATUS.md` under `## T1`. No version bumps. No CHANGELOG. No commits. Stay in your lane.
