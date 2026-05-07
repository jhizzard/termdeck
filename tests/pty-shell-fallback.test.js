// Sprint 59 T2 — Brad #5 fixture (Alpine no-zsh + Ubuntu apt-removed-zsh).
//
// Pins the fallback chain at packages/server/src/index.js:958 so the silent
// execvp(/bin/zsh) failure on a minimal Linux host can never regress. Tests
// the helper in isolation (no real pty.spawn); the live PTY assertion lives
// in Sprint 58's install-smoke-alpine + install-smoke-ubuntu Docker fixtures.
//
// Run: node --test tests/pty-shell-fallback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSpawnShell } = require('../packages/server/src/spawn-shell.js');

test('cmdTrim wins when set (e.g. user typed `/bin/bash` directly)', () => {
  assert.equal(resolveSpawnShell('/bin/bash', '', ''), '/bin/bash');
  assert.equal(resolveSpawnShell('/bin/bash', '/bin/zsh', '/bin/fish'), '/bin/bash');
});

test('configShell wins when cmdTrim is empty (config.yaml `shell: /bin/bash`)', () => {
  assert.equal(resolveSpawnShell('', '/bin/bash', ''), '/bin/bash');
  assert.equal(resolveSpawnShell('', '/bin/bash', '/bin/zsh'), '/bin/bash');
});

test('envShell wins when cmdTrim and configShell are both empty', () => {
  assert.equal(resolveSpawnShell('', '', '/bin/zsh'), '/bin/zsh');
});

test('falls back to /bin/sh when every input is empty (Alpine no-zsh, no $SHELL)', () => {
  assert.equal(resolveSpawnShell('', '', ''), '/bin/sh');
});

test('treats undefined identically to empty string in the chain', () => {
  assert.equal(resolveSpawnShell(undefined, undefined, undefined), '/bin/sh');
  assert.equal(resolveSpawnShell(undefined, '/bin/bash', undefined), '/bin/bash');
});

test('regression — never returns /bin/zsh as a hardcoded floor (was the bug)', () => {
  // Pre-Sprint-59 floor was `/bin/zsh`; on Alpine pty.spawn would silently
  // fail with execvp ENOENT. Post-fix, the floor is `/bin/sh` which is on
  // every POSIX system.
  assert.equal(resolveSpawnShell('', '', ''), '/bin/sh');
  assert.notEqual(resolveSpawnShell('', '', ''), '/bin/zsh');
});
