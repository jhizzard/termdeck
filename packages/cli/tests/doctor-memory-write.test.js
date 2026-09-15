'use strict';

// Memory-write health check (2026-09-15).
//
// Regression anchor: on 2026-09-15 a fleet-wide "Mnestra has accepted no CLI
// write since Sept 5" incident was opened and escalated while the writes were
// in fact landing every day. The cause was vocabulary — benign content-hash
// dedup (HTTP 409 / SQLSTATE 23505) was logged as `supabase-insert-failed` and
// stamped `memory_items=fail`. These tests pin the distinction: a dup is NOT a
// failure, and the section never gates doctor's exit code.

const test = require('node:test');
const assert = require('node:assert');
const doctor = require('../src/doctor.js');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-15T12:00:00.000Z');

function line(ts, rest) { return `[${new Date(ts).toISOString()}] ${rest}`; }

test('_parseMemoryHookLog separates dedup no-ops from real failures', () => {
  const log = [
    line(NOW - 2 * HOUR, 'ingested: project="global" session=a factsExtracted=3 memory_items=ok memory_sessions=ok'),
    line(NOW - 3 * HOUR, 'memory-items-dup: content_hash already present — row is in the store (session=b)'),
    line(NOW - 4 * HOUR, 'pre-compact-snapshot-dup: content_hash already present — snapshot is in the store'),
    line(NOW - 5 * HOUR, 'supabase-insert-failed: HTTP 500 {"code":"XX000"}'),
    line(NOW - 6 * HOUR, 'openai-embed-failed: HTTP 429 {}'),
  ].join('\n');

  const r = doctor._parseMemoryHookLog(log, NOW);
  assert.strictEqual(r.dup, 2, 'both dup shapes counted as dedup');
  assert.strictEqual(r.realFail, 2, 'insert-failed + embed-failed counted as real');
  assert.strictEqual(r.lastOk, NOW - 2 * HOUR);
});

test('legacy pre-fix 409/23505 lines are classified as dedup, not failure', () => {
  // Hooks older than 2026-09-15 logged dedup with the `insert-failed` wording.
  // Reading those back as real failures would recreate the original confusion.
  const log = [
    line(NOW - 1 * HOUR, 'supabase-insert-failed: HTTP 409 {"code":"23505","details":"Key (content_hash)=(abc) already exists."}'),
    line(NOW - 2 * HOUR, 'supabase-insert-failed: HTTP 409 {"code":"23514","details":"check violation"}'),
    line(NOW - 3 * HOUR, 'supabase-insert-failed: HTTP 500 {"code":"XX000"}'),
  ].join('\n');
  const r = doctor._parseMemoryHookLog(log, NOW);
  assert.strictEqual(r.dup, 1, 'only the 23505 line is dedup');
  assert.strictEqual(r.realFail, 2, 'a non-23505 409 and a 500 stay real failures');
});

test('_parseMemoryHookLog ignores entries outside the 7d window', () => {
  const log = [
    line(NOW - 2 * HOUR, 'supabase-insert-failed: HTTP 500 {}'),
    line(NOW - 30 * 24 * HOUR, 'supabase-insert-failed: HTTP 500 {}'),
  ].join('\n');
  assert.strictEqual(doctor._parseMemoryHookLog(log, NOW).realFail, 1);
});

test('_parseMemoryHookLog: a dup alone does not refresh lastOk', () => {
  // A fleet that only ever re-ingests identical summaries is NOT proof the
  // write path is live — the 48h warning must still fire.
  const log = line(NOW - 1 * HOUR, 'memory-items-dup: content_hash already present');
  assert.strictEqual(doctor._parseMemoryHookLog(log, NOW).lastOk, null);
});

test('_parseMemoryHookLog tolerates junk and empty input', () => {
  const r = doctor._parseMemoryHookLog('not a log line\n\n[garbage] x\n', NOW);
  assert.deepStrictEqual([r.lastOk, r.dup, r.realFail], [null, 0, 0]);
  const e = doctor._parseMemoryHookLog('', NOW);
  assert.deepStrictEqual([e.lastOk, e.dup, e.realFail], [null, 0, 0]);
});

// ── _runMemoryWriteCheck ────────────────────────────────────────────────────

function fakeFs(contents) {
  const buf = Buffer.from(contents, 'utf8');
  return {
    existsSync: () => true,
    openSync: () => 1,
    fstatSync: () => ({ size: buf.length }),
    readSync: (fd, target, offset, len, pos) => { buf.copy(target, offset, pos, pos + len); return len; },
    closeSync: () => {},
  };
}

test('recent write → pass, and never gates the exit code', async () => {
  const log = line(NOW - 1 * HOUR, 'ingested: project="global" memory_items=ok memory_sessions=ok');
  const r = await doctor._runMemoryWriteCheck({ _fs: fakeFs(log), now: NOW, logPath: '/fake.log' });
  assert.strictEqual(r.skipped, false);
  assert.strictEqual(r.hasGaps, false, 'memory-write health must never gate exit');
  const lastOk = r.checks.find((c) => c.label === 'last successful memory_items write');
  assert.strictEqual(lastOk.status, 'pass');
});

test('write older than 48h → warn, still no exit gate', async () => {
  const log = line(NOW - 72 * HOUR, 'ingested: memory_items=ok memory_sessions=ok');
  const r = await doctor._runMemoryWriteCheck({ _fs: fakeFs(log), now: NOW, logPath: '/fake.log' });
  const lastOk = r.checks.find((c) => c.label === 'last successful memory_items write');
  assert.strictEqual(lastOk.status, 'warn');
  assert.match(lastOk.hint, /48h/);
  assert.strictEqual(r.hasGaps, false);
});

test('dedup-only noise does not produce a failure warning', async () => {
  const log = [
    line(NOW - 1 * HOUR, 'ingested: memory_items=ok memory_sessions=ok'),
    line(NOW - 2 * HOUR, 'memory-items-dup: content_hash already present'),
    line(NOW - 3 * HOUR, 'memory-items-dup: content_hash already present'),
  ].join('\n');
  const r = await doctor._runMemoryWriteCheck({ _fs: fakeFs(log), now: NOW, logPath: '/fake.log' });
  const outcomes = r.checks.find((c) => /write outcomes/.test(c.label));
  assert.strictEqual(outcomes.status, 'pass', 'dedup alone is healthy');
  assert.match(outcomes.detail, /2 dedup no-ops, 0 real failures/);
});

test('missing log file → skipped, not a failure', async () => {
  const r = await doctor._runMemoryWriteCheck({
    _fs: { existsSync: () => false }, now: NOW, logPath: '/nope.log',
  });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.hasGaps, false);
});

// ── staleness RPC guard ─────────────────────────────────────────────────────

test('undeployed memory_inbox_staleness() is a skip, never a warn', async () => {
  const client = { query: async () => { throw new Error('function public.memory_inbox_staleness() does not exist'); } };
  const probe = await doctor._probeInboxStaleness(client);
  assert.strictEqual(probe.available, false);
  assert.match(probe.reason, /not deployed/);

  const log = line(NOW - 1 * HOUR, 'ingested: memory_items=ok');
  const r = await doctor._runMemoryWriteCheck({
    _fs: fakeFs(log), now: NOW, logPath: '/fake.log', _pgClient: client,
  });
  const inbox = r.checks.find((c) => c.label === 'web-inbox staleness');
  assert.strictEqual(inbox.status, 'skip', 'doctor must still pass without the function');
  assert.strictEqual(r.hasGaps, false);
});

test('inbox stale beyond 72h warns; fresh passes', async () => {
  const log = line(NOW - 1 * HOUR, 'ingested: memory_items=ok');
  const mk = (rows) => doctor._runMemoryWriteCheck({
    _fs: fakeFs(log), now: NOW, logPath: '/fake.log', _pgClient: {},
    _probeInboxStaleness: async () => ({ available: true, rows }),
  });

  const stale = await mk([{ inbox_hours: 100 }]);
  assert.strictEqual(stale.checks.find((c) => c.label === 'web-inbox staleness').status, 'warn');
  assert.strictEqual(stale.hasGaps, false);

  const fresh = await mk([{ inbox_hours: 5 }]);
  assert.strictEqual(fresh.checks.find((c) => c.label === 'web-inbox staleness').status, 'pass');
});

test('per-agent staleness rows surface individually', async () => {
  const log = line(NOW - 1 * HOUR, 'ingested: memory_items=ok');
  const r = await doctor._runMemoryWriteCheck({
    _fs: fakeFs(log), now: NOW, logPath: '/fake.log', _pgClient: {},
    _probeInboxStaleness: async () => ({
      available: true,
      rows: [
        { inbox_hours: 2, source_agent: 'claude', agent_hours: 1 },
        { inbox_hours: 2, source_agent: 'codex', agent_hours: 200 },
      ],
    }),
  });
  assert.strictEqual(r.checks.find((c) => c.label === 'agent `claude` last write').status, 'pass');
  assert.strictEqual(r.checks.find((c) => c.label === 'agent `codex` last write').status, 'warn');
});

test('renderMemoryWriteResult prints without throwing in both states', () => {
  const c = new Proxy({}, { get: () => (s) => String(s) });
  assert.match(doctor.renderMemoryWriteResult({ skipped: true, reason: 'nope' }, c), /skipped/);
  const out = doctor.renderMemoryWriteResult({
    skipped: false, passed: 1, total: 2,
    checks: [
      { label: 'a', status: 'pass', detail: 'd' },
      { label: 'b', status: 'warn', hint: 'h' },
      { label: 'c', status: 'skip', hint: 'h' },
      { label: 'd', status: 'fail', hint: 'h' },
    ],
  }, c);
  assert.match(out, /Memory-write health/);
  assert.match(out, /1\/2 memory-write checks passed/);
});
