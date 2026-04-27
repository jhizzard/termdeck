// Tests for the two-stage submit pattern (Sprint 37 T4).
//
// Covers:
//   - Stage 1 sends bracketed-paste payloads with markers and NO trailing CR
//   - Settle window of 400ms between stages
//   - Stage 2 sends `\r` alone (its own write — never bundled with the paste)
//   - 250ms inter-session gap during each stage
//   - Verify polls until status:'thinking' or deadline
//   - Auto-poke (cr-flood) any lane that didn't reach 'thinking'
//
// Run: node --test tests/sprint-inject.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { injectSprintPrompts, DEFAULTS } = require('../packages/server/src/sprint-inject');

function makeMocks({ statusByCall = {}, throwOnWrite = null } = {}) {
  const writes = []; // { sessionId, bytes, t }
  const sleeps = []; // ms
  const t0 = Date.now();

  const writeBytes = async (sessionId, bytes) => {
    if (throwOnWrite && throwOnWrite(sessionId, bytes)) {
      throw new Error('boom');
    }
    writes.push({ sessionId, bytes, t: Date.now() - t0 });
    return { bytes: bytes.length };
  };

  // statusByCall: { [sessionId]: ['thinking', 'thinking', ...] }
  // pulled in order; default to 'active' when exhausted.
  const statusCursor = {};
  const getStatus = async (sessionId) => {
    const list = statusByCall[sessionId];
    if (!list) return { status: 'active' };
    const idx = statusCursor[sessionId] || 0;
    statusCursor[sessionId] = idx + 1;
    return { status: list[idx] || list[list.length - 1] || 'active' };
  };

  const sleep = async (ms) => {
    sleeps.push(ms);
    // No real wait so tests are fast — verify-poll deadline still works
    // because we use Date.now() and the deadline is short in fast-forward
    // scenarios. For verify tests we shrink verifyTimeoutMs explicitly.
  };

  return { writes, sleeps, writeBytes, getStatus, sleep };
}

test('stage 1 emits bracketed-paste payloads only (no trailing CR)', async () => {
  const sessionIds = ['s1', 's2', 's3', 's4'];
  const prompts = ['p1', 'p2', 'p3', 'p4'];
  const m = makeMocks();
  const result = await injectSprintPrompts({
    sessionIds,
    prompts,
    writeBytes: m.writeBytes,
    getStatus: m.getStatus,
    sleep: m.sleep,
    options: { verifyTimeoutMs: 0 }, // skip verify
  });

  // First 4 writes are pastes — start with `\x1b[200~` and end with `\x1b[201~`.
  for (let i = 0; i < 4; i++) {
    const w = m.writes[i];
    assert.equal(w.sessionId, sessionIds[i]);
    assert.ok(w.bytes.startsWith('\x1b[200~'), `paste ${i} should start with bracketed-paste open`);
    assert.ok(w.bytes.endsWith('\x1b[201~'), `paste ${i} should end with bracketed-paste close`);
    assert.ok(!w.bytes.includes('\r'), `paste ${i} must not contain CR (single-stage submit is BANNED)`);
    assert.ok(w.bytes.includes(prompts[i]), `paste ${i} should embed the prompt body`);
  }

  // Next 4 writes are submit-only `\r`.
  for (let i = 0; i < 4; i++) {
    const w = m.writes[4 + i];
    assert.equal(w.sessionId, sessionIds[i]);
    assert.equal(w.bytes, '\r', `submit ${i} must be a lone CR`);
  }

  assert.equal(result.ok, true);
  assert.equal(result.lanes.length, 4);
});

test('settle window of ~400ms between stages, 250ms inter-session gaps', async () => {
  const m = makeMocks();
  await injectSprintPrompts({
    sessionIds: ['a', 'b', 'c', 'd'],
    prompts: ['1', '2', '3', '4'],
    writeBytes: m.writeBytes,
    getStatus: m.getStatus,
    sleep: m.sleep,
    options: { verifyTimeoutMs: 0 },
  });

  // Sleep sequence:
  //   stage1 gaps: 250, 250, 250  (3 gaps between 4 sessions)
  //   settle: 400
  //   stage2 gaps: 250, 250, 250
  // (verify skipped via verifyTimeoutMs:0)
  const expected = [250, 250, 250, 400, 250, 250, 250];
  assert.deepEqual(m.sleeps.slice(0, expected.length), expected);
});

test('paste failure short-circuits submit for that lane only', async () => {
  const m = makeMocks({ throwOnWrite: (sid) => sid === 's2' });
  const result = await injectSprintPrompts({
    sessionIds: ['s1', 's2', 's3', 's4'],
    prompts: ['p1', 'p2', 'p3', 'p4'],
    writeBytes: m.writeBytes,
    getStatus: m.getStatus,
    sleep: m.sleep,
    options: { verifyTimeoutMs: 0 },
  });

  // s1, s3, s4 have submits; s2 doesn't.
  const submitsForS2 = m.writes.filter((w) => w.sessionId === 's2' && w.bytes === '\r');
  assert.equal(submitsForS2.length, 0, 's2 should be skipped after paste failure');

  const lane2 = result.lanes.find((l) => l.sessionId === 's2');
  assert.equal(lane2.paste.ok, false);
  assert.equal(lane2.submit.ok, false);
  assert.equal(lane2.submit.skipped, 'paste-failed');
  assert.equal(result.ok, false);
});

test('verify-and-poke: lane that never reaches thinking gets cr-flood poke', async () => {
  // s1 reaches 'thinking' immediately. s2 never does.
  const m = makeMocks({
    statusByCall: {
      s1: ['thinking'],
      s2: ['active', 'active', 'active', 'active', 'active', 'active', 'active'],
    },
  });
  const result = await injectSprintPrompts({
    sessionIds: ['s1', 's2'],
    prompts: ['p1', 'p2'],
    writeBytes: m.writeBytes,
    getStatus: m.getStatus,
    sleep: m.sleep,
    options: { verifyTimeoutMs: 50, verifyPollMs: 10 }, // short — sleep is no-op
  });

  // Look for the cr-flood write (\r\r\r) targeting s2.
  const flood = m.writes.find((w) => w.sessionId === 's2' && w.bytes === '\r\r\r');
  assert.ok(flood, 's2 should be cr-flood poked after failing to reach thinking');

  // s1 should NOT be poked — it verified.
  const floodS1 = m.writes.find((w) => w.sessionId === 's1' && w.bytes === '\r\r\r');
  assert.ok(!floodS1, 's1 verified — must not be poked');

  const lane1 = result.lanes.find((l) => l.sessionId === 's1');
  const lane2 = result.lanes.find((l) => l.sessionId === 's2');
  assert.equal(lane1.verified, true);
  assert.equal(lane1.poked, false);
  assert.equal(lane2.poked, true);
});

test('verify is skipped when getStatus is omitted', async () => {
  const m = makeMocks();
  const result = await injectSprintPrompts({
    sessionIds: ['s1'],
    prompts: ['hi'],
    writeBytes: m.writeBytes,
    sleep: m.sleep,
    // no getStatus
  });
  // Only paste + submit writes; no `\r\r\r` poke even though `verified` stays false.
  assert.equal(m.writes.length, 2);
  assert.equal(result.lanes[0].verified, false);
  assert.equal(result.lanes[0].poked, false);
});

test('input validation', async () => {
  const m = makeMocks();
  await assert.rejects(
    () =>
      injectSprintPrompts({
        sessionIds: ['s1', 's2'],
        prompts: ['only-one'],
        writeBytes: m.writeBytes,
        sleep: m.sleep,
      }),
    /must be the same length/,
  );
  await assert.rejects(
    () =>
      injectSprintPrompts({
        sessionIds: [],
        prompts: [],
        writeBytes: m.writeBytes,
        sleep: m.sleep,
      }),
    /at least one session/,
  );
  await assert.rejects(
    () =>
      injectSprintPrompts({
        sessionIds: ['s1'],
        prompts: ['p1'],
        sleep: m.sleep,
      }),
    /writeBytes/,
  );
});

test('DEFAULTS export remains stable', () => {
  // Lock the documented defaults — the inject mandate cites these values.
  assert.equal(DEFAULTS.gapMs, 250);
  assert.equal(DEFAULTS.settleMs, 400);
  assert.equal(DEFAULTS.verifyTimeoutMs, 8000);
});
