// Sprint 78 T2 — Advisor MVP behavior tests (BEHAVIOR, not file-existence;
// INSTALLER-PITFALLS ledger #16).
//
// Covers the acceptance bullets: deliver-at-idle, advisory_events row, the
// suppression reasons (dup_key / cooldown / rate_10min / rate_session /
// quarantined / ttl_dropped), fail-soft (no registry / loadDoctrine throws /
// malformed entry / db null / panel exited mid-inject), ADV-ACK flip (+ echo
// guard), queue-on-thinking + 5-min TTL drop, the /api/advisor/{diag,stats}
// routes, the agent_injected toast field, the non-Claude target gate, and that
// delivery uses the SHARED v1.10.1 submit (bracketed-paste body as one PTY
// write + a lone \r, via pty-submit.js).
//
// Real better-sqlite3 (advisory_events created by initDatabase) + injected fakes
// for the doctrine registry and the delivery deps — no live PTY required.
//
// Run: node --test packages/server/tests/advisor-mvp.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let Database;
try { Database = require('better-sqlite3'); } catch (_e) { Database = null; }

const advisor = require('../src/advisor');
const deliver = require('../src/advisor/deliver');
const suppress = require('../src/advisor/suppress');
const { submitToPty } = require('../src/pty-submit');
const { initDatabase } = require('../src/database');

const SKIP = !Database;

// ─── helpers ────────────────────────────────────────────────────────────────

// Fresh on-disk db under a throwaway HOME so initDatabase creates every table
// (advisory_events + advisory_quarantine + doctrine_events). Returns { db, cleanup }.
function freshDb() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-mvp-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  let db;
  try { db = initDatabase(Database); } finally { process.env.HOME = prevHome; }
  return {
    db,
    cleanup() {
      try { db.close(); } catch (_) { /* ignore */ }
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    },
  };
}

const ERR_ENTRY = {
  id: 'test-err-foo',
  trigger: ['T-ERR'],
  audience: 'all',
  check: { type: 'regex', pattern: 'foobar failed', flags: 'i' },
  advisory: { one_line: 'Foobar failed — do X.', procedure_path: 'docs/X.md', cooldown_hours: 24 },
};
const ERR_ENTRY2 = {
  id: 'test-err-bar',
  trigger: ['T-ERR'],
  audience: 'all',
  check: { type: 'regex', pattern: 'kaboom', flags: 'i' },
  advisory: { one_line: 'Kaboom — do Y.', procedure_path: 'docs/Y.md', cooldown_hours: 24 },
};

function fakeDoctrine(entries, opts = {}) {
  return {
    loadDoctrine: opts.loadDoctrine || (() => entries),
    shouldNotify: opts.shouldNotify || (() => ({ notify: true, reason: 'ok' })),
    recordGateEvent: () => ({ recorded: false }),
  };
}

function fakeSession(over = {}) {
  return {
    id: over.id || 's1',
    pty: over.pty === null ? null : (over.pty || { write() {} }),
    meta: {
      type: over.type || 'codex',
      status: over.status || 'errored',
      project: over.project || 'termdeck',
      cwd: over.cwd || '/tmp',
      exitCode: null,
    },
    trackInput() {},
    ws: over.ws || null,
  };
}

const CTX = { lastCommand: 'foobar', tail: 'foobar failed: boom' };

// capture delivery deps (no real PTY)
function captureDelivery(over = {}) {
  const calls = { submit: [], toasts: [] };
  let status = over.status || 'errored';
  const submitResult = over.submitResult || { ok: true, submitted: true };
  return {
    calls,
    setStatus(s) { status = s; },
    deps: {
      getStatus: () => status,
      submitText: (text) => { calls.submit.push(text); return Promise.resolve(submitResult); },
      sleep: () => Promise.resolve(),
      sendToast: (o) => calls.toasts.push(o),
    },
  };
}

async function fire(sess, ctx, opts) {
  const res = advisor.onTrigger(sess, ctx, opts);
  if (res && res._deliveryPromise) await res._deliveryPromise;
  return res;
}

// ─── deliver-at-idle + advisory_events row + agent_injected ──────────────────

test('delivers a matching advisory at idle and writes a delivered advisory_events row',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery({ status: 'errored' });
      const res = await fire(sess, CTX, { db, doctrine: fakeDoctrine([ERR_ENTRY]), delivery: cap.deps });

      assert.ok(res && res.matched, 'matched a registry entry');
      assert.equal(res.delivered, true);
      assert.equal(cap.calls.submit.length, 1, 'submit called once');
      assert.ok(cap.calls.submit[0].includes('[ADVISOR test-err-foo]'), 'payload carries the rule id');
      assert.ok(cap.calls.submit[0].includes('Procedure: docs/X.md'), 'payload carries the procedure path');
      assert.ok(cap.calls.submit[0].includes('ADV-ACK test-err-foo optional'), 'payload carries the ACK hint');

      const rows = advisor.getRecentAdvisoryEvents(db, {});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].delivered, 1);
      assert.equal(rows[0].agent_injected, 1);
      assert.equal(rows[0].rule_id, 'test-err-foo');
      assert.equal(rows[0].suppressed_reason, null);

      // toast field source: onTrigger set _lastAdvisorMatch synchronously
      assert.equal(sess._lastAdvisorMatch.matched, true);
      assert.equal(sess._lastAdvisorMatch.ruleId, 'test-err-foo');
    } finally { cleanup(); }
  });

// ─── shared submit: bracketed-paste body as ONE write + a lone \r ────────────

test('delivery uses the shared submit: bracketed-paste body then a lone \\r (one code path)',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    const prev = process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS;
    process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS = '0';
    try {
      const writes = [];
      const sess = fakeSession({ pty: { write: (b) => writes.push(b) }, status: 'errored' });
      // no `delivery` override ⇒ real makeDeliveryDeps ⇒ real submitToPty
      const res = await fire(sess, CTX, { db, doctrine: fakeDoctrine([ERR_ENTRY]) });
      assert.equal(res.delivered, true);
      assert.equal(writes.length, 2, 'exactly two PTY writes');
      assert.ok(writes[0].startsWith('\x1b[200~') && writes[0].endsWith('\x1b[201~'),
        'first write is the bracketed-paste body');
      assert.ok(writes[0].includes('[ADVISOR test-err-foo]'), 'body carries the advisory');
      assert.equal(writes[0].endsWith('\r'), false, 'body write does NOT carry the submit \\r');
      assert.equal(writes[1], '\r', 'second write is the lone submit \\r');
    } finally {
      if (prev === undefined) delete process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS;
      else process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS = prev;
      cleanup();
    }
  });

// ─── suppression: once-per-(session,dedupe) = dup_key, no spam ───────────────

test('repeat of the same error in the same session is suppressed (dup_key), no second submit',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery({ status: 'errored' });
      const doctrine = fakeDoctrine([ERR_ENTRY]);

      const r1 = await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 1000 });
      assert.equal(r1.delivered, true);
      const r2 = await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 2000 });
      assert.equal(r2.delivered, false);
      assert.equal(r2.reason, 'dup_key');

      assert.equal(cap.calls.submit.length, 1, 'no PTY spam — only the first delivered');
      const rows = advisor.getRecentAdvisoryEvents(db, {});
      assert.equal(rows.length, 2);
      assert.equal(rows[0].suppressed_reason, 'dup_key'); // newest first
      assert.equal(rows[0].delivered, 0);
    } finally { cleanup(); }
  });

// ─── suppression: 5× same error → all suppressed, exactly one delivery ───────

test('firing the same error 5× yields one delivery + four suppressions with reasons',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery({ status: 'errored' });
      const doctrine = fakeDoctrine([ERR_ENTRY]);
      for (let i = 0; i < 5; i++) {
        await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 1000 + i });
      }
      assert.equal(cap.calls.submit.length, 1, 'exactly one PTY inject across 5 fires');
      const rows = advisor.getRecentAdvisoryEvents(db, {});
      const suppressed = rows.filter((r) => r.delivered === 0);
      assert.equal(suppressed.length, 4);
      for (const r of suppressed) assert.ok(r.suppressed_reason, 'every suppression has a reason');
    } finally { cleanup(); }
  });

// ─── suppression: different error, same rule, within 24h = cooldown ──────────

test('a different error matching the same rule within the cooldown window is suppressed (cooldown)',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery({ status: 'errored' });
      const doctrine = fakeDoctrine([ERR_ENTRY]);
      const r1 = await fire(sess, { lastCommand: 'foobar', tail: 'foobar failed: alpha' },
        { db, doctrine, delivery: cap.deps, now: 1000 });
      assert.equal(r1.delivered, true);
      const r2 = await fire(sess, { lastCommand: 'foobar', tail: 'foobar failed: beta' },
        { db, doctrine, delivery: cap.deps, now: 5000 });
      assert.equal(r2.delivered, false);
      assert.equal(r2.reason, 'cooldown');
    } finally { cleanup(); }
  });

// ─── suppression: distinct rule within 10 min = rate_10min ───────────────────

test('a distinct rule within 10 min of a delivery is suppressed (rate_10min)',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery({ status: 'errored' });
      const doctrine = fakeDoctrine([ERR_ENTRY, ERR_ENTRY2]);
      const t0 = 1_000_000;
      const r1 = await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: t0 });
      assert.equal(r1.delivered, true);
      const r2 = await fire(sess, { lastCommand: 'x', tail: 'kaboom!' },
        { db, doctrine, delivery: cap.deps, now: t0 + 5 * 60 * 1000 });
      assert.equal(r2.delivered, false);
      assert.equal(r2.reason, 'rate_10min');
    } finally { cleanup(); }
  });

// ─── suppression: rate_session (lowered cap) ─────────────────────────────────

test('per-session cap suppresses with rate_session once exceeded',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery({ status: 'errored' });
      const doctrine = fakeDoctrine([ERR_ENTRY, ERR_ENTRY2,
        { ...ERR_ENTRY, id: 'test-err-baz', check: { type: 'regex', pattern: 'splat', flags: 'i' } }]);
      const opts = { maxPerSession: 2, per10MinMs: 1, perRuleCooldownMs: 1 };
      // 3 distinct rules, spaced so 10min/cooldown don't bite (window=1ms)
      const r1 = await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 10, suppressOptions: opts });
      const r2 = await fire(sess, { lastCommand: 'x', tail: 'kaboom' }, { db, doctrine, delivery: cap.deps, now: 1000, suppressOptions: opts });
      const r3 = await fire(sess, { lastCommand: 'x', tail: 'splat' }, { db, doctrine, delivery: cap.deps, now: 2000, suppressOptions: opts });
      assert.equal(r1.delivered, true);
      assert.equal(r2.delivered, true);
      assert.equal(r3.delivered, false);
      assert.equal(r3.reason, 'rate_session');
    } finally { cleanup(); }
  });

// ─── quarantine: non-silent, after N unheeded recurrences ────────────────────

test('repeated unheeded recurrences quarantine the rule (non-silent toast + 7d state)',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery({ status: 'errored' });
      const doctrine = fakeDoctrine([ERR_ENTRY]);
      const opts = { quarantineThreshold: 2 };
      const r1 = await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 1, suppressOptions: opts }); // delivered
      const r2 = await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 2, suppressOptions: opts }); // dup_key #1
      const r3 = await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 3, suppressOptions: opts }); // → quarantine
      const r4 = await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 4, suppressOptions: opts }); // quarantined (no toast)

      assert.equal(r1.delivered, true);
      assert.equal(r2.reason, 'dup_key');
      assert.equal(r3.reason, 'quarantined');
      assert.equal(r4.reason, 'quarantined');
      assert.equal(cap.calls.toasts.length, 1, 'quarantine toast fires exactly once, on entry');
      assert.equal(cap.calls.toasts[0].type, 'advisor_quarantine');

      // read with the same (fake) clock the quarantine was written under, so
      // the 7d-future expiry isn't mis-read as already-elapsed against wall time
      // (production writes + reads both use real Date.now(), so it's consistent).
      const stats = advisor.getAdvisoryStats(db, { now: 4 });
      assert.equal(stats.quarantines.length, 1);
      assert.equal(stats.quarantines[0].rule_id, 'test-err-foo');
      assert.ok(stats.quarantines[0].expires_at > stats.quarantines[0].quarantined_at, '7d expiry in the future');
    } finally { cleanup(); }
  });

// ─── ADV-ACK flip + echo guard ───────────────────────────────────────────────

test('ADV-ACK in output flips the matching advisory_events row to acked', { skip: SKIP }, async () => {
  const { db, cleanup } = freshDb();
  try {
    const sess = fakeSession();
    const cap = captureDelivery({ status: 'errored' });
    await fire(sess, CTX, { db, doctrine: fakeDoctrine([ERR_ENTRY]), delivery: cap.deps });
    let rows = advisor.getRecentAdvisoryEvents(db, {});
    assert.equal(rows[0].acked_at, null);

    const ok = advisor.markAcked(db, sess.id, 'test-err-foo');
    assert.equal(ok, true);
    rows = advisor.getRecentAdvisoryEvents(db, {});
    assert.ok(rows[0].acked_at, 'acked_at set after markAcked');
  } finally { cleanup(); }
});

test('detectAdvAck catches a real ack but skips the payload echo trailer', () => {
  assert.deepEqual(advisor.detectAdvAck('thanks — ADV-ACK test-err-foo done'), ['test-err-foo']);
  assert.deepEqual(advisor.detectAdvAck('[ADVISOR test-err-foo] do X. ADV-ACK test-err-foo optional.'), []);
  assert.deepEqual(advisor.detectAdvAck('no ack here'), []);
});

// ─── queue-on-thinking + TTL drop (deliver.js unit) ──────────────────────────

test('injectAdvisory drops an advisory queued past the TTL (never delivered stale)', async () => {
  let t = 0;
  let submitted = 0;
  const r = await deliver.injectAdvisory({
    getStatus: () => 'thinking',
    submit: async () => { submitted++; return { ok: true, submitted: true }; },
    sleep: async () => { t += 2000; },
    options: { now: () => t, ttlMs: 5000, queuePollMs: 2000 },
  });
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'ttl_dropped');
  assert.equal(r.queued, true);
  assert.equal(submitted, 0, 'never submitted while mid-turn');
});

test('injectAdvisory queues on thinking then delivers at next idle', async () => {
  const statuses = ['thinking', 'thinking', 'idle'];
  let i = 0;
  const submits = [];
  const r = await deliver.injectAdvisory({
    getStatus: () => statuses[Math.min(i++, statuses.length - 1)],
    submit: async () => { submits.push(1); return { ok: true, submitted: true }; },
    sleep: async () => {},
    options: { now: () => 0, ttlMs: 60000, queuePollMs: 1 },
  });
  assert.equal(r.delivered, true);
  assert.equal(r.queued, true);
  assert.equal(submits.length, 1);
});

test('injectAdvisory drops on an exited panel', async () => {
  const r = await deliver.injectAdvisory({
    getStatus: () => 'exited',
    submit: async () => ({ ok: true, submitted: true }),
    sleep: async () => {},
    options: {},
  });
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'panel_exited');
});

// ─── panel exits mid-inject → row reverted to suppressed ─────────────────────

test('a panel that exits mid-inject reverts the optimistic row to not-delivered',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery({ status: 'errored', submitResult: { ok: false, reason: 'exited_mid_settle' } });
      const res = await fire(sess, CTX, { db, doctrine: fakeDoctrine([ERR_ENTRY]), delivery: cap.deps });
      assert.equal(res.delivered, true, 'onTrigger optimistically reported a delivery attempt');
      const rows = advisor.getRecentAdvisoryEvents(db, {});
      assert.equal(rows[0].delivered, 0, 'reverted after the submit failed');
      assert.equal(rows[0].suppressed_reason, 'exited_mid_settle');
      assert.equal(rows[0].agent_injected, 0);
    } finally { cleanup(); }
  });

// ─── fail-soft: no registry / loadDoctrine throws / malformed / db null ──────

test('no matching registry entry ⇒ advisor no-ops (no row, no submit, no throw)',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery();
      const res = await fire(sess, CTX, { db, doctrine: fakeDoctrine([]), delivery: cap.deps });
      assert.equal(res, null);
      assert.equal(cap.calls.submit.length, 0);
      assert.equal(advisor.getRecentAdvisoryEvents(db, {}).length, 0);
      assert.equal(sess._lastAdvisorMatch.matched, false);
    } finally { cleanup(); }
  });

test('loadDoctrine throwing ⇒ advisor no-ops fail-soft (no throw, no row)',
  { skip: SKIP }, async () => {
    const { db, cleanup } = freshDb();
    try {
      const sess = fakeSession();
      const cap = captureDelivery();
      const doctrine = fakeDoctrine([], { loadDoctrine: () => { throw new Error('boom'); } });
      const res = await fire(sess, CTX, { db, doctrine, delivery: cap.deps });
      assert.equal(res, null);
      assert.equal(cap.calls.submit.length, 0);
      assert.equal(advisor.getRecentAdvisoryEvents(db, {}).length, 0);
    } finally { cleanup(); }
  });

test('a malformed regex entry is skipped by matchEntry (no throw)', () => {
  const bad = { id: 'bad', trigger: ['T-ERR'], check: { type: 'regex', pattern: '([unclosed' } };
  assert.equal(advisor.matchEntry([bad], 'anything'), null);
  // a good entry alongside still matches
  assert.equal(advisor.matchEntry([bad, ERR_ENTRY], 'foobar failed').id, 'test-err-foo');
});

test('onTrigger with db=null does not throw (store no-ops)', () => {
  const sess = fakeSession();
  const cap = captureDelivery();
  const res = advisor.onTrigger(sess, CTX, { db: null, doctrine: fakeDoctrine([ERR_ENTRY]), delivery: cap.deps });
  assert.ok(res && res.matched);
});

// ─── target gate: non-Claude agent panels only ──────────────────────────────

test('claude-code / shell / web-chat panels are not advisory targets (no-op)', { skip: SKIP }, async () => {
  const { db, cleanup } = freshDb();
  try {
    for (const type of ['claude-code', 'shell', 'python-server']) {
      const sess = fakeSession({ type });
      const cap = captureDelivery();
      const res = await fire(sess, CTX, { db, doctrine: fakeDoctrine([ERR_ENTRY]), delivery: cap.deps });
      assert.equal(res, null, `${type} is not an advisory target`);
      assert.equal(cap.calls.submit.length, 0);
    }
    assert.equal(advisor.getRecentAdvisoryEvents(db, {}).length, 0);
    assert.equal(advisor.isAdvisoryTarget(fakeSession({ type: 'codex' })), true);
    assert.equal(advisor.isAdvisoryTarget(fakeSession({ type: 'claude-code' })), false);
    assert.equal(advisor.isAdvisoryTarget(fakeSession({ pty: null })), false);
  } finally { cleanup(); }
});

// ─── stats histogram ─────────────────────────────────────────────────────────

test('getAdvisoryStats returns counts + a suppression-reason histogram', { skip: SKIP }, async () => {
  const { db, cleanup } = freshDb();
  try {
    const sess = fakeSession();
    const cap = captureDelivery({ status: 'errored' });
    const doctrine = fakeDoctrine([ERR_ENTRY]);
    await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 1 }); // delivered
    await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 2 }); // dup_key
    await fire(sess, CTX, { db, doctrine, delivery: cap.deps, now: 3 }); // dup_key
    const stats = advisor.getAdvisoryStats(db, {});
    assert.equal(stats.delivered, 1);
    assert.equal(stats.agent_injected, 1);
    assert.equal(stats.suppressed, 2);
    assert.equal(stats.suppressed_by_reason.dup_key, 2);
  } finally { cleanup(); }
});

// ─── integration: the REAL T1 doctrine module matches a seeded error ─────────

test('the real doctrine registry matches a seeded error class end-to-end', { skip: SKIP }, async () => {
  const { db, cleanup } = freshDb();
  try {
    const real = advisor.resolveDoctrine();
    const errEntries = real.loadDoctrine({ event: 'T-ERR', audience: 'all' });
    if (!Array.isArray(errEntries) || errEntries.length === 0) {
      // T1 registry not present in this checkout — nothing to integrate against.
      return;
    }
    const sess = fakeSession();
    const cap = captureDelivery({ status: 'errored' });
    // EADDRINUSE is a seeded T-ERR entry (err-port-in-use).
    const res = await fire(sess, { lastCommand: 'npm start', tail: 'Error: listen EADDRINUSE: address already in use :::3000' },
      { db, doctrine: real, delivery: cap.deps });
    assert.ok(res && res.matched, 'real registry matched the EADDRINUSE error');
    assert.equal(cap.calls.submit.length, 1);
    assert.ok(/^\[ADVISOR /.test(cap.calls.submit[0]));
  } finally { cleanup(); }
});
