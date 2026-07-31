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
//     markExpired(db, eventId, expiredAt?) → bool          (Sprint 82 T2)
//     markClickedThrough(db, eventId) → bool
//     getRecentFlashbacks(db, { since?, limit? }) → row[]
//     getFunnelStats(db, { since? }) → { fires, dismissed, expired,
//                                        clicked_through }
//
//   Quality gate + blacklist TTL (Sprint 82 T2):
//     resolveMinSimilarity(env?) → number in [0,1]
//     resolveDismissTtlDays(env?) → number (0 = no TTL)
//     semanticSimilarityOf(candidate) → number | null
//     hasExpiredAtColumn(db) → bool (memoized capability probe)
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

// ---- Sprint 82 T2: calibration knobs -------------------------------------

// Minimum RAW COSINE similarity a candidate must clear before its toast is
// allowed to fire. This gates on `semantic_similarity` (migration 033's
// absolute signal), NEVER on `score` — `score` is an ordinal RRF composite
// whose hard ceiling is ~0.074, so any threshold expressed against it is
// meaningless. 0.35 is deliberately permissive: it kills the "top of an
// empty field" case (nothing in the corpus is related, but something has to
// rank first) without demanding near-duplicate error text.
const DEFAULT_MIN_SIMILARITY = 0.35;

// How long an EXPLICIT user dismissal suppresses a memory. Pre-Sprint-82
// this was unbounded, so the useful pool drained monotonically and never
// refilled. 14 days is long enough that a genuinely-irrelevant memory stays
// out of the way for the lifetime of the problem that surfaced it, short
// enough that a memory dismissed in one context can resurface in another.
const DEFAULT_DISMISS_TTL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

// Reads TERMDECK_FLASHBACK_MIN_SIMILARITY. Clamped to [0, 1]; unset, blank,
// or unparseable falls back to the default. 0 disables the gate entirely
// (every candidate passes) — the documented escape hatch for anyone who
// wants pre-Sprint-82 firing behavior against a post-033 store.
function resolveMinSimilarity(env) {
  const source = env || process.env;
  const raw = source.TERMDECK_FLASHBACK_MIN_SIMILARITY;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_MIN_SIMILARITY;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MIN_SIMILARITY;
  return Math.max(0, Math.min(1, n));
}

// Reads TERMDECK_FLASHBACK_DISMISS_TTL_DAYS. Unset/blank/unparseable/negative
// falls back to the default. An explicit 0 means "no TTL" — dismissals
// suppress forever, i.e. the pre-Sprint-82 behavior, kept reachable on
// purpose so the change is reversible without a redeploy.
function resolveDismissTtlDays(env) {
  const source = env || process.env;
  const raw = source.TERMDECK_FLASHBACK_DISMISS_TTL_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_DISMISS_TTL_DAYS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DISMISS_TTL_DAYS;
  return n;
}

// The absolute quality signal for one candidate, or null when the store
// predates migration 033 (or the row carried no query embedding). Null is
// the feature-detection signal: a candidate with no cosine similarity is
// NOT gated, so a pre-033 store behaves exactly as it did before.
function semanticSimilarityOf(candidate) {
  if (!candidate) return null;
  const v = candidate.semantic_similarity;
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

// ISO cutoff for the dismissal TTL window, or null when the TTL is disabled.
// `dismissed_at` is stored as an ISO-8601 UTC string, so a lexicographic
// `>=` compare in SQLite is a correct chronological compare.
function dismissCutoffIso(ttlDays, nowMs) {
  if (!(ttlDays > 0)) return null;
  const base = Number.isFinite(nowMs) ? nowMs : Date.now();
  return new Date(base - ttlDays * DAY_MS).toISOString();
}

// Memoized `PRAGMA table_info` probe for flashback_events.expired_at. The
// column is added in-place by database.js (PRAGMA-guarded ALTER, the same
// shape as command_history.source / sessions.role). It can legitimately be
// absent — an install whose ALTER failed, or a fixture DB built from the
// bare CREATE — so every read and write of the column is gated on this.
// WeakMap-keyed so test fixtures that open many short-lived DBs don't leak.
const expiredAtCapability = new WeakMap();

function hasExpiredAtColumn(db) {
  if (!db) return false;
  if (expiredAtCapability.has(db)) return expiredAtCapability.get(db);
  let present = false;
  try {
    const cols = db.prepare(`PRAGMA table_info(flashback_events)`).all();
    present = Array.isArray(cols) && cols.some((c) => c && c.name === 'expired_at');
  } catch (err) {
    console.warn('[flashback-diag] expired_at capability probe failed:', err.message);
    present = false;
  }
  expiredAtCapability.set(db, present);
  return present;
}

// Test-only: drop a cached capability verdict (a fixture that ALTERs a DB
// after first use would otherwise keep the stale `false`).
function _resetCapabilityForTest(db) {
  if (db) expiredAtCapability.delete(db);
}

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

// Marks an event as dismissed — an EXPLICIT user rejection (the × button,
// nothing else). Sprint 82 T2 narrowed this: it used to also absorb the 30 s
// auto-timeout, which conflated "the user looked at this and said no" with
// "the user was heads-down in another panel and never saw it." Unattended
// expiry now goes to markExpired and never writes dismissed_at.
//
// Idempotent: only writes when dismissed_at is currently NULL, so the FIRST
// dismiss wins. Returns true when a row was actually updated.
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

// Sprint 82 T2: marks an event as EXPIRED — the toast's 30 s auto-timer
// fired and removed it with no user interaction at all. This is explicitly
// NOT a dismissal: a toast nobody saw is not a rejection, and treating it as
// one drained the useful memory pool monotonically (every unattended error
// permanently blacklisted whatever memory happened to surface for it).
//
// Writes ONLY expired_at, never dismissed_at, so the blacklist read path
// (isMemoryDismissed) is untouched by expiry. Guarded three ways: the column
// must exist (older installs degrade to a ring-only diag event and return
// false), the row must not already be expired, and the row must not already
// be dismissed (an explicit user verdict always outranks a later timer —
// the click handlers clear the timer, but a lost race must not overwrite).
//
// Returns true when a row was actually updated.
function markExpired(db, eventId, expiredAt) {
  if (!db || !eventId) return false;
  const id = Number(eventId);
  if (!Number.isFinite(id) || id <= 0) return false;
  if (!hasExpiredAtColumn(db)) return false;
  try {
    const ts = expiredAt || new Date().toISOString();
    const result = db.prepare(`
      UPDATE flashback_events
         SET expired_at = ?
       WHERE id = ?
         AND expired_at IS NULL
         AND dismissed_at IS NULL
    `).run(ts, id);
    return result.changes > 0;
  } catch (err) {
    console.warn('[flashback-diag] markExpired UPDATE failed:', err.message);
    return false;
  }
}

// Marks an event as clicked-through (user opened the modal). Click-through
// is also an implicit dismiss, so if dismissed_at is still NULL we set it
// at the same moment. Idempotent: clicking twice is a no-op on the second
// pass. Returns true when a row was actually updated.
//
// Sprint 82 T2 note: this still stamps dismissed_at, because for the FUNNEL
// "the toast stopped being on screen" is the right meaning and the dashboard
// depends on it. What changed is the BLACKLIST read — isMemoryDismissed now
// excludes clicked_through rows, so opening a memory no longer suppresses
// it. Engagement is a positive signal; it was being fed to the negative one.
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

// Sprint 57 T1 (#4): negative-feedback persistence read-side. Returns true
// when ANY prior flashback_events row for this memory_id (`top_hit_id`)
// has `dismissed_at` set — meaning the user previously dismissed (or
// click-through-then-implicitly-dismissed) a flashback featuring this
// same memory. The proactive emit path uses this to skip already-dismissed
// memories before sending the next `proactive_memory` frame, so a
// low-confidence hit the user marked "Not relevant" stops resurfacing.
//
// Scope is global (no `session_id` filter) — user intent is "this memory
// isn't useful," not "this memory isn't useful in THIS session." Matches
// the Sprint 55 T4-Codex audit-addendum brief shape
// (`WHERE NOT EXISTS (... memory_id = X AND dismissed_at IS NOT NULL)`),
// adapted to the actual schema column name `top_hit_id`.
//
// Sprint 82 T2 bounds this two ways, because as written it was a one-way
// ratchet on a finite pool:
//
//   • TTL — only dismissals inside the last `ttlDays` (default 14) suppress.
//     A dismissal is a verdict on a moment, not a permanent property of the
//     memory. Pass ttlDays: 0 to restore the unbounded pre-82 behavior.
//   • clicked_through excluded — a row the user OPENED is engagement, not
//     rejection. markClickedThrough stamps dismissed_at for funnel purposes
//     (the toast did leave the screen), which meant every memory the user
//     found useful enough to read was then blacklisted forever. Reading a
//     memory must never be the thing that buries it.
//
// Unattended 30 s timeouts no longer reach this predicate at all — they
// write expired_at via markExpired and leave dismissed_at NULL.
//
// SAFE when db is null (returns false → caller falls back to default emit
// path, identical to pre-Sprint-57 behavior) and when memoryId is empty
// or non-string (returns false). Errors are caught and logged — must
// never break the live emit path.
function isMemoryDismissed(db, memoryId, options) {
  if (!db || !memoryId || typeof memoryId !== 'string') return false;
  const opts = options || {};
  const ttlDays = Number.isFinite(opts.ttlDays) ? opts.ttlDays : resolveDismissTtlDays();
  const cutoff = dismissCutoffIso(ttlDays, opts.now);
  try {
    const row = cutoff
      ? db.prepare(`
          SELECT 1 AS hit FROM flashback_events
           WHERE top_hit_id = ?
             AND dismissed_at IS NOT NULL
             AND dismissed_at >= ?
             AND clicked_through = 0
           LIMIT 1
        `).get(memoryId, cutoff)
      : db.prepare(`
          SELECT 1 AS hit FROM flashback_events
           WHERE top_hit_id = ?
             AND dismissed_at IS NOT NULL
             AND clicked_through = 0
           LIMIT 1
        `).get(memoryId);
    return Boolean(row);
  } catch (err) {
    console.warn('[flashback-diag] isMemoryDismissed SELECT failed:', err.message);
    return false;
  }
}

// Sprint 57 T1 (#4): pure selection helper used by the proactive-emit path
// in `packages/server/src/index.js`. Walks the score-ordered Mnestra
// candidate list and returns:
//   { hit, dismissedCount, scannedCount, belowThresholdCount,
//     thresholdApplied, minSimilarity, topSimilarity }
// where:
//   • hit          — the first candidate that clears the quality gate AND
//                    is not in the dismissed set (or null when every
//                    candidate failed one of those / the list is empty)
//   • dismissedCount — how many candidates were skipped because their
//                    memory id is in the dismissed set
//   • belowThresholdCount — how many were skipped for failing the gate
//   • scannedCount — how many candidates were inspected before stopping
//                    (= skipped + 1 when a hit was returned;
//                    = list length when nothing matched)
//   • thresholdApplied — whether ANY candidate carried a cosine similarity
//                    (false ⇒ pre-033 store, gate inert, legacy behavior)
//   • minSimilarity — the gate value in force, for diag
//   • topSimilarity — cosine of the top-ranked candidate, or null; the
//                    "how close was it" number when nothing fired
//
// Sprint 82 T2 adds the quality gate. Order matters: the gate runs BEFORE
// the dismissed lookup, so a junk candidate never costs a SQLite round-trip
// and a junk-and-dismissed candidate is attributed to the gate (the more
// specific reason). Gating is per-candidate and feature-detected — a
// candidate with no `semantic_similarity` (pre-033 store, or a NULL query
// embedding) is passed through ungated, which is exactly pre-82 behavior.
//
// Extracting this from `index.js` lets the integration path (see Sprint 57
// T4-CODEX 14:24 ET audit) be tested directly without spawning a real PTY
// + WS + Mnestra bridge. The pre-extraction inline version was unreachable
// from a unit test.
//
// SAFE on null db (skips only the dismissed lookup — the quality gate still
// applies, since it needs no persistence) and on empty / non-array memories
// (returns the empty-skip shape).
function pickNextNonDismissed(db, memories, options) {
  const opts = options || {};
  const minSimilarity = Number.isFinite(opts.minSimilarity)
    ? opts.minSimilarity
    : resolveMinSimilarity();
  const ttlDays = Number.isFinite(opts.ttlDays) ? opts.ttlDays : resolveDismissTtlDays();
  const dismissOpts = { ttlDays, now: opts.now };

  const list = Array.isArray(memories) ? memories : [];
  const base = {
    dismissedCount: 0,
    scannedCount: 0,
    belowThresholdCount: 0,
    thresholdApplied: false,
    minSimilarity,
    topSimilarity: semanticSimilarityOf(list[0]),
  };
  if (list.length === 0) return { hit: null, ...base };

  let dismissedCount = 0;
  let scannedCount = 0;
  let belowThresholdCount = 0;
  let thresholdApplied = false;

  for (const candidate of list) {
    scannedCount += 1;

    const sim = semanticSimilarityOf(candidate);
    if (sim !== null && minSimilarity > 0) {
      thresholdApplied = true;
      if (sim < minSimilarity) {
        belowThresholdCount += 1;
        continue;
      }
    }

    if (db && candidate && candidate.id && isMemoryDismissed(db, candidate.id, dismissOpts)) {
      dismissedCount += 1;
      continue;
    }

    return {
      hit: candidate || null,
      dismissedCount,
      scannedCount,
      belowThresholdCount,
      thresholdApplied,
      minSimilarity,
      topSimilarity: base.topSimilarity,
    };
  }

  return {
    hit: null,
    dismissedCount,
    scannedCount,
    belowThresholdCount,
    thresholdApplied,
    minSimilarity,
    topSimilarity: base.topSimilarity,
  };
}

// Sprint 82 T2 — one drop-reason classifier shared by BOTH emit paths (the
// WS frame in index.js `session.onErrorDetected`, and the HTTP proactive
// query below). Duplicating this logic is how the two paths drift, and
// drift here is invisible: it shows up as a funnel that under-counts one
// surface. Returns the `proactive_memory_emit` outcome plus a log-ready
// reason string.
//
// Threshold outranks dismissal in the attribution order: it is the newer,
// more actionable gate and the one an operator would tune.
function classifyDrop({ count, belowThresholdCount, dismissedCount, minSimilarity, topSimilarity } = {}) {
  const n = Number(count) || 0;
  if (n === 0) return { outcome: 'dropped_empty', reason: 'no matches' };
  if (belowThresholdCount === n) {
    const top = (typeof topSimilarity === 'number' && Number.isFinite(topSimilarity))
      ? topSimilarity.toFixed(3) : 'n/a';
    return {
      outcome: 'dropped_below_threshold',
      reason: `all ${n} candidate(s) below similarity threshold (top=${top} < ${minSimilarity})`,
    };
  }
  if (dismissedCount === n) {
    return {
      outcome: 'dropped_dismissed',
      reason: `all ${n} candidate(s) previously dismissed`,
    };
  }
  return {
    outcome: 'dropped_filtered',
    reason: `all ${n} candidate(s) filtered (${belowThresholdCount} below threshold, ${dismissedCount} dismissed)`,
  };
}

// Sprint 82 T2 — gate + persist + classify for the HTTP proactive path
// (POST /api/ai/query with `proactive: true`), which the client fires on
// every panel status→errored transition.
//
// This exists because that path used to raise a real, user-visible toast
// with NO flashback_events row behind it: no id meant the client's
// dismiss / expire / click-through POSTs were all silently skipped. Two
// toast surfaces, one of them invisible to the funnel — which is the exact
// table T3's calibration reads as its label source. A funnel that silently
// omits a whole surface is worse than one that reports a smaller number,
// because nothing about it looks wrong.
//
// Recording is attempted whenever a hit clears the gate. `event_id` comes
// back null only when persistence is genuinely unavailable (no SQLite on
// this install) — the same degradation the WS path has always had, and the
// caller still shows the toast in that case rather than going dark.
//
// Returns { hit, event_id, outcome, reason, pick }.
function selectAndRecordFlashback(db, { sessionId, project, question, memories, options } = {}) {
  const list = Array.isArray(memories) ? memories : [];
  const pick = pickNextNonDismissed(db, list, options);

  if (!pick.hit) {
    const { outcome, reason } = classifyDrop({ count: list.length, ...pick });
    log({
      sessionId: sessionId || null,
      event: 'proactive_memory_emit',
      source: 'http',
      ws_ready_state: null,
      frame_size_bytes: 0,
      result_count_in_frame: list.length > 0
        ? (pick.belowThresholdCount + pick.dismissedCount) : 0,
      outcome,
      below_threshold_count: pick.belowThresholdCount,
      dismissed_count: pick.dismissedCount,
      threshold_applied: pick.thresholdApplied,
      min_similarity: pick.minSimilarity,
      top_similarity: pick.topSimilarity,
    });
    return { hit: null, event_id: null, outcome, reason, pick };
  }

  const event_id = recordFlashback(db, {
    sessionId,
    project: project || null,
    error_text: question || '',
    hits_count: list.length,
    top_hit_id: pick.hit.id || null,
    top_hit_score: typeof pick.hit.similarity === 'number' ? pick.hit.similarity : null,
  });

  log({
    sessionId: sessionId || null,
    event: 'proactive_memory_emit',
    source: 'http',
    ws_ready_state: null,
    frame_size_bytes: 0,
    result_count_in_frame: 1,
    outcome: 'emitted',
    flashback_event_id: event_id,
    threshold_applied: pick.thresholdApplied,
    min_similarity: pick.minSimilarity,
    hit_similarity: semanticSimilarityOf(pick.hit),
  });

  return { hit: pick.hit, event_id, outcome: 'emitted', reason: null, pick };
}

// Reads the most-recent N flashback fires, optionally filtered to events
// fired at-or-after the `since` ISO timestamp. Hard cap of 500 rows so
// pathological queries can't OOM the dashboard.
function getRecentFlashbacks(db, { since, limit } = {}) {
  if (!db) return [];
  try {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    // expired_at is capability-gated: an install whose in-place ALTER never
    // ran still returns rows, just without the expiry column.
    const cols = `id, fired_at, session_id, project, error_text, hits_count,
                  top_hit_id, top_hit_score, dismissed_at, clicked_through`
      + (hasExpiredAtColumn(db) ? `, expired_at` : '');
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

// Click-through funnel aggregates: total fires, dismissed, expired,
// clicked-through (modal opened). Optional `since` ISO timestamp filter.
// All four are scalar counts — the dashboard renders them as a percentage
// funnel chart.
//
// Sprint 82 T2: `expired` is new, and `dismissed` narrows to match. Before
// this sprint every unattended 30 s timeout incremented `dismissed`, so the
// funnel's rejection rate was really "fires minus fires the user happened
// to be watching" — the metric read as user rejection but mostly measured
// user absence. Historical rows keep their old meaning (they were written
// under the old semantics); the split applies from this release forward.
// `expired` reports 0 on installs whose expired_at column is absent.
function getFunnelStats(db, { since } = {}) {
  const empty = { fires: 0, dismissed: 0, expired: 0, clicked_through: 0 };
  if (!db) return empty;
  try {
    const where = since ? `WHERE fired_at >= ?` : '';
    const args = since ? [since] : [];
    const expiredExpr = hasExpiredAtColumn(db)
      ? `SUM(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END)`
      : `0`;
    const row = db.prepare(
      `SELECT
         COUNT(*) AS fires,
         SUM(CASE WHEN dismissed_at IS NOT NULL THEN 1 ELSE 0 END) AS dismissed,
         ${expiredExpr} AS expired,
         SUM(CASE WHEN clicked_through = 1 THEN 1 ELSE 0 END) AS clicked_through
       FROM flashback_events ${where}`
    ).get(...args);
    return {
      fires: Number(row?.fires || 0),
      dismissed: Number(row?.dismissed || 0),
      expired: Number(row?.expired || 0),
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
  _resetCapabilityForTest,
  RING_SIZE,
  recordFlashback,
  markDismissed,
  markExpired,
  markClickedThrough,
  isMemoryDismissed,
  pickNextNonDismissed,
  classifyDrop,
  selectAndRecordFlashback,
  getRecentFlashbacks,
  getFunnelStats,
  // Sprint 82 T2 calibration surface
  DEFAULT_MIN_SIMILARITY,
  DEFAULT_DISMISS_TTL_DAYS,
  resolveMinSimilarity,
  resolveDismissTtlDays,
  semanticSimilarityOf,
  dismissCutoffIso,
  hasExpiredAtColumn,
};
