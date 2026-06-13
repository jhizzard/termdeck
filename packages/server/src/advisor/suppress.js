'use strict';

// Sprint 78 T2 — Advisor MVP: the per-ENTRY throttle + quarantine layer.
//
// TWO DISTINCT COOLDOWN LAYERS STACK (PLANNING §8.2 — do NOT conflate):
//   • T1's `shouldNotify(rule_id, dedupe_key)` is the per-RULE registry-stage
//     throttle (30-min default cooldown + the hard 3-advisories/lane/hr budget,
//     overflow→ORCH). We CONSUME it (last check below); we never re-implement it.
//   • THIS module is the per-ENTRY advisory layer: 24h per-entry cooldown +
//     5/session + 1/10min + once-per-(session,dedupe_key) + quarantine.
//
// All DB reads are fail-soft: any SQLite error returns the permissive-but-safe
// default (count 0 / no quarantine) and logs once — a broken advisory store can
// never throw into the onErrorDetected critical path.

const SUPPRESS_DEFAULTS = {
  maxPerSession: 5,                          // 5/session
  per10MinMs: 10 * 60 * 1000,                // 1/10min
  perRuleCooldownMs: 24 * 60 * 60 * 1000,    // 24h per-entry cooldown
  quarantineThreshold: 3,                    // 3 unheeded-with-recurrence → quarantine
  quarantineTtlMs: 7 * 24 * 60 * 60 * 1000,  // 7-day auto-expiry (A12)
};

function iso(ms) {
  return new Date(ms).toISOString();
}

// ---- quarantine table (advisory_quarantine) -----------------------------

function getQuarantine(db, ruleId) {
  if (!db || !ruleId) return null;
  try {
    return db.prepare(
      `SELECT rule_id, quarantined_at, expires_at, reason
         FROM advisory_quarantine WHERE rule_id = ?`
    ).get(ruleId) || null;
  } catch (err) {
    console.warn('[advisor] getQuarantine failed:', err.message);
    return null;
  }
}

function setQuarantine(db, ruleId, quarantinedAtIso, expiresAtIso, reason) {
  if (!db || !ruleId) return false;
  try {
    db.prepare(
      `INSERT INTO advisory_quarantine (rule_id, quarantined_at, expires_at, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(rule_id) DO UPDATE SET
         quarantined_at = excluded.quarantined_at,
         expires_at     = excluded.expires_at,
         reason         = excluded.reason`
    ).run(ruleId, quarantinedAtIso, expiresAtIso, reason || null);
    return true;
  } catch (err) {
    console.warn('[advisor] setQuarantine failed:', err.message);
    return false;
  }
}

function clearQuarantine(db, ruleId) {
  if (!db || !ruleId) return false;
  try {
    const r = db.prepare(`DELETE FROM advisory_quarantine WHERE rule_id = ?`).run(ruleId);
    return r.changes > 0;
  } catch (err) {
    console.warn('[advisor] clearQuarantine failed:', err.message);
    return false;
  }
}

// Active quarantines (expires_at in the future) — for /api/advisor/stats.
function listActiveQuarantines(db, nowMs) {
  if (!db) return [];
  try {
    const nowIso = iso(typeof nowMs === 'number' ? nowMs : Date.now());
    return db.prepare(
      `SELECT rule_id, quarantined_at, expires_at, reason
         FROM advisory_quarantine
        WHERE expires_at > ?
        ORDER BY quarantined_at DESC`
    ).all(nowIso);
  } catch (err) {
    console.warn('[advisor] listActiveQuarantines failed:', err.message);
    return [];
  }
}

// ---- advisory_events counters -------------------------------------------

function scalar(db, sql, args, field) {
  if (!db) return 0;
  try {
    const row = db.prepare(sql).get(...(args || []));
    return Number((row && row[field]) || 0);
  } catch (err) {
    console.warn('[advisor] count query failed:', err.message);
    return 0;
  }
}

function countDeliveredSessionDedupe(db, sessionId, dedupeKey) {
  return scalar(db,
    `SELECT COUNT(*) c FROM advisory_events
      WHERE delivered = 1 AND session_id = ? AND dedupe_key = ?`,
    [sessionId, dedupeKey], 'c');
}

function countDeliveredSession(db, sessionId) {
  return scalar(db,
    `SELECT COUNT(*) c FROM advisory_events
      WHERE delivered = 1 AND session_id = ?`,
    [sessionId], 'c');
}

function countDeliveredSessionSince(db, sessionId, sinceIso) {
  return scalar(db,
    `SELECT COUNT(*) c FROM advisory_events
      WHERE delivered = 1 AND session_id = ? AND fired_at >= ?`,
    [sessionId, sinceIso], 'c');
}

function lastDeliveredAtForRule(db, ruleId) {
  if (!db) return null;
  try {
    const row = db.prepare(
      `SELECT MAX(fired_at) m FROM advisory_events
        WHERE delivered = 1 AND rule_id = ?`
    ).get(ruleId);
    return (row && row.m) || null;
  } catch (err) {
    console.warn('[advisor] lastDeliveredAtForRule failed:', err.message);
    return null;
  }
}

// Is there a delivered-but-unacked advisory for this rule? (heeding == an
// ADV-ACK, which lifts the unheeded signal — never mere missing ACK alone;
// the recurrence is the other half of the AND, checked by the caller.)
function priorDeliveredUnacked(db, ruleId) {
  return scalar(db,
    `SELECT COUNT(*) c FROM advisory_events
      WHERE delivered = 1 AND rule_id = ? AND acked_at IS NULL`,
    [ruleId], 'c') > 0;
}

// Count of dup_key suppression rows for this rule SINCE the most recent ACK of
// the rule (an ACK resets the unheeded tally). This is the "unheeded recurrence"
// accrual that drives quarantine.
function unheededRecurrenceCount(db, ruleId) {
  return scalar(db,
    `SELECT COUNT(*) c FROM advisory_events
      WHERE rule_id = ? AND suppressed_reason = 'dup_key'
        AND id > COALESCE(
          (SELECT MAX(id) FROM advisory_events
            WHERE rule_id = ? AND acked_at IS NOT NULL), 0)`,
    [ruleId, ruleId], 'c');
}

// ---- the decision -------------------------------------------------------

// shouldDeliver({ db, sessionId, ruleId, dedupeKey, now?, doctrine?, options? })
//   → { deliver, reason, quarantineToast? }
//
// reason ∈ null (deliver) | 'quarantined' | 'dup_key' | 'cooldown' |
//          'rate_10min' | 'rate_session' | <T1 shouldNotify reason>
// quarantineToast is set ONCE, on the transition into quarantine, so the caller
// can emit the non-silent WS toast (A12). Subsequent quarantined hits return
// reason 'quarantined' with NO toast.
function shouldDeliver({ db, sessionId, ruleId, dedupeKey, now, doctrine, options } = {}) {
  const opts = { ...SUPPRESS_DEFAULTS, ...(options || {}) };
  const nowMs = typeof now === 'number' ? now : Date.now();
  if (!ruleId) return { deliver: false, reason: 'no_rule' };

  // 1. Active quarantine? (lift if expired.)
  const q = getQuarantine(db, ruleId);
  if (q && q.expires_at) {
    if (q.expires_at > iso(nowMs)) {
      return { deliver: false, reason: 'quarantined' };
    }
    clearQuarantine(db, ruleId); // expired → auto-lift, fall through
  }

  // 2. once-per-(session, dedupe_key) — a recurrence of an already-advised
  //    error in the same session. Accrues toward quarantine when the prior
  //    delivered advisory is still unacked (recurrence AND unheeded).
  if (sessionId && dedupeKey && countDeliveredSessionDedupe(db, sessionId, dedupeKey) > 0) {
    const thisRecurrence = unheededRecurrenceCount(db, ruleId) + 1;
    if (priorDeliveredUnacked(db, ruleId) && thisRecurrence >= opts.quarantineThreshold) {
      setQuarantine(db, ruleId, iso(nowMs), iso(nowMs + opts.quarantineTtlMs), 'unheeded_recurrence');
      return {
        deliver: false,
        reason: 'quarantined',
        quarantineToast: { ruleId, reason: 'unheeded_recurrence', recurrences: thisRecurrence },
      };
    }
    return { deliver: false, reason: 'dup_key' };
  }

  // 3. 24h per-entry (per-rule) cooldown.
  const lastForRule = lastDeliveredAtForRule(db, ruleId);
  if (lastForRule && lastForRule > iso(nowMs - opts.perRuleCooldownMs)) {
    return { deliver: false, reason: 'cooldown' };
  }

  // 4. 1 advisory / 10 min / session.
  if (sessionId && countDeliveredSessionSince(db, sessionId, iso(nowMs - opts.per10MinMs)) > 0) {
    return { deliver: false, reason: 'rate_10min' };
  }

  // 5. 5 advisories / session.
  if (sessionId && countDeliveredSession(db, sessionId) >= opts.maxPerSession) {
    return { deliver: false, reason: 'rate_session' };
  }

  // 6. Delegate the per-RULE 30-min cooldown + 3/lane/hr budget to T1's
  //    registry-stage throttle. CONSUME — never duplicate (PLANNING §8.2).
  //    Pass db + lane/surface/session_id so the budget + cooldown actually bind
  //    (T4 audit 19:12). T1's contract is { notify, reason } — NOT { ok }.
  //    shouldNotify self-records its 'notified' decision into doctrine_events,
  //    so the throttle is self-enforcing; we never write doctrine_events here.
  if (doctrine && typeof doctrine.shouldNotify === 'function') {
    let verdict;
    try {
      verdict = doctrine.shouldNotify(ruleId, dedupeKey, {
        db,
        lane: sessionId,
        surface: 'inject-advisory',
        session_id: sessionId,
        now: nowMs,
      });
    } catch (err) {
      console.warn('[advisor] doctrine.shouldNotify threw (fail-soft, allowing):', err.message);
      verdict = null;
    }
    if (verdict && verdict.notify === false) {
      return { deliver: false, reason: verdict.reason || 'rule_throttle' };
    }
  }

  return { deliver: true, reason: null };
}

module.exports = {
  shouldDeliver,
  // exported for the store/stats path + tests
  getQuarantine,
  setQuarantine,
  clearQuarantine,
  listActiveQuarantines,
  unheededRecurrenceCount,
  SUPPRESS_DEFAULTS,
};
