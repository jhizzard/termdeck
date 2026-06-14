'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureWebhookSecret, MNESTRA_WEBHOOK_SECRET_KEY } = require('../src/setup/ensure-webhook-secret');

assert.equal(MNESTRA_WEBHOOK_SECRET_KEY, 'MNESTRA_WEBHOOK_SECRET');

// Each test works in its own temp secrets file + restores the env var the
// module populates as a side effect, so tests stay order-independent.
function tmpSecrets(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ews-${name}-`));
  return path.join(dir, 'secrets.env');
}
function withCleanEnv(fn) {
  const prior = process.env.MNESTRA_WEBHOOK_SECRET;
  delete process.env.MNESTRA_WEBHOOK_SECRET;
  try { return fn(); }
  finally {
    if (prior === undefined) delete process.env.MNESTRA_WEBHOOK_SECRET;
    else process.env.MNESTRA_WEBHOOK_SECRET = prior;
  }
}

test('generates a 64-hex secret, persists it, and populates process.env when absent', () => {
  withCleanEnv(() => {
    const p = tmpSecrets('gen');
    const r = ensureWebhookSecret(p);
    assert.equal(r.generated, true);
    assert.match(r.secret, /^[0-9a-f]{64}$/, 'secret is 32 bytes of hex');
    assert.equal(process.env.MNESTRA_WEBHOOK_SECRET, r.secret, 'current process gets the value');
    const onDisk = fs.readFileSync(p, 'utf8');
    assert.match(onDisk, /^MNESTRA_WEBHOOK_SECRET=/m, 'key is written to secrets.env');
    assert.ok(onDisk.includes(r.secret), 'the exact value is on disk');
  });
});

test('is idempotent — a second call returns the SAME secret, never regenerates', () => {
  withCleanEnv(() => {
    const p = tmpSecrets('idem');
    const first = ensureWebhookSecret(p);
    assert.equal(first.generated, true);
    // Simulate a fresh process (env not yet sourced) by clearing the var.
    delete process.env.MNESTRA_WEBHOOK_SECRET;
    const second = ensureWebhookSecret(p);
    assert.equal(second.generated, false, 'no regeneration on the second call');
    assert.equal(second.secret, first.secret, 'same value preserved');
    assert.equal(process.env.MNESTRA_WEBHOOK_SECRET, first.secret, 'env re-populated from the existing value');
    // Exactly one occurrence on disk — never appended twice.
    const occurrences = (fs.readFileSync(p, 'utf8').match(/^MNESTRA_WEBHOOK_SECRET=/mg) || []).length;
    assert.equal(occurrences, 1);
  });
});

test('merge-aware: preserves every other key already in secrets.env', () => {
  withCleanEnv(() => {
    const p = tmpSecrets('merge');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'SUPABASE_URL=https://example.supabase.co\nOPENAI_API_KEY=sk-test\n');
    const r = ensureWebhookSecret(p);
    assert.equal(r.generated, true);
    const onDisk = fs.readFileSync(p, 'utf8');
    assert.match(onDisk, /^SUPABASE_URL=https:\/\/example\.supabase\.co$/m, 'pre-existing key untouched');
    assert.match(onDisk, /^OPENAI_API_KEY=sk-test$/m, 'pre-existing key untouched');
    assert.match(onDisk, /^MNESTRA_WEBHOOK_SECRET=/m, 'new key appended');
  });
});

test('does NOT regenerate when the key already exists in the file', () => {
  withCleanEnv(() => {
    const p = tmpSecrets('exists');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'MNESTRA_WEBHOOK_SECRET=preset-operator-value\n');
    const r = ensureWebhookSecret(p);
    assert.equal(r.generated, false);
    assert.equal(r.secret, 'preset-operator-value');
    assert.equal(process.env.MNESTRA_WEBHOOK_SECRET, 'preset-operator-value');
  });
});

test('fail-soft: a write error returns { generated:false } and never throws', () => {
  withCleanEnv(() => {
    const p = tmpSecrets('failsoft');
    const explodingDotenv = {
      readSecrets: () => ({}),
      writeSecrets: () => { throw new Error('disk full'); },
    };
    let r;
    assert.doesNotThrow(() => { r = ensureWebhookSecret(p, { dotenv: explodingDotenv }); });
    assert.equal(r.generated, false);
    assert.equal(r.secret, null);
    assert.match(r.error, /disk full/);
  });
});
