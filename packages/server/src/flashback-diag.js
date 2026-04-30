// Flashback diagnostic ring buffer (Sprint 39 T1) + durable audit table
// (Sprint 43 T2).
//
// Two layers of observability for the Flashback pipeline:
//
//   (1) IN-MEMORY RING — six decision points along the pipeline write
//       structured events to a 200-event ring. Lost on restart. Powers the
//       /api/flashback/diag endpoint and the live diagnostic UI. This is
//       fine-grained: every pattern match, every rate-limit hit, every
//       bridge query gets logged.
//
//   (2) SQLITE AUDIT TABLE (flashback_events) — every actual fire (the
//       moment a proactive_memory frame is sent over WS to the user's
//       panel) gets one durable row. Survives restart. Powers the
//       /flashback-history.html dashboard and the click-through funnel.
//       This is coarse-grained: one row per fire, plus dismiss/click-through
//       outcome.
//
// Public surface:
//
//   In-memory ring (Sprint 39):
//     log({ sessionId, event, ...fields }) — append one event
//     snapshot({ sessionId?, eventType?, limit? }) — read back filtered tail
//     _resetForTest() — test-only ring clear
//
//   SQLite audit (Sprint 43 T2):
//     recordFlashback(db, { sessionId, project, error_text, hits_count,
//                           top_hit_id, top_hit_score, fired_at? }) → id
//     markDismissed(db, eventId, dismissedAt?) → bool
//     markClickedThrough(db, eventId) → bool
//     getRecentFlashbacks(db, { since?, limit? }) → row[]
//     getFunnelStats(db, { since? }) → { fires, dismissed, clicked_through }
//
// Event shape (ring): { ts, sessionId, event, ...event-specific fields }.
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
// The audit table is an EXTENSION of the ring, not a replacement. Ring stays
// for the live UI; SQLite is for the historical question "did flashback fire
// when I needed it, and did I act on it?"
//
// SQLite functions are SAFE when db is null/undefined: they no-op and return
// null/false/[] so test fixtures and Database-unavailable installs don't
// break the live emit path.

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

// ---- SQLite audit (Sprint 43 T2) ----------------------------------------

// Persists one row per actual flashback fire. Returns the inserted row id
// (number) or null when persistence is unavailable. Errors are caught and
// logged — flashback persistence must never break the live emit path.
function recordFlashback(db, event) {
  if (!db) return null;
  if (!event || (!event.sessionId && !event.session_id)) return null;
  try {
    const fired_at = event.fired_at || new Date().toISOString();
    const session_id = event.session_id || event.sessionId;
    const hits_count = Number.isFinite(event.hits_count) ? event.hits_count : 0;
    const top_hit_score = (typeof event.top_hit_score === 'number'
      && Number.isFinite(event.top_hit_score)) ? event.top_hit_score : null;
    const result = db.prepare(`
      INSERT INTO flashback_events
        (fired_at, session_id, project, error_text, hits_count,
         top_hit_id, top_hit_score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      fired_at,
      session_id,
      event.project || null,
      event.error_text || '',
      hits_count,
      event.top_hit_id || null,
      top_hit_score,
    );
    // better-sqlite3 returns BigInt for lastInsertRowid; coerce to Number
    // so it serializes naturally into JSON and the WS frame.
    return Number(result.lastInsertRowid);
  } catch (err) {
    console.warn('[flashback-diag] recordFlashback INSERT failed:', err.message);
    return null;
  }
}

// Marks an event as dismissed (toast went away — by user, by 30s timeout,
// or implicitly via click-through). Idempotent: only writes when
// dismissed_at is currently NULL, so the FIRST dismiss wins. Returns true
// when a row was actually updated.
function markDismissed(db, eventId, dismissedAt) {
  if (!db || !eventId) return false;
  const id = Number(eventId);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    const ts = dismissedAt || new Date().toISOString();
    const result = db.prepare(`
      UPDATE flashback_events
         SET dismissed_at = ?
       WHERE id = ? AND dismissed_at IS NULL
    `).run(ts, id);
    return result.changes > 0;
  } catch (err) {
    console.warn('[flashback-diag] markDismissed UPDATE failed:', err.message);
    return false;
  }
}

// Marks an event as clicked-through (user opened the modal). Click-through
// is also an implicit dismiss, so if dismissed_at is still NULL we set it
// at the same moment. Idempotent: clicking twice is a no-op on the second
// pass. Returns true when a row was actually updated.
function markClickedThrough(db, eventId) {
  if (!db || !eventId) return false;
  const id = Number(eventId);
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    const ts = new Date().toISOString();
    const result = db.prepare(`
      UPDATE flashback_events
         SET clicked_through = 1,
             dismissed_at    = COALESCE(dismissed_at, ?)
       WHERE id = ? AND clicked_through = 0
    `).run(ts, id);
    return result.changes > 0;
  } catch (err) {
    console.warn('[flashback-diag] markClickedThrough UPDATE failed:', err.message);
    return false;
  }
}

// Reads the most-recent N flashback fires, optionally filtered to events
// fired at-or-after the `since` ISO timestamp. Hard cap of 500 rows so
// pathological queries can't OOM the dashboard.
function getRecentFlashbacks(db, { since, limit } = {}) {
  if (!db) return [];
  try {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    const cols = `id, fired_at, session_id, project, error_text, hits_count,
                  top_hit_id, top_hit_score, dismissed_at, clicked_through`;
    if (since) {
      return db.prepare(
        `SELECT ${cols} FROM flashback_events
          WHERE fired_at >= ?
          ORDER BY fired_at DESC
          LIMIT ?`
      ).all(since, cap);
    }
    return db.prepare(
      `SELECT ${cols} FROM flashback_events
        ORDER BY fired_at DESC
        LIMIT ?`
    ).all(cap);
  } catch (err) {
    console.warn('[flashback-diag] getRecentFlashbacks SELECT failed:', err.message);
    return [];
  }
}

// Click-through funnel aggregates: total fires, dismissed (any reason),
// clicked-through (modal opened). Optional `since` ISO timestamp filter.
// All three are scalar counts — the dashboard renders them as a percentage
// funnel chart.
function getFunnelStats(db, { since } = {}) {
  const empty = { fires: 0, dismissed: 0, clicked_through: 0 };
  if (!db) return empty;
  try {
    const where = since ? `WHERE fired_at >= ?` : '';
    const args = since ? [since] : [];
    const row = db.prepare(
      `SELECT
         COUNT(*) AS fires,
         SUM(CASE WHEN dismissed_at IS NOT NULL THEN 1 ELSE 0 END) AS dismissed,
         SUM(CASE WHEN clicked_through = 1 THEN 1 ELSE 0 END) AS clicked_through
       FROM flashback_events ${where}`
    ).get(...args);
    return {
      fires: Number(row?.fires || 0),
      dismissed: Number(row?.dismissed || 0),
      clicked_through: Number(row?.clicked_through || 0),
    };
  } catch (err) {
    console.warn('[flashback-diag] getFunnelStats SELECT failed:', err.message);
    return empty;
  }
}

module.exports = {
  log,
  snapshot,
  _resetForTest,
  RING_SIZE,
  recordFlashback,
  markDismissed,
  markClickedThrough,
  getRecentFlashbacks,
  getFunnelStats,
};
