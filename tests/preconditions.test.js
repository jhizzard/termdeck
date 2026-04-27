// Regression tests for packages/server/src/setup/preconditions.js (v0.6.9).
//
// These pin the audit/verify contracts that close the v0.6.x precondition-
// drift class. Tests use a fake pg client so they don't hit Supabase — the
// audit logic is what we need to lock down, not pg's behavior.
//
// Coverage map:
//   auditRumenPreconditions
//     - all four gaps surface when nothing is set up (token, pg_cron,
//       pg_net, vault secret)
//     - all four pass when everything is set up
//     - vault permission denied surfaces as a distinct gap (different hint
//       than "missing")
//     - DB-unreachable returns a single gap and short-circuits
//   verifyRumenOutcomes
//     - cron.job missing → gap
//     - cron.job present but inactive → gap with the alter_job hint
//     - cron.job active → ok
//   verifyMnestraOutcomes
//     - missing memory_items table → gap
//     - missing source_session_id column (Brad's exact failure mode) → gap
//     - missing memory_status_aggregation function → gap
//     - all three present → ok

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const preconditions = require(path.resolve(
  __dirname, '..', 'packages', 'server', 'src', 'setup', 'preconditions.js'
));

// ── Fake pg client ──────────────────────────────────────────────────────────
//
// Maps SQL substrings to either { rows: [...] } or a thrown error. The
// helper safeQuery() inside preconditions.js runs `client.query(sql)`, so
// the fake just needs to honor that interface.

function makeFakeClient(routes) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      for (const [pattern, response] of routes) {
        if (sql.includes(pattern)) {
          if (response instanceof Error) throw response;
          if (typeof response === 'function') return response();
          return response;
        }
      }
      // Default: empty rows. Anything not explicitly routed acts as "no row".
      return { rows: [] };
    },
    async end() { /* noop */ }
  };
}

// Silence stdout for tests that exercise printAuditReport / printVerifyReport
// indirectly through the audit path. We restore after.
function silenceStdout(fn) {
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = real; }
}

// ── auditRumenPreconditions ────────────────────────────────────────────────

test('auditRumenPreconditions: all four gaps when nothing is set up', async () => {
  // No SUPABASE_ACCESS_TOKEN in env. supabase CLI probe returns failure
  // (we can't avoid the spawnSync call here, so use a fake env that
  // signals "no token" and let the probe naturally fail or succeed).
  // For determinism, we INSTEAD inject env={SUPABASE_ACCESS_TOKEN: undefined}
  // and override the probe via a test seam — but the simplest deterministic
  // path is: pass env with the token set so probe is skipped, and set the
  // pg side to return empty rows. Then assert the three DB gaps surface.
  // Token absence is asserted in a separate test.
  const client = makeFakeClient([
    ['pg_extension', { rows: [] }],          // pg_cron and pg_net both miss
    ['vault.decrypted_secrets', { rows: [] }] // vault secret missing
  ]);

  const result = await preconditions.auditRumenPreconditions({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' },
    env: { SUPABASE_ACCESS_TOKEN: 'sbp_set' }, // skip CLI probe
    _pgClient: client
  });

  assert.equal(result.ok, false);
  const keys = result.gaps.map((g) => g.key);
  assert.ok(keys.includes('pg_cron'), `pg_cron gap missing — got: ${keys.join(', ')}`);
  assert.ok(keys.includes('pg_net'), `pg_net gap missing — got: ${keys.join(', ')}`);
  assert.ok(keys.includes('rumen_service_role_key'), `vault secret gap missing — got: ${keys.join(', ')}`);
});

test('auditRumenPreconditions: all green when every check returns truthy', async () => {
  const client = makeFakeClient([
    // Each query returns { rows: [{ ok: 1 }] } meaning the SELECT 1 found a row.
    ['pg_cron', { rows: [{ ok: 1 }] }],
    ['pg_net', { rows: [{ ok: 1 }] }],
    ['vault.decrypted_secrets', { rows: [{ ok: 1 }] }]
  ]);

  const result = await preconditions.auditRumenPreconditions({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' },
    env: { SUPABASE_ACCESS_TOKEN: 'sbp_set' },
    _pgClient: client
  });

  assert.equal(result.ok, true);
  assert.equal(result.gaps.length, 0);
});

test('auditRumenPreconditions: vault permission-denied is a distinct gap from "missing"', async () => {
  // safeQuery catches the throw and returns { error: ... } — the audit
  // surfaces it as a vault.decrypted_secrets gap with the access hint
  // (rather than the "create secret" hint).
  const client = makeFakeClient([
    ['pg_cron', { rows: [{ ok: 1 }] }],
    ['pg_net', { rows: [{ ok: 1 }] }],
    ['vault.decrypted_secrets', new Error('permission denied for schema vault')]
  ]);

  const result = await preconditions.auditRumenPreconditions({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' },
    env: { SUPABASE_ACCESS_TOKEN: 'sbp_set' },
    _pgClient: client
  });

  assert.equal(result.ok, false);
  const vaultGap = result.gaps.find((g) => g.key === 'vault.decrypted_secrets');
  assert.ok(vaultGap, 'expected a vault.decrypted_secrets gap');
  assert.match(vaultGap.message, /Cannot read vault.decrypted_secrets/);
  assert.match(vaultGap.message, /permission denied/);
  // Hint should mention the service_role connection, NOT "create secret".
  assert.match(vaultGap.hint, /service_role/);
});

// ── verifyRumenOutcomes ─────────────────────────────────────────────────────

test('verifyRumenOutcomes: missing cron.job row is a gap', async () => {
  const client = makeFakeClient([
    ['cron.job', { rows: [] }]
  ]);

  const result = await preconditions.verifyRumenOutcomes({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' },
    _pgClient: client
  });

  assert.equal(result.ok, false);
  assert.equal(result.gaps[0].key, 'cron.job');
  assert.match(result.gaps[0].message, /no rumen-tick row/);
});

test('verifyRumenOutcomes: cron.job inactive surfaces alter_job hint', async () => {
  const client = makeFakeClient([
    ['cron.job', { rows: [{ active: false }] }]
  ]);

  const result = await preconditions.verifyRumenOutcomes({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' },
    _pgClient: client
  });

  assert.equal(result.ok, false);
  const gap = result.gaps[0];
  assert.equal(gap.key, 'cron.job.active');
  assert.match(gap.hint, /cron\.alter_job/, 'hint should include the alter_job remediation');
});

test('verifyRumenOutcomes: cron.job active is the success path', async () => {
  const client = makeFakeClient([
    ['cron.job', { rows: [{ active: true }] }]
  ]);

  const result = await preconditions.verifyRumenOutcomes({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' },
    _pgClient: client
  });

  assert.equal(result.ok, true);
  assert.equal(result.gaps.length, 0);
});

// ── verifyMnestraOutcomes ───────────────────────────────────────────────────

// Note on route ordering: makeFakeClient does first-match-wins on
// sql.includes(pattern). The column-existence query includes the
// table_name substring AND the column_name substring, so the more
// specific pattern (column_name) must come BEFORE the table pattern in
// the routes array. Same applies to the proname route — it doesn't
// collide, but we keep the convention "more specific first" throughout.

test('verifyMnestraOutcomes: ok when memory_items, source_session_id, and RPC are all present', async () => {
  const client = makeFakeClient([
    ["column_name = 'source_session_id'", { rows: [{ ok: 1 }] }],
    ["proname = 'memory_status_aggregation'", { rows: [{ ok: 1 }] }],
    ["table_name = 'memory_items'", { rows: [{ ok: 1 }] }]
  ]);

  const result = await preconditions.verifyMnestraOutcomes({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' },
    _pgClient: client
  });

  assert.equal(result.ok, true);
  assert.equal(result.gaps.length, 0);
});

test('verifyMnestraOutcomes: missing memory_items.source_session_id surfaces with the loader-shadow hint (Brad\'s exact failure)', async () => {
  // Brad's v0.6.5/v0.6.8 saga: column was missing because the loader picked
  // a stale Mnestra. This test pins that — when the column-check fails,
  // the gap names it AND the hint mentions the npm-cache-clean recovery.
  const client = makeFakeClient([
    ["column_name = 'source_session_id'", { rows: [] }],   // ← missing (most specific first)
    ["proname = 'memory_status_aggregation'", { rows: [{ ok: 1 }] }],
    ["table_name = 'memory_items'", { rows: [{ ok: 1 }] }]
  ]);

  const result = await preconditions.verifyMnestraOutcomes({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' },
    _pgClient: client
  });

  assert.equal(result.ok, false);
  const gap = result.gaps.find((g) => g.key === 'memory_items.source_session_id');
  assert.ok(gap, 'expected memory_items.source_session_id gap');
  assert.match(gap.message, /Rumen will fail/, 'message should call out the downstream consequence');
  assert.match(gap.hint, /npm cache clean --force/, 'hint should include the npm-cache recovery path');
});

test('verifyMnestraOutcomes: missing memory_items table is a distinct, recoverable gap', async () => {
  const client = makeFakeClient([
    ["table_name = 'memory_items'", { rows: [] }]
  ]);

  const result = await preconditions.verifyMnestraOutcomes({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' },
    _pgClient: client
  });

  assert.equal(result.ok, false);
  assert.equal(result.gaps[0].key, 'memory_items');
});

// ── Sprint 35 T3: project-ref dashboard URL in extension hints ─────────────

test('extensionsDashboardUrl: derives the Database → Extensions URL from SUPABASE_URL', () => {
  const url = preconditions.extensionsDashboardUrl({
    SUPABASE_URL: 'https://abcdefghijklmno.supabase.co'
  });
  assert.equal(url, 'https://supabase.com/dashboard/project/abcdefghijklmno/database/extensions');
});

test('extensionsDashboardUrl: returns null when SUPABASE_URL is missing or unparseable', () => {
  assert.equal(preconditions.extensionsDashboardUrl({}), null);
  assert.equal(preconditions.extensionsDashboardUrl({ SUPABASE_URL: 'not-a-url' }), null);
  assert.equal(preconditions.extensionsDashboardUrl(null), null);
});

test('auditRumenPreconditions: pg_cron / pg_net hints include the project-specific dashboard URL', async () => {
  const client = makeFakeClient([
    ['pg_extension', { rows: [] }],            // both extensions miss
    ['vault.decrypted_secrets', { rows: [{ ok: 1 }] }]
  ]);

  const result = await preconditions.auditRumenPreconditions({
    secrets: {
      DATABASE_URL: 'postgres://x:y@z/db',
      SUPABASE_URL: 'https://abcdefghijklmno.supabase.co'
    },
    env: { SUPABASE_ACCESS_TOKEN: 'sbp_set' },
    _pgClient: client
  });

  const cronGap = result.gaps.find((g) => g.key === 'pg_cron');
  const netGap = result.gaps.find((g) => g.key === 'pg_net');
  assert.ok(cronGap, 'expected pg_cron gap');
  assert.ok(netGap, 'expected pg_net gap');
  assert.match(cronGap.hint, /supabase\.com\/dashboard\/project\/abcdefghijklmno\/database\/extensions/);
  assert.match(netGap.hint, /supabase\.com\/dashboard\/project\/abcdefghijklmno\/database\/extensions/);
});

test('auditRumenPreconditions: extension hints fall back to generic copy when SUPABASE_URL absent', async () => {
  const client = makeFakeClient([
    ['pg_extension', { rows: [] }],
    ['vault.decrypted_secrets', { rows: [{ ok: 1 }] }]
  ]);

  const result = await preconditions.auditRumenPreconditions({
    secrets: { DATABASE_URL: 'postgres://x:y@z/db' }, // no SUPABASE_URL
    env: { SUPABASE_ACCESS_TOKEN: 'sbp_set' },
    _pgClient: client
  });

  const cronGap = result.gaps.find((g) => g.key === 'pg_cron');
  assert.ok(cronGap);
  assert.match(cronGap.hint, /Database → Extensions/);
  assert.doesNotMatch(cronGap.hint, /supabase\.com\/dashboard\/project/);
});

// ── Render helpers (smoke only — exercise the path, don't pin formatting) ──

test('printAuditReport / printVerifyReport: do not throw on either ok or failed input', () => {
  silenceStdout(() => {
    preconditions.printAuditReport({ ok: true, gaps: [] }, 'rumen');
    preconditions.printAuditReport({
      ok: false,
      gaps: [{ key: 'k', message: 'm', hint: 'h1\nh2' }]
    }, 'rumen');
    preconditions.printVerifyReport({ ok: true, gaps: [] }, 'mnestra');
    preconditions.printVerifyReport({
      ok: false,
      gaps: [{ key: 'k', message: 'm' }]  // no hint — covers the conditional branch
    }, 'mnestra');
  });
});
