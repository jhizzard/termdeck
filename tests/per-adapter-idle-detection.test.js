// Sprint 60 v1.0.14 — Item 1: per-adapter idle/parked status detection.
// Two layers of defense:
//   (a) Codex adapter end-of-turn terminator regex flips status -> idle on
//       the "─ Worked for Xm Ys ─" line.
//   (b) Session-level stale-status guard in toJSON() — if status is sticky
//       ('thinking'/'editing') and no PTY output has arrived for >30s, return
//       'idle' regardless of which adapter we're behind.

const test = require('node:test');
const assert = require('node:assert');

const codex = require('../packages/server/src/agent-adapters/codex');
const { Session } = require('../packages/server/src/session');

test('codex statusFor — END_OF_TURN flips to idle', () => {
  const samples = [
    '─ Worked for 2m 50s ──────────',
    '─ Worked for 0m 5s ─',
    '─ Worked for 14m 22s ────────────────',
    'some prefix\n─ Worked for 1m 0s ─\nsome suffix',
  ];
  for (const data of samples) {
    const result = codex.statusFor(data);
    assert.strictEqual(result?.status, 'idle', `expected idle for: ${data.slice(0, 40)}`);
    assert.strictEqual(result?.statusDetail, '', 'statusDetail should be empty for canonical idle');
  }
});

test('codex statusFor — END_OF_TURN wins over THINKING in same chunk', () => {
  // The exact failure mode Sprint 59 hit: a chunk arrives with both a final
  // "Working" spinner update and the closing "Worked for" separator.
  const data = 'Working 2m 49s\n─ Worked for 2m 50s ─';
  const result = codex.statusFor(data);
  assert.strictEqual(result?.status, 'idle');
});

test('codex statusFor — THINKING still wins over IDLE during a real turn', () => {
  // Mid-turn: spinner says "Thinking" or "Working" with no terminator.
  // Cascade should still report thinking.
  const result = codex.statusFor('Thinking 3s');
  assert.strictEqual(result?.status, 'thinking');
});

test('codex statusFor — bare codex prompt still maps to idle (no regression)', () => {
  // Pre-Sprint-60 IDLE behavior preserved.
  const result = codex.statusFor('codex\n');
  assert.strictEqual(result?.status, 'idle');
});

test('codex patterns — endOfTurn regex exported', () => {
  assert.ok(codex.patterns.endOfTurn instanceof RegExp);
  assert.ok(codex.patterns.endOfTurn.test('─ Worked for 1m 0s ─'));
  assert.ok(!codex.patterns.endOfTurn.test('Working 1s'));
});

// ── Session toJSON stale-status guard ────────────────────────────────────────

function makeSession(status, ageMs) {
  // Build a Session-like object that hits the same toJSON path.
  // Using the real class constructor would require the SQLite stack; for a
  // pure-JS unit we replicate just the meta + toJSON shape via prototype.
  const sess = Object.create(Session.prototype);
  sess.id = 'test-session-id';
  sess.pid = 12345;
  sess.meta = {
    status,
    statusDetail: 'Some detail',
    lastActivity: new Date(Date.now() - ageMs).toISOString(),
    type: 'codex',
  };
  return sess;
}

test('Session.toJSON — stale thinking flips to idle after threshold', () => {
  const sess = makeSession('thinking', Session.STALE_STATUS_THRESHOLD_MS + 1000);
  const json = sess.toJSON();
  assert.strictEqual(json.meta.status, 'idle');
  assert.strictEqual(json.meta.statusDetail, '');
});

test('Session.toJSON — stale editing flips to idle after threshold', () => {
  const sess = makeSession('editing', Session.STALE_STATUS_THRESHOLD_MS + 1000);
  const json = sess.toJSON();
  assert.strictEqual(json.meta.status, 'idle');
});

test('Session.toJSON — fresh thinking stays thinking', () => {
  const sess = makeSession('thinking', 5000); // 5s — well under threshold
  const json = sess.toJSON();
  assert.strictEqual(json.meta.status, 'thinking');
  assert.strictEqual(json.meta.statusDetail, 'Some detail');
});

test('Session.toJSON — non-sticky statuses pass through unchanged', () => {
  for (const status of ['active', 'idle', 'starting', 'errored', 'exited', 'listening']) {
    const sess = makeSession(status, Session.STALE_STATUS_THRESHOLD_MS + 1000);
    const json = sess.toJSON();
    assert.strictEqual(json.meta.status, status, `status=${status} should not be guarded`);
  }
});

test('Session.toJSON — does not mutate the underlying session.meta', () => {
  const sess = makeSession('thinking', Session.STALE_STATUS_THRESHOLD_MS + 1000);
  const json = sess.toJSON();
  // The serialized output reports idle...
  assert.strictEqual(json.meta.status, 'idle');
  // ...but the in-memory session is still 'thinking' so the next real PTY
  // chunk continues from where the analyzer left off without confusion.
  assert.strictEqual(sess.meta.status, 'thinking');
});

test('Session class statics — STICKY_STATUSES + STALE_STATUS_THRESHOLD_MS exposed', () => {
  assert.ok(Session.STICKY_STATUSES instanceof Set);
  assert.ok(Session.STICKY_STATUSES.has('thinking'));
  assert.ok(Session.STICKY_STATUSES.has('editing'));
  assert.strictEqual(typeof Session.STALE_STATUS_THRESHOLD_MS, 'number');
  assert.ok(Session.STALE_STATUS_THRESHOLD_MS >= 10000); // sane lower bound
});
