// Flashback diagnostic ring buffer (Sprint 39 T1).
//
// Six decision points along the Flashback pipeline write structured events
// here so production-flow regressions surface as a readable timeline instead
// of a silent gate failure. The ring is in-memory and lost on restart by
// design — persistence is a Sprint-40+ concern. Public surface:
//
//   log({ sessionId, event, ...fields })  — append one event
//   snapshot({ sessionId?, eventType?, limit? }) — read back filtered tail
//   _resetForTest()                                — test-only ring clear
//
// Event shape (all events): { ts, sessionId, event, ...event-specific fields }.
//
// Event types and their producers:
//   pattern_match           — session.js _detectErrors (PATTERNS.error /
//                             errorLineStart / shellError matched)
//   error_detected          — session.js _detectErrors at onErrorDetected
//                             entry, before rate-limit check
//   rate_limit_blocked      — session.js _detectErrors when 30s limiter rejects
//   bridge_query            — mnestra-bridge queryMnestra at call return
//   bridge_result           — mnestra-bridge queryMnestra at call return
//   proactive_memory_emit   — index.js onErrorDetected WS send block
//
// The route GET /api/flashback/diag (registered in index.js) returns
// snapshot() output as JSON for ad-hoc inspection by Joshua and consumption
// by T4's production-flow e2e test.

const RING_SIZE = 200;

let ring = [];

function log(event) {
  ring.push({ ts: new Date().toISOString(), ...event });
  if (ring.length > RING_SIZE) {
    ring = ring.slice(-RING_SIZE);
  }
}

function snapshot({ sessionId, eventType, limit = RING_SIZE } = {}) {
  let out = ring;
  if (sessionId) out = out.filter((e) => e.sessionId === sessionId);
  if (eventType) out = out.filter((e) => e.event === eventType);
  const cap = Math.max(1, Math.min(RING_SIZE, Number(limit) || RING_SIZE));
  return out.slice(-cap);
}

function _resetForTest() {
  ring = [];
}

module.exports = { log, snapshot, _resetForTest, RING_SIZE };
