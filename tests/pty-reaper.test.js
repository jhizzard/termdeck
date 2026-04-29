// Tests for the PTY orphan reaper (Sprint 42 T2).
//
// All side-effects (`ps`, `kill`, `now`, the timer) are injected into the
// reaper factory so these tests run hermetically — no real processes get
// spawned or killed. The fake `ps` is a function returning the proc table
// the test wants the reaper to observe at this tick; tests advance the
// scenario by mutating that table between ticks.
//
// Run: node --test tests/pty-reaper.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const {
  createPtyReaper,
  parsePsOutput,
  RING_SIZE,
  DEFAULT_INTERVAL_MS,
} = require('../packages/server/src/pty-reaper');

// ----- helpers ------------------------------------------------------------

class FakeSessionManager {
  constructor() {
    this.sessions = new Map();
  }
  add(session) {
    this.sessions.set(session.id, session);
    return session;
  }
  remove(id) {
    return this.sessions.delete(id);
  }
  get(id) {
    return this.sessions.get(id);
  }
}

function fakeSession({ id, pid, status = 'active' }) {
  return { id, pid, meta: { status } };
}

function makePsTable(rows) {
  // rows: [{ pid, ppid, command }, ...]
  return [...rows];
}

function makeTrackedKill() {
  const calls = [];
  function kill(pid, signal) {
    calls.push({ pid, signal });
  }
  kill.calls = calls;
  return kill;
}

// ----- parsePsOutput ------------------------------------------------------

test('parsePsOutput parses pid/ppid/command lines', () => {
  const sample = [
    '  123     1 /sbin/launchd',
    '  456   123 /usr/bin/zsh -i',
    '  789   456 claude --resume',
    '',
    'garbage line',
    '   42    1 /usr/sbin/cron',
  ].join('\n');
  const rows = parsePsOutput(sample);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { pid: 123, ppid: 1, command: '/sbin/launchd' });
  assert.deepEqual(rows[1], { pid: 456, ppid: 123, command: '/usr/bin/zsh -i' });
  assert.deepEqual(rows[3], { pid: 42, ppid: 1, command: '/usr/sbin/cron' });
});

test('parsePsOutput tolerates empty stdout', () => {
  assert.deepEqual(parsePsOutput(''), []);
  assert.deepEqual(parsePsOutput('\n\n'), []);
});

// ----- registry refresh ---------------------------------------------------

test('tick() refreshes descendant set for sessions with a live leader', () => {
  const sessions = new FakeSessionManager();
  sessions.add(fakeSession({ id: 's1', pid: 100 }));
  sessions.add(fakeSession({ id: 's2', pid: 200 }));

  const psTable = makePsTable([
    { pid: 100, ppid: 1, command: '/bin/zsh' },
    { pid: 101, ppid: 100, command: 'claude' },
    { pid: 102, ppid: 101, command: 'rag-mcp' },
    { pid: 103, ppid: 101, command: 'imessage-mcp' },
    { pid: 200, ppid: 1, command: '/bin/zsh' },
    { pid: 201, ppid: 200, command: 'vim' },
  ]);

  const reaper = createPtyReaper({
    sessions,
    ps: () => psTable,
    kill: makeTrackedKill(),
    logger: { error: () => {} },
  });
  const result = reaper.tick();

  assert.equal(result.error, null);
  assert.equal(result.refreshed, 2);
  assert.equal(result.reaped, 0);

  const status = reaper.status();
  assert.equal(status.tickCount, 1);
  assert.equal(status.intervalMs, DEFAULT_INTERVAL_MS);

  const s1 = status.registry.find((r) => r.sessionId === 's1');
  assert.ok(s1, 's1 in registry');
  // BFS through 100 → 101 → {102, 103}
  assert.deepEqual(s1.descendantPids.sort((a, b) => a - b), [101, 102, 103]);

  const s2 = status.registry.find((r) => r.sessionId === 's2');
  assert.deepEqual(s2.descendantPids, [201]);
});

// ----- the headline scenario ---------------------------------------------

test('tick() reaps descendants that survive a dead leader (orphan path)', () => {
  const sessions = new FakeSessionManager();
  sessions.add(fakeSession({ id: 's1', pid: 100 }));

  // Tick 1: leader + descendants alive → registry refreshes
  let psTable = makePsTable([
    { pid: 100, ppid: 1, command: '/bin/zsh' },
    { pid: 101, ppid: 100, command: 'claude' },
    { pid: 102, ppid: 101, command: 'rag-mcp' },
    { pid: 103, ppid: 101, command: 'imessage-mcp' },
  ]);
  const kill = makeTrackedKill();
  const reaper = createPtyReaper({
    sessions,
    ps: () => psTable,
    kill,
    logger: { error: () => {} },
  });
  reaper.tick();
  assert.equal(reaper.status().registry.length, 1);

  // Tick 2: leader is gone (e.g. shell exited). Some descendants still alive
  // because they detached via setsid and got reparented to launchd (ppid=1).
  psTable = makePsTable([
    { pid: 102, ppid: 1, command: 'rag-mcp' },
    { pid: 103, ppid: 1, command: 'imessage-mcp' },
  ]);
  const result = reaper.tick();
  assert.equal(result.reaped, 2);

  // Both orphans signaled with SIGTERM, in the correct order.
  assert.equal(kill.calls.length, 2);
  for (const c of kill.calls) assert.equal(c.signal, 'SIGTERM');
  const reapedPids = kill.calls.map((c) => c.pid).sort((a, b) => a - b);
  assert.deepEqual(reapedPids, [102, 103]);

  // Reaped history captures each orphan with reason=leader_dead, outcome=signaled
  const status = reaper.status();
  assert.equal(status.reapedCount, 2);
  for (const entry of status.reapedHistory) {
    assert.equal(entry.sessionId, 's1');
    assert.equal(entry.ptyPid, 100);
    assert.equal(entry.reason, 'leader_dead');
    assert.equal(entry.outcome, 'signaled');
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
  }

  // Registry entry cleared after reap.
  assert.equal(status.registry.length, 0);

  // Tick 3: nothing left to do (the orphans are now dead in our scenario).
  psTable = makePsTable([]);
  const tick3 = reaper.tick();
  assert.equal(tick3.reaped, 0);
});

// ----- session.meta.status === 'exited' path -----------------------------

test("tick() reaps when session.meta.status flips to 'exited' even if leader pid still appears in ps", () => {
  const sessions = new FakeSessionManager();
  const sess = sessions.add(fakeSession({ id: 's1', pid: 100 }));

  let psTable = makePsTable([
    { pid: 100, ppid: 1, command: '/bin/zsh' },
    { pid: 101, ppid: 100, command: 'claude' },
    { pid: 102, ppid: 101, command: 'rag-mcp' },
  ]);
  const kill = makeTrackedKill();
  const reaper = createPtyReaper({ sessions, ps: () => psTable, kill, logger: { error: () => {} } });
  reaper.tick();
  assert.equal(reaper.status().registry.length, 1);

  // Session marked exited but PIDs still appear (zombie / lingering grace window).
  sess.meta.status = 'exited';
  const result = reaper.tick();
  assert.equal(result.reaped, 2);
  for (const entry of reaper.status().reapedHistory) {
    assert.equal(entry.reason, 'session_exited');
  }
});

// ----- session removed from manager ---------------------------------------

test('tick() reaps descendants of a session removed entirely from the manager', () => {
  const sessions = new FakeSessionManager();
  sessions.add(fakeSession({ id: 's1', pid: 100 }));

  let psTable = makePsTable([
    { pid: 100, ppid: 1, command: '/bin/zsh' },
    { pid: 101, ppid: 100, command: 'claude' },
  ]);
  const kill = makeTrackedKill();
  const reaper = createPtyReaper({ sessions, ps: () => psTable, kill, logger: { error: () => {} } });
  reaper.tick();

  // Drop the session entirely from the manager (e.g. DELETE /api/sessions/:id).
  sessions.remove('s1');
  // The leader pid happens to still appear (we can't control timing). Surviving
  // descendants should still be reaped, with reason=session_removed.
  const result = reaper.tick();
  assert.equal(result.reaped, 1);
  assert.equal(reaper.status().reapedHistory[0].reason, 'session_removed');
});

// ----- robustness ---------------------------------------------------------

test('tick() records ESRCH from kill() as already_dead, never throws', () => {
  const sessions = new FakeSessionManager();
  sessions.add(fakeSession({ id: 's1', pid: 100 }));

  let psTable = makePsTable([
    { pid: 100, ppid: 1, command: '/bin/zsh' },
    { pid: 101, ppid: 100, command: 'claude' },
  ]);
  const kill = (pid, signal) => {
    const err = new Error('No such process');
    err.code = 'ESRCH';
    throw err;
  };
  const reaper = createPtyReaper({ sessions, ps: () => psTable, kill, logger: { error: () => {} } });
  reaper.tick();

  psTable = makePsTable([{ pid: 101, ppid: 1, command: 'claude' }]);
  reaper.tick();
  const status = reaper.status();
  assert.equal(status.reapedCount, 1);
  assert.equal(status.reapedHistory[0].outcome, 'already_dead');
});

test('tick() records non-ESRCH kill failures as kill_failed', () => {
  const sessions = new FakeSessionManager();
  sessions.add(fakeSession({ id: 's1', pid: 100 }));

  let psTable = makePsTable([
    { pid: 100, ppid: 1, command: '/bin/zsh' },
    { pid: 101, ppid: 100, command: 'claude' },
  ]);
  const kill = () => {
    const err = new Error('Operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  const reaper = createPtyReaper({ sessions, ps: () => psTable, kill, logger: { error: () => {} } });
  reaper.tick();

  psTable = makePsTable([{ pid: 101, ppid: 1, command: 'claude' }]);
  reaper.tick();
  const last = reaper.status().reapedHistory[0];
  assert.equal(last.outcome, 'kill_failed');
  assert.match(last.error, /Operation not permitted/);
});

test('tick() survives ps() throwing — records lastError, no exception escapes', () => {
  const sessions = new FakeSessionManager();
  sessions.add(fakeSession({ id: 's1', pid: 100 }));
  const reaper = createPtyReaper({
    sessions,
    ps: () => { throw new Error('ps gone wrong'); },
    kill: makeTrackedKill(),
    logger: { error: () => {} },
  });
  const result = reaper.tick();
  assert.match(result.error, /ps gone wrong/);
  assert.equal(reaper.status().lastError, result.error);
});

// ----- ring buffer cap ----------------------------------------------------

test('reapedHistory caps at RING_SIZE — oldest entries get dropped', () => {
  const sessions = new FakeSessionManager();
  sessions.add(fakeSession({ id: 's1', pid: 100 }));

  // Refresh registry with N+10 descendants.
  const N = RING_SIZE;
  const live = [{ pid: 100, ppid: 1, command: '/bin/zsh' }];
  for (let i = 0; i < N + 10; i++) {
    live.push({ pid: 1000 + i, ppid: 100, command: `child-${i}` });
  }
  let psTable = makePsTable(live);
  const reaper = createPtyReaper({ sessions, ps: () => psTable, kill: () => {}, logger: { error: () => {} } });
  reaper.tick();
  assert.equal(reaper.status().registry[0].descendantPids.length, N + 10);

  // Tick 2: leader dies, all descendants survive → reaper kills all N+10.
  const after = [];
  for (let i = 0; i < N + 10; i++) after.push({ pid: 1000 + i, ppid: 1, command: `child-${i}` });
  psTable = makePsTable(after);
  reaper.tick();

  const status = reaper.status();
  assert.equal(status.reapedHistory.length, N);
  // First retained entry is the (N+10 - N)th = pid 1010
  assert.equal(status.reapedHistory[0].pid, 1010);
  assert.equal(status.reapedHistory[N - 1].pid, 1000 + N + 9);
});

// ----- start/stop idempotence + interval ---------------------------------

test('start()/stop() are idempotent and respect injected intervalMs', () => {
  const sessions = new FakeSessionManager();
  const reaper = createPtyReaper({
    sessions,
    intervalMs: 12345,
    ps: () => [],
    kill: makeTrackedKill(),
    logger: { error: () => {} },
  });
  assert.equal(reaper.status().intervalMs, 12345);
  reaper.start();
  reaper.start(); // double-start is a no-op
  reaper.stop();
  reaper.stop(); // double-stop is a no-op
});

test('_resetForTest() clears registry, history, and tick counters', () => {
  const sessions = new FakeSessionManager();
  sessions.add(fakeSession({ id: 's1', pid: 100 }));
  const reaper = createPtyReaper({
    sessions,
    ps: () => [{ pid: 100, ppid: 1, command: '/bin/zsh' }, { pid: 101, ppid: 100, command: 'c' }],
    kill: () => {},
    logger: { error: () => {} },
  });
  reaper.tick();
  assert.ok(reaper.status().tickCount > 0);
  reaper._resetForTest();
  const s = reaper.status();
  assert.equal(s.tickCount, 0);
  assert.equal(s.registry.length, 0);
  assert.equal(s.reapedCount, 0);
  assert.equal(s.lastTickAt, null);
});

// ----- HTTP route shape --------------------------------------------------

function listenOnce(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// Mirror the route handler shape from index.js so the test stays hermetic.
function attachStatusRoute(app, ptyReaper) {
  app.get('/api/pty-reaper/status', (req, res) => {
    if (!ptyReaper) return res.json({ enabled: false, reason: 'disabled-by-config' });
    res.json({ enabled: true, ...ptyReaper.status() });
  });
}

test('GET /api/pty-reaper/status returns enabled=false when reaper missing', async () => {
  const app = express();
  attachStatusRoute(app, null);
  const { server, port } = await listenOnce(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pty-reaper/status`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.reason, 'disabled-by-config');
  } finally {
    server.close();
  }
});

test('GET /api/pty-reaper/status returns the live status surface', async () => {
  const sessions = new FakeSessionManager();
  sessions.add(fakeSession({ id: 's1', pid: 100 }));
  const reaper = createPtyReaper({
    sessions,
    ps: () => [
      { pid: 100, ppid: 1, command: '/bin/zsh' },
      { pid: 101, ppid: 100, command: 'claude' },
    ],
    kill: () => {},
    logger: { error: () => {} },
  });
  reaper.tick();

  const app = express();
  attachStatusRoute(app, reaper);
  const { server, port } = await listenOnce(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pty-reaper/status`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.tickCount, 1);
    assert.equal(body.intervalMs, DEFAULT_INTERVAL_MS);
    assert.equal(body.registry.length, 1);
    assert.equal(body.registry[0].sessionId, 's1');
    assert.deepEqual(body.registry[0].descendantPids, [101]);
    assert.equal(body.reapedCount, 0);
    assert.deepEqual(body.reapedHistory, []);
  } finally {
    server.close();
  }
});

// ----- factory contract --------------------------------------------------

test('createPtyReaper throws when sessions argument is missing', () => {
  assert.throws(() => createPtyReaper({}), /sessions/);
});
