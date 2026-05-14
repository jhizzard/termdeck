// Sprint 64 T1 (ORCH SCOPE 16:29 ET item 4) — PTY env exclusion fence.
//
// Pins that management-grade tokens (Supabase PAT, GitHub PAT, OpenAI Admin
// key, NPM token) NEVER flow from ~/.termdeck/secrets.env into a spawned
// child PTY's env, even when an operator manually pastes one into the file
// post-install. Defense-in-depth complementing the T1 wizard's explicit
// non-persistence of `SUPABASE_ACCESS_TOKEN` (see
// `packages/cli/src/init.js` Phase 3 + the AUDIT-RED 16:26 resolution
// comment). Resolves T4-CODEX AUDIT-RED 2026-05-14 16:26 ET.
//
// Strategy: HOME-override harness via mkdtempSync — write a synthetic
// secrets.env containing both excluded keys AND legit per-project keys,
// reset the module-level cache, call `readTermdeckSecretsForPty()`, and
// assert the excluded keys are absent while the legit keys pass through.
//
// Run: node --test packages/cli/tests/spawn-env-exclusion.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readTermdeckSecretsForPty,
  _resetTermdeckSecretsCache,
  SECRETS_EXCLUDED_FROM_PTY,
} = require('../../server/src/index');

const fakeSupabasePat = () => 'sbp_' + 'a'.repeat(41);
const fakeNpmToken = () => 'npm_' + 'a'.repeat(16);

// ─────────────────────────────────────────────────────────────────────────
// HOME-override harness.

function withTempHome(secretsEnvContent, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-exclusion-test-'));
  fs.mkdirSync(path.join(tmp, '.termdeck'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.termdeck', 'secrets.env'), secretsEnvContent);
  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  _resetTermdeckSecretsCache();
  try {
    return fn(tmp);
  } finally {
    process.env.HOME = origHome;
    _resetTermdeckSecretsCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// EXCLUSION list shape.

test('SECRETS_EXCLUDED_FROM_PTY — contains SUPABASE_ACCESS_TOKEN (AUDIT-RED 16:26 closure)', () => {
  assert.ok(SECRETS_EXCLUDED_FROM_PTY instanceof Set);
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('SUPABASE_ACCESS_TOKEN'),
    'SUPABASE_ACCESS_TOKEN must be in PTY-env exclusion list');
});

test('SECRETS_EXCLUDED_FROM_PTY — contains GITHUB_TOKEN + GITHUB_PAT', () => {
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('GITHUB_TOKEN'));
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('GITHUB_PAT'));
});

test('SECRETS_EXCLUDED_FROM_PTY — contains OPENAI_ADMIN_KEY (distinct from per-project OPENAI_API_KEY)', () => {
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('OPENAI_ADMIN_KEY'));
  assert.ok(!SECRETS_EXCLUDED_FROM_PTY.has('OPENAI_API_KEY'),
    'OPENAI_API_KEY is per-project and MUST flow to the Mnestra hook env');
});

test('SECRETS_EXCLUDED_FROM_PTY — contains NPM_TOKEN', () => {
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('NPM_TOKEN'));
});

test('SECRETS_EXCLUDED_FROM_PTY — does NOT contain per-project keys (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL)', () => {
  assert.ok(!SECRETS_EXCLUDED_FROM_PTY.has('SUPABASE_URL'));
  assert.ok(!SECRETS_EXCLUDED_FROM_PTY.has('SUPABASE_SERVICE_ROLE_KEY'));
  assert.ok(!SECRETS_EXCLUDED_FROM_PTY.has('DATABASE_URL'));
  assert.ok(!SECRETS_EXCLUDED_FROM_PTY.has('ANTHROPIC_API_KEY'));
});

// ─────────────────────────────────────────────────────────────────────────
// readTermdeckSecretsForPty — filtering behavior.

test('readTermdeckSecretsForPty — drops SUPABASE_ACCESS_TOKEN when present in secrets.env (AUDIT-RED closure)', () => {
  withTempHome(
    [
      'SUPABASE_URL=https://abc.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=sb_secret_service_role_xyz12345',
      'DATABASE_URL=postgres://x:y@host:6543/postgres',
      'OPENAI_API_KEY=sk-proj-aaaaa',
      `SUPABASE_ACCESS_TOKEN=${fakeSupabasePat()}`,
    ].join('\n') + '\n',
    () => {
      const out = readTermdeckSecretsForPty();
      assert.ok(!('SUPABASE_ACCESS_TOKEN' in out),
        'SUPABASE_ACCESS_TOKEN must be filtered out');
      // Legit per-project keys pass through.
      assert.equal(out.SUPABASE_URL, 'https://abc.supabase.co');
      assert.equal(out.SUPABASE_SERVICE_ROLE_KEY, 'sb_secret_service_role_xyz12345');
      assert.equal(out.DATABASE_URL, 'postgres://x:y@host:6543/postgres');
      assert.equal(out.OPENAI_API_KEY, 'sk-proj-aaaaa');
    }
  );
});

test('readTermdeckSecretsForPty — drops GITHUB_TOKEN', () => {
  withTempHome(
    'SUPABASE_URL=https://x.supabase.co\nGITHUB_TOKEN=ghp_aaaa1234bbbb\n',
    () => {
      const out = readTermdeckSecretsForPty();
      assert.ok(!('GITHUB_TOKEN' in out));
      assert.equal(out.SUPABASE_URL, 'https://x.supabase.co');
    }
  );
});

test('readTermdeckSecretsForPty — drops OPENAI_ADMIN_KEY but keeps OPENAI_API_KEY', () => {
  withTempHome(
    'OPENAI_API_KEY=sk-proj-legit\nOPENAI_ADMIN_KEY=sk-admin-secret\n',
    () => {
      const out = readTermdeckSecretsForPty();
      assert.equal(out.OPENAI_API_KEY, 'sk-proj-legit', 'per-project key must pass through');
      assert.ok(!('OPENAI_ADMIN_KEY' in out), 'admin key must be filtered out');
    }
  );
});

test('readTermdeckSecretsForPty — drops NPM_TOKEN', () => {
  withTempHome(
    `NPM_TOKEN=${fakeNpmToken()}\nSUPABASE_URL=https://x.supabase.co\n`,
    () => {
      const out = readTermdeckSecretsForPty();
      assert.ok(!('NPM_TOKEN' in out));
      assert.equal(out.SUPABASE_URL, 'https://x.supabase.co');
    }
  );
});

test('readTermdeckSecretsForPty — empty secrets.env yields empty result (no exclusion-on-empty failure)', () => {
  withTempHome('', () => {
    const out = readTermdeckSecretsForPty();
    assert.deepEqual(out, {});
  });
});

test('readTermdeckSecretsForPty — missing secrets.env yields empty result', () => {
  const origHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-exclusion-test-missing-'));
  process.env.HOME = tmp;
  _resetTermdeckSecretsCache();
  try {
    const out = readTermdeckSecretsForPty();
    assert.deepEqual(out, {});
  } finally {
    process.env.HOME = origHome;
    _resetTermdeckSecretsCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
});

test('readTermdeckSecretsForPty — multi-exclusion + multi-passthrough in one file (mixed reality)', () => {
  withTempHome(
    [
      '# Comment line — should be skipped',
      'SUPABASE_URL=https://reality.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=sb_secret_real_service_key',
      'SUPABASE_ACCESS_TOKEN=sbp_should_NOT_be_in_pty_env',
      'GITHUB_TOKEN=ghp_should_NOT_be_in_pty_env',
      'OPENAI_API_KEY=sk-proj-real',
      'OPENAI_ADMIN_KEY=sk-admin_should_NOT_be_in_pty_env',
      'DATABASE_URL=postgres://x:y@host:5432/db',
      'NPM_TOKEN=npm_should_NOT_be_in_pty_env',
      'ANTHROPIC_API_KEY=sk-ant-real',
    ].join('\n') + '\n',
    () => {
      const out = readTermdeckSecretsForPty();
      // Excluded:
      assert.ok(!('SUPABASE_ACCESS_TOKEN' in out));
      assert.ok(!('GITHUB_TOKEN' in out));
      assert.ok(!('OPENAI_ADMIN_KEY' in out));
      assert.ok(!('NPM_TOKEN' in out));
      // Passthrough:
      assert.equal(out.SUPABASE_URL, 'https://reality.supabase.co');
      assert.equal(out.SUPABASE_SERVICE_ROLE_KEY, 'sb_secret_real_service_key');
      assert.equal(out.OPENAI_API_KEY, 'sk-proj-real');
      assert.equal(out.DATABASE_URL, 'postgres://x:y@host:5432/db');
      assert.equal(out.ANTHROPIC_API_KEY, 'sk-ant-real');
      // Verify NO excluded substring leaks anywhere.
      const serialized = JSON.stringify(out);
      assert.ok(!serialized.includes('should_NOT_be_in_pty_env'),
        'no excluded canary should appear anywhere in the output');
    }
  );
});
