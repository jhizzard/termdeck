// Sprint 51.5 T3 — Vault SQL-Editor URL builder + ensureVaultSecrets fallback.
//
// The Supabase Vault dashboard panel was quietly removed/relocated in
// current Supabase UIs (Brad 2026-05-03 takeaway #2; INSTALLER-PITFALLS.md
// Class B). Wizard text instructing users to "click Vault" is now broken.
// `vaultSqlEditorUrl()` builds the working manual surface — a SQL-Editor
// deeplink that pre-fills `select vault.create_secret('<value>', '<name>');`
// per missing secret. `ensureVaultSecrets()` calls vault.create_secret via
// pgRunner first; on permission failure it falls back to printing
// deeplinks per missing secret.
//
// These fixtures pin:
//   1. URL shape — host, project ref slot, encoded SQL parameter.
//   2. SQL-literal escape for single quotes in value or name.
//   3. ensureVaultSecrets:
//      - all-present probe → no-op, no deeplinks emitted.
//      - all-missing + auto-apply succeeds → both created via pgRunner.
//      - missing + auto-apply fails for one → deeplink emitted only for the
//        unrecovered name.
//      - probe itself fails → deeplinks for all required.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const initRumen = require(path.join(repoRoot, 'packages', 'cli', 'src', 'init-rumen.js'));
const vaultSqlEditorUrl = initRumen._vaultSqlEditorUrl;
const ensureVaultSecrets = initRumen._ensureVaultSecrets;

async function captureOutput(fn) {
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const stdout = [];
  const stderr = [];
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    const result = await fn();
    return { stdout: stdout.join(''), stderr: stderr.join(''), result };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
}

// Minimal pg client double. Resolves probe + create_secret calls per the
// scripted plan; otherwise throws.
function makePgClient(plan) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      // Probe path.
      if (/FROM\s+vault\.secrets/i.test(sql)) {
        if (plan.probeError) throw new Error(plan.probeError);
        return { rows: (plan.existingNames || []).map((name) => ({ name })) };
      }
      // create_secret path.
      if (/vault\.create_secret/i.test(sql)) {
        const [value, name] = params || [];
        if (plan.failOnNames && plan.failOnNames.has(name)) {
          throw new Error(plan.failError || 'permission denied for relation secrets');
        }
        return { rows: [{ create_secret: 'aaaa-bbbb' }] };
      }
      throw new Error('unexpected SQL in test pg client: ' + sql);
    },
    async end() { /* noop */ }
  };
}

// ── 1. vaultSqlEditorUrl shape ──────────────────────────────────────────────

test('vaultSqlEditorUrl: builds Supabase SQL-Editor deeplink with vault.create_secret pre-filled', () => {
  const url = vaultSqlEditorUrl('abc123', 'rumen_service_role_key', 'eyJhbGciOiJI');
  assert.match(url, /^https:\/\/supabase\.com\/dashboard\/project\/abc123\/sql\/new\?content=/);
  // Decode the content parameter and confirm the SQL.
  const content = decodeURIComponent(url.split('content=')[1]);
  assert.equal(content, "select vault.create_secret('eyJhbGciOiJI', 'rumen_service_role_key');");
});

test("vaultSqlEditorUrl: escapes single quotes in value and name (Postgres '' literal)", () => {
  const url = vaultSqlEditorUrl('xyz', "weird'name", "value-with-'-quote");
  const content = decodeURIComponent(url.split('content=')[1]);
  assert.equal(content, "select vault.create_secret('value-with-''-quote', 'weird''name');");
});

test('vaultSqlEditorUrl: throws on missing projectRef', () => {
  assert.throws(() => vaultSqlEditorUrl('', 'name', 'value'), /projectRef is required/);
  assert.throws(() => vaultSqlEditorUrl(null, 'name', 'value'), /projectRef is required/);
});

test('vaultSqlEditorUrl: handles null/undefined value or name as empty string', () => {
  const url = vaultSqlEditorUrl('abc', null, undefined);
  const content = decodeURIComponent(url.split('content=')[1]);
  assert.equal(content, "select vault.create_secret('', '');");
});

// ── 2. ensureVaultSecrets — all already present ─────────────────────────────

test('ensureVaultSecrets: both names already present → no-op success, no create_secret calls', async () => {
  const client = makePgClient({
    existingNames: ['rumen_service_role_key', 'graph_inference_service_role_key']
  });
  const secrets = { SUPABASE_SERVICE_ROLE_KEY: 'eyJ...' };
  const cap = await captureOutput(async () =>
    ensureVaultSecrets({ projectRef: 'abc', secrets, dryRun: false, _pgClient: client }));
  assert.equal(cap.result.ok, true);
  assert.deepEqual(cap.result.created, []);
  assert.deepEqual(cap.result.deeplinks, []);
  assert.equal(client.calls.length, 1, 'only the probe ran; no create_secret calls when all present');
  assert.match(client.calls[0].sql, /FROM\s+vault\.secrets/i);
  assert.match(cap.stdout, /both already present/);
});

// ── 3. ensureVaultSecrets — both missing + auto-apply succeeds ──────────────

test('ensureVaultSecrets: both missing + create_secret succeeds → both created, no deeplinks', async () => {
  const client = makePgClient({ existingNames: [] });
  const secrets = { SUPABASE_SERVICE_ROLE_KEY: 'eyJ.service.role' };
  const cap = await captureOutput(async () =>
    ensureVaultSecrets({ projectRef: 'abc', secrets, dryRun: false, _pgClient: client }));
  assert.equal(cap.result.ok, true);
  assert.deepEqual(cap.result.created.sort(),
    ['graph_inference_service_role_key', 'rumen_service_role_key']);
  assert.deepEqual(cap.result.deeplinks, []);
  // 1 probe + 2 create_secret invocations.
  assert.equal(client.calls.length, 3);
  const createCalls = client.calls.filter((c) => /vault\.create_secret/i.test(c.sql));
  assert.equal(createCalls.length, 2);
  // Both create_secret calls use the same value (the service_role JWT).
  for (const call of createCalls) {
    assert.equal(call.params[0], 'eyJ.service.role');
  }
  // Names match the two required secrets.
  const names = createCalls.map((c) => c.params[1]).sort();
  assert.deepEqual(names, ['graph_inference_service_role_key', 'rumen_service_role_key']);
});

// ── 4. ensureVaultSecrets — partial failure → deeplinks for unrecovered ─────

test('ensureVaultSecrets: one create_secret fails → deeplink emitted for that name only', async () => {
  const client = makePgClient({
    existingNames: [],
    failOnNames: new Set(['graph_inference_service_role_key']),
    failError: 'permission denied for schema vault'
  });
  const secrets = { SUPABASE_SERVICE_ROLE_KEY: 'eyJ.svc' };
  const cap = await captureOutput(async () =>
    ensureVaultSecrets({ projectRef: 'abc', secrets, dryRun: false, _pgClient: client }));
  assert.equal(cap.result.ok, false);
  assert.deepEqual(cap.result.created, ['rumen_service_role_key']);
  assert.equal(cap.result.deeplinks.length, 1);
  assert.equal(cap.result.deeplinks[0].name, 'graph_inference_service_role_key');
  assert.match(cap.result.deeplinks[0].url,
    /^https:\/\/supabase\.com\/dashboard\/project\/abc\/sql\/new\?content=/);
  assert.match(cap.result.deeplinks[0].error, /permission denied/);
  // The deeplink banner appears in stderr (so wizard step indicator on
  // stdout stays clean and the URLs are easy to find via shell scrollback).
  assert.match(cap.stderr, /Vault dashboard panel has been removed/);
  assert.match(cap.stderr, /graph_inference_service_role_key/);
});

// ── 5. ensureVaultSecrets — probe failure → all deeplinks ───────────────────

test('ensureVaultSecrets: vault.secrets probe fails → deeplinks for both required secrets', async () => {
  const client = makePgClient({ probeError: 'permission denied for schema vault' });
  const secrets = { SUPABASE_SERVICE_ROLE_KEY: 'eyJ' };
  const cap = await captureOutput(async () =>
    ensureVaultSecrets({ projectRef: 'abc', secrets, dryRun: false, _pgClient: client }));
  assert.equal(cap.result.ok, false);
  assert.equal(cap.result.error, 'vault-probe-failed');
  assert.equal(cap.result.deeplinks.length, 2);
  const names = cap.result.deeplinks.map((d) => d.name).sort();
  assert.deepEqual(names, ['graph_inference_service_role_key', 'rumen_service_role_key']);
});

// ── 6. ensureVaultSecrets — dry-run ─────────────────────────────────────────

test('ensureVaultSecrets: dry-run touches no pg client and returns ok', async () => {
  const calls = [];
  const client = {
    calls,
    query: () => { calls.push('query'); throw new Error('should not be called'); },
    end: () => {}
  };
  const secrets = { SUPABASE_SERVICE_ROLE_KEY: 'x' };
  const cap = await captureOutput(async () =>
    ensureVaultSecrets({ projectRef: 'abc', secrets, dryRun: true, _pgClient: client }));
  assert.equal(cap.result.ok, true);
  assert.equal(calls.length, 0);
  assert.match(cap.stdout, /\(dry-run\)/);
});

// ── 7. ensureVaultSecrets — missing service-role key fails loud ─────────────

test('ensureVaultSecrets: missing SUPABASE_SERVICE_ROLE_KEY in secrets map → fails fast', async () => {
  const client = makePgClient({ existingNames: [] });
  const cap = await captureOutput(async () =>
    ensureVaultSecrets({ projectRef: 'abc', secrets: {}, dryRun: false, _pgClient: client }));
  assert.equal(cap.result.ok, false);
  assert.equal(cap.result.error, 'service-role-key-missing');
  assert.equal(client.calls.length, 0);
});
