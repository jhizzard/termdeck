// ports-file.test.js — best-effort live-port registry (~/.termdeck/ports.json).
//
// The MCP bridge's panel tools resolve the live deck's API base from this
// file (packages/mcp-bridge/src/clients/termdeck-base.js), so the write side
// must: record { port, pid, startedAt } at listen-time, MERGE with other live
// decks, PRUNE dead-pid entries, replace a same-port entry, tolerate a
// corrupt file, and NEVER throw (fail-soft — registry trouble must not block
// server startup).
//
// Run: node --test packages/server/tests/ports-file.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { recordLivePort, readPortsFile, isPidAlive } = require('../src/ports-file.js');

function tmpPortsPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-ports-'));
  return path.join(dir, 'ports.json');
}

// killImpl seam: pids in `alive` succeed; everything else throws ESRCH.
function makeKill(alive) {
  return (pid) => {
    if (!alive.has(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  };
}

test('recordLivePort: writes { version: 1, decks: [{ port, pid, startedAt }] } and creates the directory', () => {
  const portsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-ports-')), 'nested', 'ports.json');
  const ok = recordLivePort(3001, { portsPath, pid: 4242, startedAt: '2026-07-31T12:00:00Z' });
  assert.equal(ok, true);
  const parsed = JSON.parse(fs.readFileSync(portsPath, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.decks, [{ port: 3001, pid: 4242, startedAt: '2026-07-31T12:00:00Z' }]);
});

test('recordLivePort: merges — a live deck on another port is kept', () => {
  const portsPath = tmpPortsPath();
  const killImpl = makeKill(new Set([111, 222]));
  recordLivePort(3000, { portsPath, pid: 111, startedAt: '2026-07-31T10:00:00Z', killImpl });
  recordLivePort(3001, { portsPath, pid: 222, startedAt: '2026-07-31T11:00:00Z', killImpl });
  const decks = readPortsFile(portsPath);
  assert.equal(decks.length, 2);
  assert.deepEqual(decks.map((d) => d.port).sort(), [3000, 3001]);
});

test('recordLivePort: prunes dead-pid entries and replaces a same-port entry', () => {
  const portsPath = tmpPortsPath();
  const killImpl = makeKill(new Set([333]));
  fs.writeFileSync(portsPath, JSON.stringify({ version: 1, decks: [
    { port: 3000, pid: 111, startedAt: '2026-07-30T10:00:00Z' }, // dead → pruned
    { port: 3001, pid: 999, startedAt: '2026-07-30T11:00:00Z' }, // same port → replaced
  ] }));
  recordLivePort(3001, { portsPath, pid: 333, startedAt: '2026-07-31T12:00:00Z', killImpl });
  const decks = readPortsFile(portsPath);
  assert.deepEqual(decks, [{ port: 3001, pid: 333, startedAt: '2026-07-31T12:00:00Z' }]);
});

test('recordLivePort: a corrupt registry is tolerated and overwritten', () => {
  const portsPath = tmpPortsPath();
  fs.writeFileSync(portsPath, '{definitely not json');
  assert.equal(recordLivePort(3002, { portsPath, pid: 55, startedAt: '2026-07-31T12:00:00Z' }), true);
  assert.deepEqual(readPortsFile(portsPath).map((d) => d.port), [3002]);
});

test('recordLivePort: FAIL-SOFT — unwritable path returns false, never throws', () => {
  // A regular FILE where the parent directory should be → mkdirSync ENOTDIR.
  const blocker = tmpPortsPath();
  fs.writeFileSync(blocker, 'i am a file, not a directory');
  const portsPath = path.join(blocker, 'ports.json');
  let ok;
  assert.doesNotThrow(() => { ok = recordLivePort(3000, { portsPath, pid: 1 }); });
  assert.equal(ok, false);
});

test('recordLivePort: rejects junk ports without touching disk', () => {
  const portsPath = tmpPortsPath();
  assert.equal(recordLivePort(0, { portsPath }), false);
  assert.equal(recordLivePort(70000, { portsPath }), false);
  assert.equal(recordLivePort('3000', { portsPath }), false);
  assert.equal(fs.existsSync(portsPath), false);
});

test('readPortsFile: tolerates a bare array (defensive shape) and a missing file', () => {
  const portsPath = tmpPortsPath();
  assert.deepEqual(readPortsFile(portsPath), []);
  fs.writeFileSync(portsPath, JSON.stringify([{ port: 3099, pid: 7, startedAt: 'x' }]));
  assert.deepEqual(readPortsFile(portsPath).map((d) => d.port), [3099]);
});

test('isPidAlive: own pid alive; ESRCH dead; EPERM counts as alive; junk dead', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(123, makeKill(new Set())), false);
  assert.equal(isPidAlive(123, () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive('9'), false);
});
