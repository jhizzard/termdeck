// Sprint 48 T4 deliverable 2 — PTY env-var propagation tests.
//
// Verifies ~/.termdeck/secrets.env is parsed correctly and merged into the
// child env when TermDeck spawns a PTY. The deterministic surface is the
// `readTermdeckSecretsForPty` helper exported from packages/server/src/index.js.
// A live-PTY integration test is included but skips gracefully when
// node-pty isn't available (the prebuilt fails to load on certain CI Linux
// images and we don't want red CI on a path the unit tests already cover).
//
// Run: node --test packages/server/tests/pty-env-propagation.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serverModule = require('../src/index.js');
const { readTermdeckSecretsForPty, _resetTermdeckSecretsCache } = serverModule;

// We can't easily inject a fake fs into the cached helper without a refactor,
// so the unit tests write to a real temp file and re-point HOME for the
// duration of the test. Each test resets the cache so reads are fresh.
function withTempSecrets(contents, fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-pty-env-'));
  fs.mkdirSync(path.join(tmpHome, '.termdeck'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.termdeck', 'secrets.env'), contents);
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  _resetTermdeckSecretsCache();
  try { return fn(tmpHome); }
  finally {
    process.env.HOME = origHome;
    _resetTermdeckSecretsCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
}

test('readTermdeckSecretsForPty parses concrete values from secrets.env', () => {
  withTempSecrets(
    'SUPABASE_URL=https://abc.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=key123\nOPENAI_API_KEY="quoted"\n',
    () => {
      const secrets = readTermdeckSecretsForPty();
      assert.equal(secrets.SUPABASE_URL, 'https://abc.supabase.co');
      assert.equal(secrets.SUPABASE_SERVICE_ROLE_KEY, 'key123');
      assert.equal(secrets.OPENAI_API_KEY, 'quoted');
    }
  );
});

test('readTermdeckSecretsForPty skips ${VAR} placeholders (Sprint 47.5 hotfix lesson)', () => {
  withTempSecrets(
    'SUPABASE_URL=${SUPABASE_URL}\nGOOD=actual\n',
    () => {
      const secrets = readTermdeckSecretsForPty();
      assert.equal(secrets.SUPABASE_URL, undefined);
      assert.equal(secrets.GOOD, 'actual');
    }
  );
});

test('readTermdeckSecretsForPty returns {} when secrets.env is absent', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-pty-env-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  _resetTermdeckSecretsCache();
  try {
    const secrets = readTermdeckSecretsForPty();
    assert.deepEqual(secrets, {});
  } finally {
    process.env.HOME = origHome;
    _resetTermdeckSecretsCache();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('readTermdeckSecretsForPty caches between calls (no extra disk reads)', () => {
  withTempSecrets('FOO=bar\n', (tmpHome) => {
    const first = readTermdeckSecretsForPty();
    // Mutate the file — the cached helper should still return the original value.
    fs.writeFileSync(path.join(tmpHome, '.termdeck', 'secrets.env'), 'FOO=baz\n');
    const second = readTermdeckSecretsForPty();
    assert.equal(first.FOO, 'bar');
    assert.equal(second.FOO, 'bar');
  });
});

// Live-PTY integration smoke. Skips when node-pty is unavailable so CI
// images without the prebuilt binary don't go red.
test('PTY child inherits SUPABASE_URL when secrets.env defines it', { skip: !canSpawnPty() }, async () => {
  await withTempSecretsAsync(
    'SUPABASE_URL=https://propagated.supabase.co\n',
    async () => {
      const captured = await runPtyAndCaptureEnv('SUPABASE_URL');
      assert.equal(captured.trim(), 'https://propagated.supabase.co');
    }
  );
});

function canSpawnPty() {
  try {
    require('@homebridge/node-pty-prebuilt-multiarch');
    return true;
  } catch (_e) {
    return false;
  }
}

async function withTempSecretsAsync(contents, fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-pty-env-'));
  fs.mkdirSync(path.join(tmpHome, '.termdeck'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.termdeck', 'secrets.env'), contents);
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  _resetTermdeckSecretsCache();
  try { return await fn(tmpHome); }
  finally {
    process.env.HOME = origHome;
    _resetTermdeckSecretsCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
}

// Spawns a real shell PTY, runs `node -p 'process.env.<VAR>'`, returns stdout.
// Mirrors the env-merge logic that spawnTerminalSession applies — keeping this
// in sync with the production code is the test's whole point.
function runPtyAndCaptureEnv(varName) {
  return new Promise((resolve, reject) => {
    const pty = require('@homebridge/node-pty-prebuilt-multiarch');
    const secrets = readTermdeckSecretsForPty();
    const childEnv = { ...process.env, ...secrets };
    // Mirror the same merge order spawnTerminalSession uses: process.env first,
    // then secrets fallback for absent keys.
    delete childEnv[varName]; // simulate parent env not having it
    if (secrets[varName]) childEnv[varName] = secrets[varName];

    const term = pty.spawn('node', ['-p', `process.env.${varName} || ''`], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: childEnv,
    });
    let buf = '';
    term.onData((d) => { buf += d; });
    term.onExit(() => resolve(buf.replace(/\r/g, '').trim()));
    setTimeout(() => { try { term.kill(); } catch (_e) {} reject(new Error('pty timeout')); }, 5000);
  });
}
