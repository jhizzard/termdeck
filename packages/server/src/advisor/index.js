'use strict';

// Sprint 78 T2 — Advisor MVP: orchestration + trigger entry.
//
// Re-routes the already-proven Flashback error trigger out of the human-only
// browser toast and INTO a non-Claude agent's PTY: registry-driven (T1's
// doctrine registry), suppression-throttled (suppress.js), idle-gated
// (deliver.js), fully offline (A10), and FAIL-SOFT — nothing here may throw
// into the onErrorDetected / PTY / WS critical path. Every public entry is
// wrapped; errors log `[advisor]` and return.
//
// Pipeline (onTrigger):
//   build errorText + dedupe_key
//   → registry-only loadDoctrine({event:'T-ERR'}) match  (A1; NO Mnestra recall)
//   → suppress.shouldDeliver(...)                          (per-ENTRY throttle)
//   → deliver.injectAdvisory(...) when cleared             (idle gate + queue/TTL)
//   → record the outcome to advisory_events                (SQLite audit)
//
// The two-cooldown-layer split (PLANNING §8.2): T1's `shouldNotify` is the
// per-RULE 30-min/3-per-hr throttle we CONSUME here; suppress.js adds the
// per-ENTRY 24h/5-per-session/1-per-10min/dedupe/quarantine layers on top.

const suppress = require('./suppress');
const deliver = require('./deliver');
const { submitToPty } = require('../pty-submit');

// Non-Claude AGENT panels with a free-text TUI input box. A raw shell or
// python-server panel is EXCLUDED on purpose — injecting `[ADVISOR …]` + Enter
// there would execute the line as a shell command. claude-code is excluded
// (its own PreCompact/memory hooks own that channel); web-chat has no PTY.
const ADVISORY_AGENT_TYPES = new Set(['codex', 'gemini', 'grok', 'antigravity']);

const MAX_PAYLOAD_CHARS = 480; // ≤120 tokens at ~4 chars/token

// ---- doctrine resolution (T1's registry; fail-soft null-object) ----------

// The advisor no-ops cleanly when T1's registry module is absent, unreadable,
// or throws (matches the "delete the registry file → no-op with one logged
// warning" acceptance). The repo-root module lives at <repo>/doctrine/index.js
// (four levels up from packages/server/src/advisor/).
const NULL_DOCTRINE = {
  loadDoctrine() { return []; },
  shouldNotify() { return { ok: true }; },
  recordGateEvent() { /* no-op */ },
};

let _doctrineCache;        // undefined = unresolved; else module-or-stub
let _doctrineWarned = false;

function resolveDoctrine() {
  if (_doctrineCache !== undefined) return _doctrineCache;
  try {
    // eslint-disable-next-line global-require
    _doctrineCache = require('../../../../doctrine');
    if (!_doctrineCache || typeof _doctrineCache.loadDoctrine !== 'function') {
      throw new Error('doctrine module missing loadDoctrine');
    }
  } catch (err) {
    if (!_doctrineWarned) {
      console.warn('[advisor] doctrine registry not available — advisor no-ops (fail-soft):', err.message);
      _doctrineWarned = true;
    }
    _doctrineCache = NULL_DOCTRINE;
  }
  return _doctrineCache;
}

// test seams
function _setDoctrineForTest(mod) { _doctrineCache = mod; _doctrineWarned = false; }
function _resetDoctrineForTest() { _doctrineCache = undefined; _doctrineWarned = false; }

// ---- helpers ------------------------------------------------------------

function truncate(s, n) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

function nowMsOf(deps) {
  return deps && typeof deps.now === 'number' ? deps.now : Date.now();
}

function nowIso(deps) {
  return new Date(nowMsOf(deps)).toISOString();
}

// Mirror the flashback `question` shape so the registry matches the same text.
function buildErrorText(session, ctx) {
  const type = (session.meta && session.meta.type) || 'shell';
  const lastCommand = (ctx && ctx.lastCommand) || '';
  const tail = (ctx && ctx.tail) || '';
  return `${type} error ${lastCommand} ${tail}`.trim();
}

// Stable error signature for once-per-(session,dedupe). Strips the volatile
// bits (addresses, paths, numbers, quotes) so the SAME class of error collapses
// to one key across fires.
function dedupeKeyFor(errorText) {
  return String(errorText || '')
    .toLowerCase()
    .replace(/\x1b\[[0-9;?]*[a-z]/gi, ' ') // residual ANSI
    .replace(/0x[0-9a-f]+/g, '0xX')        // hex addresses
    .replace(/\/[^\s:]+/g, '/PATH')        // file paths
    .replace(/\b\d+\b/g, 'N')              // numbers
    .replace(/['"`]/g, '')                 // quotes
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'empty';
}

function isAdvisoryTarget(session) {
  if (!session || !session.meta) return false;
  if (!session.pty) return false;
  return ADVISORY_AGENT_TYPES.has(session.meta.type);
}

// Is this entry's trigger event-class T-ERR? T1 compiles `trigger` as an ARRAY
// (e.g. ["T-ERR"]) or the sentinel 'always'; loadDoctrine({event:'T-ERR'})
// already filters to these, but matchEntry is also unit-tested with hand-built
// entries, so the guard is array-aware to avoid wrongly skipping array triggers.
function isErrTrigger(t) {
  if (t == null) return true; // unfiltered ⇒ allow
  if (t === 'T-ERR' || t === 'always') return true;
  if (Array.isArray(t)) return t.includes('T-ERR') || t.includes('always');
  return false;
}

// First registry entry whose regex check matches the error text. Prefers T1's
// pre-compiled `_checkRegex` (built from check.pattern + check.flags by
// compileTrigger); falls back to compiling check.regex/check.pattern for
// hand-built test entries. Skips non-regex checks (manual/script/sql are not
// error-text matchers).
function matchEntry(entries, errorText) {
  if (!Array.isArray(entries)) return null;
  const text = String(errorText || '');
  for (const e of entries) {
    if (!e || !e.id) continue;
    if (!isErrTrigger(e.trigger)) continue;
    const check = e.check || {};
    if (check.type && check.type !== 'regex') continue;
    let re = (e._checkRegex instanceof RegExp) ? e._checkRegex : null;
    if (!re) {
      const pat = check.regex != null ? check.regex : check.pattern;
      if (!pat) continue;
      try { re = pat instanceof RegExp ? pat : new RegExp(pat, check.flags || 'i'); } catch (_e) { continue; }
    }
    // _checkRegex may be global if T1 ever sets the 'g' flag — reset lastIndex
    // so a stateful regex can't skip a match on reuse.
    if (re.global) re.lastIndex = 0;
    if (re.test(text)) return e;
  }
  return null;
}

// Effective per-entry (per-rule) cooldown in ms: the registry entry's
// advisory.cooldown_hours when present, else the suppress.js 24h default.
function entryCooldownMs(entry) {
  const h = entry && entry.advisory
    && (entry.advisory.cooldown_hours != null ? entry.advisory.cooldown_hours : entry.advisory.cooldownHours);
  const n = Number(h);
  return Number.isFinite(n) && n > 0 ? n * 60 * 60 * 1000 : undefined;
}

// Build the ≤120-tok advisory payload from the registry entry. Never echoes the
// live error tail (A11 — that text could carry a secret); the one_line comes
// from the (forbidden-string-screened) registry entry only.
function buildPayload(entry, ruleId) {
  const adv = (entry && entry.advisory) || {};
  const oneLine = String(adv.one_line || adv.oneLine || (entry && entry.title) || 'advisory')
    .replace(/\s+/g, ' ').trim();
  const proc = adv.procedure_path || adv.procedurePath || '';
  let payload = `[ADVISOR ${ruleId}] ${oneLine}.`;
  if (proc) payload += ` Procedure: ${proc}.`;
  payload += ` ADV-ACK ${ruleId} optional.`;
  return payload.replace(/[\r\n]+/g, ' ').slice(0, MAX_PAYLOAD_CHARS);
}

function makeDeliveryDeps(session) {
  return {
    // status string (deliver.js's idle gate reads it directly)
    getStatus: () => (session.meta && session.meta.status) || null,
    // Deliver via the SHARED server-sequenced submit (pty-submit.js) — the same
    // code path POST /input {submit:true} uses. The advisory line is the paste
    // BODY (bracketed-paste wrapped, exactly as a {submit:true} sprint-inject
    // caller wraps its text); the submit mechanism (body→settle→lone \r) is the
    // shared helper, NOT reimplemented here.
    submitText: (text) => submitToPty(session, `\x1b[200~${text}\x1b[201~`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    sendToast: (obj) => {
      try {
        if (session.ws && session.ws.readyState === 1) session.ws.send(JSON.stringify(obj));
      } catch (_e) { /* fail-soft */ }
    },
  };
}

// ---- advisory_events store ----------------------------------------------

function recordAdvisoryEvent(db, ev) {
  if (!db) return null;
  try {
    const firedAt = ev.firedAt || new Date().toISOString();
    const r = db.prepare(`
      INSERT INTO advisory_events
        (fired_at, session_id, project, rule_id, dedupe_key, error_text,
         delivered, suppressed_reason, agent_injected, acked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      firedAt,
      ev.sessionId,
      ev.project || null,
      ev.ruleId,
      ev.dedupeKey,
      truncate(ev.errorText, 1000),
      ev.delivered ? 1 : 0,
      ev.suppressed_reason || null,
      ev.agent_injected ? 1 : 0,
      ev.createdAt || new Date().toISOString(),
    );
    return Number(r.lastInsertRowid);
  } catch (err) {
    console.warn('[advisor] recordAdvisoryEvent failed:', err.message);
    return null;
  }
}

function updateAdvisoryOutcome(db, id, fields) {
  if (!db || !id) return false;
  try {
    const r = db.prepare(`
      UPDATE advisory_events
         SET delivered = ?, agent_injected = ?, suppressed_reason = ?
       WHERE id = ?
    `).run(
      fields.delivered ? 1 : 0,
      fields.agent_injected ? 1 : 0,
      fields.suppressed_reason || null,
      Number(id),
    );
    return r.changes > 0;
  } catch (err) {
    console.warn('[advisor] updateAdvisoryOutcome failed:', err.message);
    return false;
  }
}

// Mark the most-recent delivered+unacked advisory for a rule as acked. Prefers
// the same-session row; falls back to any session so an ADV-ACK is never lost.
function markAcked(db, sessionId, ruleId, ackedAt) {
  if (!db || !ruleId) return false;
  try {
    const ts = ackedAt || new Date().toISOString();
    let row = null;
    if (sessionId) {
      row = db.prepare(
        `SELECT id FROM advisory_events
          WHERE rule_id = ? AND session_id = ? AND delivered = 1 AND acked_at IS NULL
          ORDER BY id DESC LIMIT 1`
      ).get(ruleId, sessionId);
    }
    if (!row) {
      row = db.prepare(
        `SELECT id FROM advisory_events
          WHERE rule_id = ? AND delivered = 1 AND acked_at IS NULL
          ORDER BY id DESC LIMIT 1`
      ).get(ruleId);
    }
    if (!row) return false;
    const r = db.prepare(`UPDATE advisory_events SET acked_at = ? WHERE id = ?`).run(ts, row.id);
    return r.changes > 0;
  } catch (err) {
    console.warn('[advisor] markAcked failed:', err.message);
    return false;
  }
}

function getRecentAdvisoryEvents(db, { since, limit } = {}) {
  if (!db) return [];
  try {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    const cols = `id, fired_at, session_id, project, rule_id, dedupe_key,
                  error_text, delivered, suppressed_reason, agent_injected,
                  acked_at, created_at`;
    if (since) {
      return db.prepare(
        `SELECT ${cols} FROM advisory_events
          WHERE fired_at >= ? ORDER BY fired_at DESC LIMIT ?`
      ).all(since, cap);
    }
    return db.prepare(
      `SELECT ${cols} FROM advisory_events ORDER BY fired_at DESC LIMIT ?`
    ).all(cap);
  } catch (err) {
    console.warn('[advisor] getRecentAdvisoryEvents failed:', err.message);
    return [];
  }
}

function getAdvisoryStats(db, { since, now } = {}) {
  const empty = {
    total: 0, delivered: 0, agent_injected: 0, acked: 0, suppressed: 0,
    suppressed_by_reason: {}, quarantines: [],
  };
  if (!db) return empty;
  try {
    const aggWhere = since ? `WHERE fired_at >= ?` : '';
    const aggArgs = since ? [since] : [];
    const agg = db.prepare(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN delivered = 1 THEN 1 ELSE 0 END) delivered,
             SUM(CASE WHEN agent_injected = 1 THEN 1 ELSE 0 END) agent_injected,
             SUM(CASE WHEN acked_at IS NOT NULL THEN 1 ELSE 0 END) acked,
             SUM(CASE WHEN delivered = 0 THEN 1 ELSE 0 END) suppressed
        FROM advisory_events ${aggWhere}
    `).get(...aggArgs);

    const reasonWhere = since
      ? `WHERE fired_at >= ? AND delivered = 0 AND suppressed_reason IS NOT NULL`
      : `WHERE delivered = 0 AND suppressed_reason IS NOT NULL`;
    const reasons = db.prepare(`
      SELECT suppressed_reason r, COUNT(*) c FROM advisory_events
       ${reasonWhere}
       GROUP BY suppressed_reason
    `).all(...aggArgs);

    const histo = {};
    for (const row of reasons) histo[row.r] = Number(row.c);

    return {
      total: Number((agg && agg.total) || 0),
      delivered: Number((agg && agg.delivered) || 0),
      agent_injected: Number((agg && agg.agent_injected) || 0),
      acked: Number((agg && agg.acked) || 0),
      suppressed: Number((agg && agg.suppressed) || 0),
      suppressed_by_reason: histo,
      quarantines: suppress.listActiveQuarantines(db, now),
    };
  } catch (err) {
    console.warn('[advisor] getAdvisoryStats failed:', err.message);
    return empty;
  }
}

// ---- ADV-ACK output scan (best-effort) ----------------------------------

const ADV_ACK_RE = /ADV-ACK\s+([A-Za-z0-9._:-]+)/gi;

// Extract every rule id from genuine `ADV-ACK <id>` occurrences in a chunk of
// agent output. Skips the injected payload's own `ADV-ACK <id> optional.`
// trailer — when we inject the advisory the TUI echoes the payload back into
// its output, and that echo literally contains "ADV-ACK <id> optional"; without
// this skip an inject would self-ACK. The trailer check is in code (not a regex
// lookahead) so the id token matches greedily with no backtracking surprises.
// Best-effort; never load-bearing.
function detectAdvAck(text) {
  const out = [];
  if (!text) return out;
  const s = String(text);
  let m;
  ADV_ACK_RE.lastIndex = 0;
  while ((m = ADV_ACK_RE.exec(s)) !== null) {
    if (!m[1]) continue;
    // Skip the payload echo "ADV-ACK <id> optional."
    if (/^\s+optional\b/i.test(s.slice(ADV_ACK_RE.lastIndex))) continue;
    out.push(m[1]);
  }
  return out;
}

// ---- the trigger entry --------------------------------------------------

// onTrigger(session, ctx, deps?) — called from the onErrorDetected handler for
// EVERY detected error (registry-only / Mnestra-independent, so it must NOT be
// gated behind the Mnestra-hit toast path). Synchronous up to the deliver
// decision (so the toast frame can read session._lastAdvisorMatch); delivery is
// fire-and-forget. Returns a small outcome object (with `_deliveryPromise` for
// tests) or null on no-op. NEVER throws.
//
// deps: { db, doctrine?, now?, delivery?, deliverOptions?, suppressOptions? }
function onTrigger(session, ctx, deps = {}) {
  try {
    if (!session || !session.meta) return null;
    if (!isAdvisoryTarget(session)) return null;

    const db = deps.db || null;
    const doctrine = deps.doctrine || resolveDoctrine();
    const cwd = session.meta.cwd;
    const project = session.meta.project || null;
    const errorText = buildErrorText(session, ctx);
    const dedupeKey = dedupeKeyFor(errorText);

    // registry-only match (A1 — no embedding/Mnestra call on the T-ERR path)
    let entries;
    try {
      entries = doctrine.loadDoctrine({ event: 'T-ERR', cwd, audience: 'all' }) || [];
    } catch (err) {
      console.warn('[advisor] loadDoctrine failed — no-op (fail-soft):', err && err.message);
      session._lastAdvisorMatch = { matched: false };
      return null;
    }
    const entry = matchEntry(entries, errorText);
    if (!entry) {
      session._lastAdvisorMatch = { matched: false };
      return null;
    }
    const ruleId = entry.id;
    const payload = buildPayload(entry, ruleId);

    // Per-entry cooldown honors the registry's advisory.cooldown_hours when set
    // (else suppress.js's 24h default). Tests can still override via suppressOptions.
    const suppressOptions = { ...(deps.suppressOptions || {}) };
    const cd = entryCooldownMs(entry);
    if (cd !== undefined && suppressOptions.perRuleCooldownMs === undefined) {
      suppressOptions.perRuleCooldownMs = cd;
    }

    const decision = suppress.shouldDeliver({
      db,
      sessionId: session.id,
      ruleId,
      dedupeKey,
      project,
      now: typeof deps.now === 'number' ? deps.now : undefined,
      doctrine,
      options: suppressOptions,
    });
    // Read synchronously by the proactive_memory toast frame (index.js): a
    // registry advisory matched + was routed to the agent. Final landed status
    // lives in advisory_events (delivery is async/idle-gated).
    session._lastAdvisorMatch = { matched: true, ruleId, willDeliver: decision.deliver };

    const delivery = deps.delivery || makeDeliveryDeps(session);

    // Non-silent quarantine signal (A12), once on the transition into it.
    if (decision.quarantineToast && typeof delivery.sendToast === 'function') {
      delivery.sendToast({
        type: 'advisor_quarantine',
        rule_id: decision.quarantineToast.ruleId,
        reason: decision.quarantineToast.reason,
        recurrences: decision.quarantineToast.recurrences,
        session_id: session.id,
      });
    }

    if (!decision.deliver) {
      recordAdvisoryEvent(db, {
        sessionId: session.id, project, ruleId, dedupeKey, errorText,
        delivered: 0, suppressed_reason: decision.reason, agent_injected: 0,
        firedAt: nowIso(deps),
      });
      return { matched: true, delivered: false, reason: decision.reason, ruleId };
    }

    // Optimistic delivered row up front so the once-per-(session,dedupe) +
    // rate counters are correct for the next trigger even before async delivery
    // resolves. Corrected (agent_injected, or reverted to suppressed) on resolve.
    const rowId = recordAdvisoryEvent(db, {
      sessionId: session.id, project, ruleId, dedupeKey, errorText,
      delivered: 1, suppressed_reason: null, agent_injected: 0,
      firedAt: nowIso(deps),
    });

    const _deliveryPromise = Promise.resolve()
      .then(() => deliver.injectAdvisory({
        getStatus: delivery.getStatus,
        submit: () => delivery.submitText(payload),
        sleep: delivery.sleep,
        options: deps.deliverOptions,
      }))
      .then((out) => {
        if (out && out.delivered) {
          updateAdvisoryOutcome(db, rowId, {
            delivered: 1, agent_injected: out.agentInjected ? 1 : 0, suppressed_reason: null,
          });
        } else {
          // queued-then-TTL-dropped or panel exited — revert the optimistic row.
          updateAdvisoryOutcome(db, rowId, {
            delivered: 0, agent_injected: 0, suppressed_reason: (out && out.reason) || 'inject_failed',
          });
        }
        return out;
      })
      .catch((err) => {
        console.warn('[advisor] delivery failed (fail-soft):', err && err.message);
        updateAdvisoryOutcome(db, rowId, { delivered: 0, agent_injected: 0, suppressed_reason: 'inject_error' });
        return { delivered: false, reason: 'inject_error' };
      });

    return { matched: true, delivered: true, ruleId, rowId, _deliveryPromise };
  } catch (err) {
    console.warn('[advisor] onTrigger threw (fail-soft):', err && err.message);
    return null;
  }
}

module.exports = {
  onTrigger,
  // store / routes helpers
  recordAdvisoryEvent,
  updateAdvisoryOutcome,
  markAcked,
  getRecentAdvisoryEvents,
  getAdvisoryStats,
  detectAdvAck,
  // pure helpers (exported for tests)
  buildErrorText,
  dedupeKeyFor,
  matchEntry,
  buildPayload,
  isAdvisoryTarget,
  ADVISORY_AGENT_TYPES,
  // doctrine seams
  resolveDoctrine,
  _setDoctrineForTest,
  _resetDoctrineForTest,
  NULL_DOCTRINE,
};
