// Unit tests for packages/stack-installer/src/launcher.js — Sprint 48 T4.
//
// Tests focus on the deterministic helpers and the contract between
// startStack/stopStack/statusStack and their injected deps. We do NOT spawn
// real mnestra or termdeck processes — that path requires a real Supabase
// connection plus the global binaries on PATH and is too flaky for CI.
//
// Run: node --test packages/stack-installer/tests/launcher.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const launcher = require('../src/launcher');

// ─── readSecrets ───────────────────────────────────────────────────────

test('readSecrets parses KEY=value lines and strips quotes', () => {
  const fakeFs = {
    readFileSync: () => 'SUPABASE_URL=https://abc.supabase.co\nSUPABASE_SERVICE_ROLE_KEY="deadbeef"\nOTHER=\'single\'\n',
  };
  const secrets = launcher._readSecrets('/dev/null', fakeFs);
  assert.equal(secrets.SUPABASE_URL, 'https://abc.supabase.co');
  assert.equal(secrets.SUPABASE_SERVICE_ROLE_KEY, 'deadbeef');
  assert.equal(secrets.OTHER, 'single');
});

test('readSecrets skips ${VAR} placeholders so unwired env never bleeds through', () => {
  const fakeFs = {
    readFileSync: () => 'SUPABASE_URL=${SUPABASE_URL}\nGOOD=actual-value\n',
  };
  const secrets = launcher._readSecrets('/dev/null', fakeFs);
  assert.equal(secrets.SUPABASE_URL, undefined);
  assert.equal(secrets.GOOD, 'actual-value');
});

test('readSecrets ignores comments, blanks, and malformed lines', () => {
  const fakeFs = {
    readFileSync: () => '# a comment\n\nGOOD=yes\nnot-a-key-line\nALSO_GOOD=2\n',
  };
  const secrets = launcher._readSecrets('/dev/null', fakeFs);
  assert.deepEqual(Object.keys(secrets).sort(), ['ALSO_GOOD', 'GOOD']);
});

test('readSecrets returns {} when file is missing', () => {
  const fakeFs = {
    readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
  };
  const secrets = launcher._readSecrets('/dev/null', fakeFs);
  assert.deepEqual(secrets, {});
});

// ─── whichBinary ───────────────────────────────────────────────────────

test('whichBinary returns absolute path on success, null on failure', () => {
  const stubOk = () => ({ status: 0, stdout: '/usr/local/bin/mnestra\n' });
  const stubMissing = () => ({ status: 1, stdout: '' });
  assert.equal(launcher._whichBinary('mnestra', stubOk), '/usr/local/bin/mnestra');
  assert.equal(launcher._whichBinary('mnestra', stubMissing), null);
});

// ─── resolveMnestraInvocation ──────────────────────────────────────────

test('resolveMnestraInvocation prefers the global binary on PATH', () => {
  const result = launcher._resolveMnestraInvocation({
    whichBinary: () => '/usr/local/bin/mnestra',
    fs: { existsSync: () => false },
  });
  assert.deepEqual(result, { command: 'mnestra', args: ['serve'], origin: 'path' });
});

test('resolveMnestraInvocation falls back to engram dev checkout when binary missing', () => {
  const result = launcher._resolveMnestraInvocation({
    whichBinary: () => null,
    fs: { existsSync: () => true },
  });
  assert.equal(result.command, 'node');
  assert.ok(result.args[0].endsWith('mcp-server/index.js'));
  assert.equal(result.origin, 'dev-checkout');
});

test('resolveMnestraInvocation returns null when neither path exists', () => {
  const result = launcher._resolveMnestraInvocation({
    whichBinary: () => null,
    fs: { existsSync: () => false },
  });
  assert.equal(result, null);
});

// ─── PID file shape (stopStack contract) ───────────────────────────────

test('stopStack reports no-pidfile when ~/.termdeck/stack.pid is absent', async () => {
  const fakeFs = { existsSync: () => false };
  const result = await launcher.stopStack({ _deps: { fs: fakeFs, process: { kill: () => true } } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-pidfile');
});

test('stopStack signals each pid in the record and unlinks the file', async () => {
  const killed = [];
  let unlinked = false;
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ termdeckPid: 1111, mnestraPid: 2222, port: 3000 }),
    unlinkSync: () => { unlinked = true; },
  };
  const fakeProcess = { kill: (pid, sig) => { killed.push({ pid, sig }); return true; } };
  const result = await launcher.stopStack({ _deps: { fs: fakeFs, process: fakeProcess } });
  assert.equal(result.ok, true);
  // Each declared pid receives SIGTERM. Some may also receive signal 0 (alive
  // probe) or SIGKILL if the grace period found them still up — we only
  // require that SIGTERM was sent to both.
  const sigtermPids = killed.filter((k) => k.sig === 'SIGTERM').map((k) => k.pid).sort();
  assert.deepEqual(sigtermPids, [1111, 2222]);
  assert.equal(unlinked, true);
});
