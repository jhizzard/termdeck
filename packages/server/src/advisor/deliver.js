'use strict';

// Sprint 78 T2 — Advisor MVP: the idle gate + queue/TTL around delivery.
//
// This module owns ONLY the advisor-specific scheduling: never interrupt a
// mid-turn panel, queue while it's busy, and drop an advisory that has waited
// longer than the TTL (stale delivery trains channel-blindness). The actual
// submit is NOT reimplemented here — it is the shared v1.10.1 server-sequenced
// submit (`pty-submit.js::submitToPty`, the same code path POST /input
// `{submit:true}` uses), injected by the caller as `submit()` (T4 audit 19:11 —
// "do NOT reimplement local bracketed-paste + lone-\r + cr-flood; share the
// production helper"). Pure logic — caller injects getStatus/submit/sleep (and
// an optional `now` clock) so tests never need a live PTY.

const DELIVER_DEFAULTS = {
  ttlMs: 5 * 60 * 1000, // A3 — drop advisories queued longer than ~5 min
  queuePollMs: 2000,
  // A panel in any of these states is mid-turn — NEVER interrupt; queue and
  // flush at the next deliverable poll. Everything else (idle, active,
  // listening, errored — the post-error "just finished, waiting" state
  // session.js forces) is deliverable.
  blockedStatuses: ['thinking', 'editing', 'starting'],
};

// Injectable wall clock so TTL logic is deterministic under test. Date.now is
// fine in normal server code (the no-Date.now rule is Workflow-script-scoped).
function clockOf(opts) {
  return (opts && typeof opts.now === 'function') ? opts.now : Date.now;
}

function isDeliverable(status, opts) {
  const blocked = (opts && opts.blockedStatuses) || DELIVER_DEFAULTS.blockedStatuses;
  if (!status) return true; // unknown ⇒ attempt (a missing status is not mid-turn)
  if (status === 'exited') return false;
  return !blocked.includes(status);
}

// Idle-gated delivery with queue-on-thinking + TTL drop (A3).
//
//   injectAdvisory({ getStatus, submit, sleep, options }) →
//     { delivered, agentInjected, queued, reason, finalStatus }
//
//   getStatus() → status string (or falsy ⇒ treated as deliverable)
//   submit()    → { ok, submitted, reason? }  (the shared server submit)
//   sleep(ms)   → Promise
//
// At trigger time the panel may be mid-turn ('thinking'/'editing'). We do NOT
// interrupt: poll until deliverable, then submit. If it stays mid-turn past
// ttlMs, drop ('ttl_dropped'). If it has exited, drop ('panel_exited').
async function injectAdvisory({ getStatus, submit, sleep, options }) {
  if (typeof submit !== 'function') throw new Error('submit() callback required');
  if (typeof sleep !== 'function') throw new Error('sleep(ms) callback required');
  const opts = { ...DELIVER_DEFAULTS, ...(options || {}) };
  const now = clockOf(opts);
  const start = now();
  let queued = false;

  // Safety bound so a no-op sleep + non-advancing clock can never spin forever.
  const maxPolls = Math.max(1, Math.ceil(opts.ttlMs / Math.max(1, opts.queuePollMs)) + 2);

  for (let polls = 0; polls < maxPolls; polls++) {
    let status = null;
    try {
      status = await getStatus();
    } catch (_e) { /* unknown ⇒ treat as deliverable below */ }

    if (status === 'exited') {
      return { delivered: false, agentInjected: false, queued, reason: 'panel_exited', finalStatus: status };
    }

    if (!isDeliverable(status, opts)) {
      queued = true;
      if (now() - start >= opts.ttlMs) {
        return { delivered: false, agentInjected: false, queued: true, reason: 'ttl_dropped', finalStatus: status };
      }
      await sleep(opts.queuePollMs);
      continue;
    }

    // Deliverable — hand off to the shared server-sequenced submit.
    let r;
    try {
      r = await submit();
    } catch (err) {
      r = { ok: false, reason: err && err.message ? err.message : String(err) };
    }
    return {
      delivered: !!(r && r.ok),
      agentInjected: !!(r && r.submitted),
      queued,
      reason: (r && r.ok) ? null : ((r && (r.reason || r.error)) || 'inject_failed'),
      finalStatus: status,
    };
  }

  // Exhausted the poll budget while still mid-turn ⇒ TTL drop.
  return { delivered: false, agentInjected: false, queued: true, reason: 'ttl_dropped', finalStatus: null };
}

module.exports = {
  injectAdvisory,
  isDeliverable,
  DELIVER_DEFAULTS,
};
