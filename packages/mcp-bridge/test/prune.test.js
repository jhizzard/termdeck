'use strict';

// Unit tests for src/prune.js — the `prune-stale-clients` maintenance command
// (v1.10.2). All against SYNTHETIC fixtures in os.tmpdir() — never the live
// ~/.termdeck/bridge-auth.json. Covers: dry-run selection (stale identified,
// valid preserved), no-write-without-apply, atomic apply + backup, output
// secret-safety (no token hashes / secrets leak), and the canonical-resource
// derivation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runPrune,
  selectStale,
  parsePruneArgs,
  resolveCanonicalResource,
  maskClientId,
} = require('../src/prune');

const CURRENT = 'https://bridge.current.example/mcp';
const STALE_A = 'https://abc123.trycloudflare.example/mcp';
const STALE_B = 'https://def456.trycloudflare.example/mcp';

// A synthetic state file with a deliberate mix:
//   • mcp_valid   — one refresh bound to CURRENT          → KEEP
//   • mcp_stale1  — one refresh bound to STALE_A          → REMOVE (client+token)
//   • mcp_stale2  — two refresh, both stale (A and B)     → REMOVE (client+2 tokens)
//   • mcp_mixed   — one CURRENT + one STALE               → KEEP client, drop stale token
//   • mcp_nograms — registered, NO refresh tokens         → KEEP (cannot prove stale)
function fixtureState() {
  return {
    jwtSecret: 'fake-jwt-secret-fixture', // present so the prune writer preserves it
    clients: {
      mcp_valid: { client_id: 'mcp_valid', client_name: 'Valid', client_secret: 'SHOULD-NEVER-PRINT-1' },
      mcp_stale1: { client_id: 'mcp_stale1', client_name: 'Stale1', client_secret: 'SHOULD-NEVER-PRINT-2' },
      mcp_stale2: { client_id: 'mcp_stale2', client_name: 'Stale2', client_secret: 'SHOULD-NEVER-PRINT-3' },
      mcp_mixed: { client_id: 'mcp_mixed', client_name: 'Mixed', client_secret: 'SHOULD-NEVER-PRINT-4' },
      mcp_nograms: { client_id: 'mcp_nograms', client_name: 'NoGrants', client_secret: 'SHOULD-NEVER-PRINT-5' },
    },
    refresh: {
      hash_valid: { client_id: 'mcp_valid', scope: 'mcp:read', resource: CURRENT, exp: 9999999999 },
      hash_stale1: { client_id: 'mcp_stale1', scope: 'mcp:read', resource: STALE_A, exp: 9999999999 },
      hash_stale2a: { client_id: 'mcp_stale2', scope: 'mcp:read', resource: STALE_A, exp: 9999999999 },
      hash_stale2b: { client_id: 'mcp_stale2', scope: 'mcp:read', resource: STALE_B, exp: 9999999999 },
      hash_mixed_ok: { client_id: 'mcp_mixed', scope: 'mcp:read', resource: CURRENT, exp: 9999999999 },
      hash_mixed_stale: { client_id: 'mcp_mixed', scope: 'mcp:read', resource: STALE_B, exp: 9999999999 },
    },
  };
}

function mkTmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-prune-'));
  return path.join(dir, 'bridge-auth.json');
}

test('selectStale identifies stale clients/tokens and preserves valid + no-grant ones', () => {
  const sel = selectStale(fixtureState(), CURRENT);

  // Clients fully bound to stale resources are removed; valid + mixed + no-grant kept.
  assert.deepEqual(sel.staleClientIds.sort(), ['mcp_stale1', 'mcp_stale2']);
  assert.ok(sel.keptClientIds.includes('mcp_valid'));
  assert.ok(sel.keptClientIds.includes('mcp_mixed'), 'a client with one valid grant is preserved');
  assert.ok(sel.keptClientIds.includes('mcp_nograms'), 'a client with no grants is preserved (cannot prove stale)');

  // Stale refresh tokens: stale1 (1) + stale2 (2) + mixed_stale (1) = 4.
  assert.equal(sel.staleRefreshCount, 4);
  // Valid refresh tokens: valid + mixed_ok = 2.
  assert.equal(sel.validRefreshCount, 2);

  // The exact hashes selected for deletion.
  assert.deepEqual(
    sel.staleRefreshHashes.sort(),
    ['hash_mixed_stale', 'hash_stale1', 'hash_stale2a', 'hash_stale2b'],
  );
});

test('selectStale treats trailing-slash / case differences as the SAME resource', () => {
  const sel = selectStale(fixtureState(), 'https://BRIDGE.current.example/mcp/');
  // mcp_valid + mcp_mixed_ok still count as valid despite the cosmetic differences.
  assert.ok(!sel.staleClientIds.includes('mcp_valid'));
  assert.equal(sel.validRefreshCount, 2);
});

test('runPrune dry-run does NOT write, returns the right counts, and leaks no secrets', () => {
  const file = mkTmpFile();
  const original = JSON.stringify(fixtureState());
  fs.writeFileSync(file, original);

  const lines = [];
  const res = runPrune([], { print: (s) => lines.push(s), statePath: file, env: { TERMDECK_BRIDGE_PUBLIC_URL: 'https://bridge.current.example' } });

  assert.equal(res.mode, 'dry-run');
  assert.equal(res.fileFound, true);
  assert.equal(res.staleClients, 2);
  assert.equal(res.staleRefreshTokens, 4);
  assert.equal(res.wrote, false);
  assert.equal(res.backupPath, null);

  // File is byte-for-byte unchanged (no write in dry-run).
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'dry-run leaves the file untouched');

  // Output must NOT contain any client_secret, the jwtSecret, or refresh hashes.
  const out = lines.join('\n');
  assert.ok(!/SHOULD-NEVER-PRINT/.test(out), 'no client_secret in output');
  assert.ok(!out.includes('fake-jwt-secret-fixture'), 'no jwtSecret in output');
  assert.ok(!/hash_stale1|hash_stale2a|hash_stale2b|hash_mixed_stale|hash_valid/.test(out), 'no refresh-token hashes in output');
  // Full stale client ids are masked, not printed verbatim.
  assert.ok(!out.includes('mcp_stale1 '), 'full client id not printed verbatim');
});

test('runPrune --apply removes stale entries, preserves valid ones, writes a backup atomically', () => {
  const file = mkTmpFile();
  fs.writeFileSync(file, JSON.stringify(fixtureState()));

  const res = runPrune(['--apply'], { print: () => {}, statePath: file, env: { TERMDECK_BRIDGE_PUBLIC_URL: 'https://bridge.current.example' } });

  assert.equal(res.mode, 'apply');
  assert.equal(res.wrote, true);
  assert.ok(res.backupPath && fs.existsSync(res.backupPath), 'backup file exists');

  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Stale clients gone; valid/mixed/no-grant retained.
  assert.deepEqual(Object.keys(after.clients).sort(), ['mcp_mixed', 'mcp_nograms', 'mcp_valid']);
  // Stale refresh rows gone; the two valid ones remain.
  assert.deepEqual(Object.keys(after.refresh).sort(), ['hash_mixed_ok', 'hash_valid']);
  // jwtSecret preserved (the writer must not drop it).
  assert.equal(after.jwtSecret, 'fake-jwt-secret-fixture');

  // The backup is the ORIGINAL pre-prune content.
  const backup = JSON.parse(fs.readFileSync(res.backupPath, 'utf8'));
  assert.equal(Object.keys(backup.clients).length, 5, 'backup holds the pre-prune client set');

  // File mode is 0600 (owner-only).
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, 'state file written 0600');
});

test('runPrune --apply with nothing stale is a no-op (no write, no backup)', () => {
  const file = mkTmpFile();
  const cleanState = {
    jwtSecret: 'x',
    clients: { mcp_ok: { client_id: 'mcp_ok' } },
    refresh: { h: { client_id: 'mcp_ok', scope: 'mcp:read', resource: CURRENT, exp: 9999999999 } },
  };
  const original = JSON.stringify(cleanState);
  fs.writeFileSync(file, original);

  const res = runPrune(['--apply'], { print: () => {}, statePath: file, env: { TERMDECK_BRIDGE_PUBLIC_URL: 'https://bridge.current.example' } });
  assert.equal(res.wrote, false, 'no write when nothing is stale');
  assert.equal(res.backupPath, null);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'clean file untouched');
});

test('runPrune on a missing file is a safe no-op', () => {
  const res = runPrune([], { print: () => {}, statePath: path.join(os.tmpdir(), 'does-not-exist-' + Date.now(), 'x.json'), env: {} });
  assert.equal(res.fileFound, false);
  assert.equal(res.staleClients, 0);
});

test('parsePruneArgs: --apply, --file, --resource, --json (and = forms)', () => {
  assert.equal(parsePruneArgs([]).apply, false, 'dry-run is the default');
  assert.equal(parsePruneArgs(['--apply']).apply, true);
  assert.equal(parsePruneArgs(['--json']).json, true);
  assert.equal(parsePruneArgs(['--file', '/tmp/x.json']).file, '/tmp/x.json');
  assert.equal(parsePruneArgs(['--file=/tmp/y.json']).file, '/tmp/y.json');
  assert.equal(parsePruneArgs(['--resource', CURRENT]).resource, CURRENT);
  assert.equal(parsePruneArgs(['--resource=' + CURRENT]).resource, CURRENT);
});

test('resolveCanonicalResource derives <issuer>/mcp from TERMDECK_BRIDGE_PUBLIC_URL', () => {
  assert.equal(
    resolveCanonicalResource({ issuerUrl: 'https://bridge.example.dev' }),
    'https://bridge.example.dev/mcp',
  );
  // explicit resource override wins
  assert.equal(resolveCanonicalResource({ resourceUrl: CURRENT }), CURRENT);
});

test('maskClientId reveals only a short correlatable prefix', () => {
  assert.equal(maskClientId('mcp_abcdefghijklmnop'), 'mcp_abcd…op');
  assert.equal(maskClientId('short'), 'sh***');
});
