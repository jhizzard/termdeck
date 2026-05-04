// Sprint 51.5 T1 — audit-upgrade unit tests.
//
// Mocks the pg client + migrations module so these run without a real
// database. Coverage:
//   - Each probe returns absent → matching apply path fires.
//   - Each probe returns present → no apply.
//   - Idempotent re-run (all probes present) reports applied=[].
//   - Partial-apply: weight present, source_agent absent → only 015 applies.
//   - dryRun=true: missing surfaces, applied stays empty.
//   - Templating regression guard: rumen 002/003 apply paths must call
//     applyTemplating() with the projectRef substituted (else we ship
//     `<project-ref>` literal to pg_cron — Brad 2026-05-03 takeaway #5).
//   - SUPABASE_DB_URL Edge Function fallback: bundled rumen-tick and
//     graph-inference index.ts source MUST contain the
//     `?? Deno.env.get('SUPABASE_DB_URL')` fallback.
//   - Probe error degrades to "absent" (kicks apply path), not throw.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const SETUP_DIR = path.join(repoRoot, 'packages', 'server', 'src', 'setup');

const auditMod = require(path.join(SETUP_DIR, 'audit-upgrade.js'));
const { auditUpgrade, PROBES } = auditMod;

const realMigrations = require(path.join(SETUP_DIR, 'migrations.js'));

// Build a mock pg client whose .query() returns canned responses keyed off
// the SQL text. Each call records into `calls[]` for later assertion.
function makePgClient(answers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      // Find the first matching answer pattern.
      for (const { match, rows, error } of answers) {
        if (typeof match === 'string' && sql.includes(match)) {
          if (error) throw error;
          return { rows };
        }
        if (match instanceof RegExp && match.test(sql)) {
          if (error) throw error;
          return { rows };
        }
      }
      // Default: empty rows (probe → absent; apply → no-op).
      return { rows: [] };
    }
  };
}

// Build a mock migrations module whose listMnestraMigrations and
// listRumenMigrations return synthetic file paths. readFile returns canned
// SQL bodies keyed by basename.
function makeMockMigrations({ mnestraFiles, rumenFiles, sqlByBasename }) {
  return {
    listMnestraMigrations: () => mnestraFiles,
    listRumenMigrations: () => rumenFiles,
    readFile: (filepath) => {
      const base = path.basename(filepath);
      if (!(base in sqlByBasename)) {
        throw new Error(`mock readFile: no canned SQL for ${base}`);
      }
      return sqlByBasename[base];
    }
  };
}

// Default mock migrations — all 7 probe files present with non-templated
// SQL bodies. Templated rumen files include the <project-ref> placeholder.
function defaultMockMigrations() {
  return makeMockMigrations({
    mnestraFiles: [
      '/mock/009_memory_relationship_metadata.sql',
      '/mock/010_memory_recall_graph.sql',
      '/mock/013_reclassify_uncertain.sql',
      '/mock/014_explicit_grants.sql',
      '/mock/015_source_agent.sql',
      '/mock/017_memory_sessions_session_metadata.sql',
      '/mock/018_rumen_processed_at.sql'
    ],
    rumenFiles: [
      '/mock/002_pg_cron_schedule.sql',
      '/mock/003_graph_inference_schedule.sql'
    ],
    sqlByBasename: {
      '009_memory_relationship_metadata.sql':
        'alter table memory_relationships add column if not exists weight numeric;',
      '010_memory_recall_graph.sql':
        'create or replace function memory_recall_graph() returns void as $$ select 1 $$ language sql;',
      '013_reclassify_uncertain.sql':
        'alter table memory_items add column if not exists reclassified_by text;',
      '014_explicit_grants.sql':
        'grant select, insert, update, delete on all tables in schema public to service_role;',
      '015_source_agent.sql':
        'alter table memory_items add column if not exists source_agent text;',
      '017_memory_sessions_session_metadata.sql':
        'alter table memory_sessions add column if not exists session_id text;',
      '018_rumen_processed_at.sql':
        'alter table memory_sessions add column if not exists rumen_processed_at timestamptz;',
      '002_pg_cron_schedule.sql':
        "select cron.schedule('rumen-tick', '*/15 * * * *', $$ select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/rumen-tick'); $$);",
      '003_graph_inference_schedule.sql':
        "select cron.schedule('graph-inference-tick', '0 3 * * *', $$ select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/graph-inference'); $$);"
    }
  });
}

// Sprint 51.6 T3 — fetch mock for functionSource probe tests. Returns a
// configurable body string; a "current" body contains the SUPABASE_DB_URL
// fallback marker, a "stale" one does not.
function makeFetchMock(spec) {
  return async (url, opts) => {
    const m = url.match(/\/projects\/([^/]+)\/functions\/([^/]+)\/body/);
    if (!m) {
      throw new Error(`unexpected fetch URL: ${url}`);
    }
    const slug = m[2];
    const cfg = spec[slug];
    if (!cfg) {
      return { ok: false, status: 404, text: async () => `no mock for ${slug}` };
    }
    if (cfg.networkError) throw new Error(cfg.networkError);
    return {
      ok: cfg.ok !== false,
      status: cfg.status || 200,
      text: async () => cfg.body || '',
    };
  };
}

// ── Probe-set sanity ────────────────────────────────────────────────────────

// Sprint 51.6 T3: probe set grew from 7 to 10 — adds memory_sessions.session_id
// (mig 017) plus two functionSource probes (Bug D — rumen-tick + graph-inference
// deployed source drift detection).
// Sprint 52 (Class O): probe set grows from 10 to 12 — adds two edgeFunctionPin
// probes (rumen-tick + graph-inference) for deployed-state pin drift.
// Sprint 53 T2: probe set grows from 12 to 13 — adds memory_sessions.rumen_processed_at
// (mig 018) so `init --rumen --yes` cannot deploy rumen 0.5.0 picker without the column.
test('PROBES has 13 entries covering 7 mnestra + 6 rumen targets', () => {
  assert.equal(PROBES.length, 13);
  const mnestra = PROBES.filter((p) => p.kind === 'mnestra');
  const rumen = PROBES.filter((p) => p.kind === 'rumen');
  assert.equal(mnestra.length, 7);
  assert.equal(rumen.length, 6);
  // Migration-backed probes still need a bundled file + probeSql.
  const migrationProbes = PROBES.filter((q) =>
    q.probeKind !== 'functionSource' && q.probeKind !== 'edgeFunctionPin');
  for (const p of migrationProbes) {
    assert.ok(p.migrationFile, `probe ${p.name} missing migrationFile`);
    assert.ok(p.probeSql, `probe ${p.name} missing probeSql`);
  }
  // functionSource probes carry functionSlug + requiredMarker, no SQL/migration.
  for (const p of PROBES.filter((q) => q.probeKind === 'functionSource')) {
    assert.ok(p.functionSlug, `functionSource probe ${p.name} missing functionSlug`);
    assert.ok(p.requiredMarker, `functionSource probe ${p.name} missing requiredMarker`);
  }
  // edgeFunctionPin probes carry functionSlug + importPattern + expectedFrom.
  for (const p of PROBES.filter((q) => q.probeKind === 'edgeFunctionPin')) {
    assert.ok(p.functionSlug, `edgeFunctionPin probe ${p.name} missing functionSlug`);
    assert.ok(p.importPattern instanceof RegExp,
      `edgeFunctionPin probe ${p.name} missing importPattern (RegExp)`);
    assert.ok(p.expectedFrom === 'npmRegistry' || p.expectedFrom === 'bundledSource',
      `edgeFunctionPin probe ${p.name} has invalid expectedFrom: ${p.expectedFrom}`);
    if (p.expectedFrom === 'npmRegistry') {
      assert.ok(p.npmRegistryPkg, `edgeFunctionPin probe ${p.name} missing npmRegistryPkg`);
    }
    if (p.expectedFrom === 'bundledSource') {
      assert.ok(p.bundledPath, `edgeFunctionPin probe ${p.name} missing bundledPath`);
    }
  }
  // Both rumen schedule probes must be templated (require projectRef).
  const cronProbes = rumen.filter((p) =>
    p.probeKind !== 'functionSource' && p.probeKind !== 'edgeFunctionPin');
  assert.equal(cronProbes.every((p) => p.templated === true), true,
    'both rumen schedule probes must be templated');
});

test('PROBES order matches dependency requirement: M-009 before M-013, M-013 before M-015, M-015 before M-017, M-017 before M-018', () => {
  const idx = (name) => PROBES.findIndex((p) => p.name === name);
  assert.ok(idx('memory_relationships.weight') < idx('memory_items.reclassified_by'));
  assert.ok(idx('memory_items.reclassified_by') < idx('memory_items.source_agent'));
  // Sprint 51.6: mig 017 (memory_sessions.session_id) lands AFTER mig 015.
  assert.ok(idx('memory_items.source_agent') < idx('memory_sessions.session_id'));
  // Sprint 53: mig 018 (memory_sessions.rumen_processed_at) lands AFTER mig 017.
  assert.ok(idx('memory_sessions.session_id') < idx('memory_sessions.rumen_processed_at'));
});

// ── Behavior on a fresh / up-to-date install ────────────────────────────────

// Sprint 51.6 T3: existing SQL-probe tests filter functionSource probes out
// so they exercise only the 8 migration-backed probes (6 mnestra + 2 rumen
// cron). functionSource probes have their own dedicated tests below.
// Sprint 52: also filter edgeFunctionPin probes — they have their own
// dedicated tests in tests/audit-upgrade-edge-function-pin.test.js.
// Sprint 53 T2: SQL probe set grew from 8 to 9 (added memory_sessions.rumen_processed_at).
const SQL_PROBES = PROBES.filter(
  (p) => p.probeKind !== 'functionSource' && p.probeKind !== 'edgeFunctionPin'
);

test('all SQL probes present → applied=[] (idempotent up-to-date case)', async () => {
  // Every probe SQL returns 1 row → present. Nothing to apply.
  const client = makePgClient([
    { match: 'information_schema.columns', rows: [{ present: 1 }] },
    { match: 'pg_proc', rows: [{ present: 1 }] },
    { match: 'has_table_privilege', rows: [{ present: true }] },
    { match: 'cron.job', rows: [{ present: 1 }] }
  ]);
  const mockMig = defaultMockMigrations();
  const result = await auditUpgrade({
    pgClient: client,
    projectRef: 'abc123def456',
    probes: SQL_PROBES,
    _migrations: mockMig
  });
  assert.equal(result.probed.length, 9);
  assert.equal(result.present.length, 9);
  assert.equal(result.missing.length, 0);
  assert.equal(result.applied.length, 0);
  assert.equal(result.errors.length, 0);
});

test('all SQL probes absent → all 9 migrations apply in PROBES order', async () => {
  // Default makePgClient returns [] for any non-matched SQL → all probes absent.
  // Apply queries also succeed (return []).
  const client = makePgClient([]);
  const mockMig = defaultMockMigrations();
  const result = await auditUpgrade({
    pgClient: client,
    projectRef: 'abc123def456',
    probes: SQL_PROBES,
    _migrations: mockMig
  });
  assert.equal(result.missing.length, 9);
  assert.equal(result.applied.length, 9);
  assert.equal(result.errors.length, 0);
  // Apply order matches PROBES order (filtered).
  assert.deepEqual(result.applied, SQL_PROBES.map((p) => p.name));
});

// ── Partial drift ───────────────────────────────────────────────────────────

test('partial drift: weight present, source_agent absent → only 015 applies', async () => {
  const client = {
    calls: [],
    async query(sql) {
      this.calls.push({ sql });
      // memory_relationships.weight → present.
      if (sql.includes("table_name = 'memory_relationships'") && sql.includes("'weight'")) {
        return { rows: [{ present: 1 }] };
      }
      // memory_recall_graph rpc → present.
      if (sql.includes("proname = 'memory_recall_graph'")) {
        return { rows: [{ present: 1 }] };
      }
      // reclassified_by → present.
      if (sql.includes("'reclassified_by'")) {
        return { rows: [{ present: 1 }] };
      }
      // service_role grant → present.
      if (sql.includes('has_table_privilege')) {
        return { rows: [{ present: true }] };
      }
      // source_agent → ABSENT.
      if (sql.includes("'source_agent'")) {
        return { rows: [] };
      }
      // crons → present.
      if (sql.includes('cron.job')) {
        return { rows: [{ present: 1 }] };
      }
      // The 015 apply SQL itself ("alter table memory_items add column if not
      // exists source_agent text;") runs and returns nothing — succeed.
      return { rows: [] };
    }
  };
  const mockMig = defaultMockMigrations();
  const result = await auditUpgrade({
    pgClient: client,
    projectRef: 'abc123def456',
    probes: SQL_PROBES,
    _migrations: mockMig
  });
  // mig 017's probe asks for 'session_id' and mig 018's probe asks for
  // 'rumen_processed_at' — neither is in the canned answers above, so
  // BOTH come back absent. 015, 017, and 018 all apply.
  assert.deepEqual(result.missing, [
    'memory_items.source_agent',
    'memory_sessions.session_id',
    'memory_sessions.rumen_processed_at'
  ]);
  assert.deepEqual(result.applied, [
    'memory_items.source_agent',
    'memory_sessions.session_id',
    'memory_sessions.rumen_processed_at'
  ]);
  assert.equal(result.errors.length, 0);
});

// ── dryRun ──────────────────────────────────────────────────────────────────

test('dryRun=true surfaces missing without applying', async () => {
  const client = makePgClient([]); // all absent
  const mockMig = defaultMockMigrations();
  const result = await auditUpgrade({
    pgClient: client,
    projectRef: 'abc123def456',
    dryRun: true,
    probes: SQL_PROBES,
    _migrations: mockMig
  });
  assert.equal(result.missing.length, 9);
  assert.equal(result.applied.length, 0,
    'dryRun must not apply anything');
  assert.equal(result.errors.length, 0);
  // Calls should be exactly 9 probes (one per SQL target), no apply queries.
  assert.equal(client.calls.length, 9);
});

// ── Templating regression guard (Brad 2026-05-03 takeaway #5) ───────────────

test('rumen 002 templating: applied SQL has projectRef substituted, no <project-ref> literal', async () => {
  const captured = [];
  const client = {
    calls: [],
    async query(sql) {
      captured.push(sql);
      if (sql.includes('cron.job')) return { rows: [] }; // probes report absent
      // All other probes present so only rumen 002 + 003 apply.
      if (sql.includes('information_schema.columns')) return { rows: [{ present: 1 }] };
      if (sql.includes('pg_proc')) return { rows: [{ present: 1 }] };
      if (sql.includes('has_table_privilege')) return { rows: [{ present: true }] };
      return { rows: [] }; // apply success
    }
  };
  const mockMig = defaultMockMigrations();
  const result = await auditUpgrade({
    pgClient: client,
    projectRef: 'realprojectref789',
    _migrations: mockMig
  });
  assert.deepEqual(result.applied, [
    'rumen-tick cron schedule',
    'graph-inference-tick cron schedule'
  ]);
  // The applied bodies for 002 + 003 must contain the realprojectref789
  // value, NOT the raw <project-ref> placeholder.
  const applied002 = captured.find((s) => s.includes('rumen-tick') && s.includes('cron.schedule'));
  const applied003 = captured.find((s) => s.includes('graph-inference') && s.includes('cron.schedule'));
  assert.ok(applied002, 'rumen 002 apply call should be in captured SQL');
  assert.ok(applied003, 'rumen 003 apply call should be in captured SQL');
  assert.match(applied002, /realprojectref789\.supabase\.co/);
  assert.doesNotMatch(applied002, /<project-ref>/,
    'audit-upgrade must NOT ship raw <project-ref> placeholder to pg_cron');
  assert.match(applied003, /realprojectref789\.supabase\.co/);
  assert.doesNotMatch(applied003, /<project-ref>/);
});

test('templated migration without projectRef → applyTemplating throws → recorded as error, not crash', async () => {
  const client = makePgClient([
    // mnestra probes all present so we only attempt rumen.
    { match: 'information_schema.columns', rows: [{ present: 1 }] },
    { match: 'pg_proc', rows: [{ present: 1 }] },
    { match: 'has_table_privilege', rows: [{ present: true }] },
    { match: 'cron.job', rows: [] } // crons absent
  ]);
  const mockMig = defaultMockMigrations();
  const result = await auditUpgrade({
    pgClient: client,
    // projectRef intentionally missing
    _migrations: mockMig
  });
  // Both rumen apply attempts should fail (templating throws). Audit
  // continues, surfaces errors[], doesn't crash.
  assert.equal(result.errors.length, 2);
  for (const e of result.errors) {
    assert.match(e.error, /projectRef/i,
      'error message should mention the missing projectRef');
  }
  assert.deepEqual(result.applied, []);
});

// ── Probe-error degradation ─────────────────────────────────────────────────

test('probe SQL throw degrades to "absent" (apply path fires); does not propagate', async () => {
  let probeCalls = 0;
  let applyCalls = 0;
  const client = {
    async query(sql) {
      // First call (probe for memory_relationships.weight) throws.
      if (probeCalls === 0 && sql.includes("'weight'")) {
        probeCalls++;
        throw new Error('relation "memory_relationships" does not exist');
      }
      probeCalls++;
      // Subsequent probes all present.
      if (sql.includes('information_schema') || sql.includes('pg_proc') || sql.includes('cron.job')) {
        return { rows: [{ present: 1 }] };
      }
      if (sql.includes('has_table_privilege')) return { rows: [{ present: true }] };
      // Apply succeeds.
      applyCalls++;
      return { rows: [] };
    }
  };
  const mockMig = defaultMockMigrations();
  const result = await auditUpgrade({
    pgClient: client,
    projectRef: 'abc123def456',
    _migrations: mockMig
  });
  assert.deepEqual(result.missing, ['memory_relationships.weight']);
  assert.deepEqual(result.applied, ['memory_relationships.weight']);
  assert.ok(applyCalls >= 1, 'apply path should have fired despite probe throw');
});

// ── Real migrations module: bundled set is complete ─────────────────────────

test('bundled mnestra-migrations directory contains 013, 014, 015 (Sprint 51.5 sync)', () => {
  const files = realMigrations.listMnestraMigrations();
  const basenames = files.map((f) => path.basename(f));
  assert.ok(basenames.includes('013_reclassify_uncertain.sql'),
    'M-013 must be in bundled set after Sprint 51.5 sync');
  assert.ok(basenames.includes('014_explicit_grants.sql'),
    'M-014 must be in bundled set');
  assert.ok(basenames.includes('015_source_agent.sql'),
    'M-015 must be in bundled set');
});

test('every migration-backed PROBES.migrationFile resolves to a real bundled file', () => {
  const mnestraFiles = realMigrations.listMnestraMigrations()
    .map((f) => path.basename(f));
  const rumenFiles = realMigrations.listRumenMigrations()
    .map((f) => path.basename(f));
  // Sprint 51.6 T3: functionSource probes do not have a migrationFile —
  // their fix is a redeploy via init-rumen, not an SQL migration.
  // Sprint 52: same for edgeFunctionPin probes — pin drift is fixed by
  // a redeploy, not an SQL migration.
  const migrationProbes = PROBES.filter(
    (p) => p.probeKind !== 'functionSource' && p.probeKind !== 'edgeFunctionPin'
  );
  for (const probe of migrationProbes) {
    const set = probe.kind === 'mnestra' ? mnestraFiles : rumenFiles;
    assert.ok(set.includes(probe.migrationFile),
      `probe ${probe.name} references ${probe.migrationFile} but it is not in the bundled ${probe.kind} migration set`);
  }
});

// ── Edge Function source: SUPABASE_DB_URL fallback (Brad takeaway #1) ──────

test('rumen-tick/index.ts falls back from DATABASE_URL to SUPABASE_DB_URL', () => {
  const src = fs.readFileSync(
    path.join(repoRoot, 'packages', 'server', 'src', 'setup',
      'rumen', 'functions', 'rumen-tick', 'index.ts'),
    'utf-8'
  );
  // The exact pattern: nullish-coalesce SUPABASE_DB_URL.
  assert.match(src,
    /Deno\.env\.get\(['"]DATABASE_URL['"]\)\s*\?\?\s*Deno\.env\.get\(['"]SUPABASE_DB_URL['"]\)/,
    'rumen-tick must fall back to SUPABASE_DB_URL when DATABASE_URL is unset (Brad 2026-05-03 takeaway #1)');
});

test('graph-inference/index.ts falls back from DATABASE_URL to SUPABASE_DB_URL', () => {
  const src = fs.readFileSync(
    path.join(repoRoot, 'packages', 'server', 'src', 'setup',
      'rumen', 'functions', 'graph-inference', 'index.ts'),
    'utf-8'
  );
  assert.match(src,
    /Deno\.env\.get\(['"]DATABASE_URL['"]\)\s*\?\?\s*Deno\.env\.get\(['"]SUPABASE_DB_URL['"]\)/,
    'graph-inference must fall back to SUPABASE_DB_URL when DATABASE_URL is unset');
});

// ── Setup-dir export wiring ─────────────────────────────────────────────────

test('packages/server/src/setup index re-exports auditUpgrade', () => {
  const setup = require(SETUP_DIR);
  assert.equal(typeof setup.auditUpgrade, 'object');
  assert.equal(typeof setup.auditUpgrade.auditUpgrade, 'function');
  assert.ok(Array.isArray(setup.auditUpgrade.PROBES) ||
    Object.isFrozen(setup.auditUpgrade.PROBES));
  // Sprint 52: 10 → 12 (added rumen-tick-pin + graph-inference-pin).
  // Sprint 53 T2: 12 → 13 (added memory_sessions.rumen_processed_at for mig 018).
  assert.equal(setup.auditUpgrade.PROBES.length, 13);
});

// ── Sprint 51.6 T3: functionSource probe (Bug D — Edge Function drift) ──

test('functionSource probe reports present when deployed body contains the marker', async () => {
  const fnSourceProbes = PROBES.filter((p) => p.probeKind === 'functionSource');
  assert.ok(fnSourceProbes.length >= 2);
  const fetchMock = makeFetchMock({
    'rumen-tick': { ok: true, body: "const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');" },
    'graph-inference': { ok: true, body: "const url = Deno.env.get('DATABASE_URL') ?? Deno.env.get('SUPABASE_DB_URL');" },
  });
  const orig = process.env.SUPABASE_ACCESS_TOKEN;
  process.env.SUPABASE_ACCESS_TOKEN = 'sbp_test_token';
  try {
    const client = makePgClient([]);
    const result = await auditUpgrade({
      pgClient: client,
      projectRef: 'abc123def456',
      probes: fnSourceProbes,
      _fetch: fetchMock,
      _migrations: defaultMockMigrations(),
    });
    assert.equal(result.present.length, fnSourceProbes.length,
      'all functionSource probes should report present when marker is found');
    assert.equal(result.skipped.length, 0);
    assert.equal(result.missing.length, 0);
  } finally {
    if (orig === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
    else process.env.SUPABASE_ACCESS_TOKEN = orig;
  }
});

test('functionSource probe reports skipped when deployed body lacks the marker (drift detected)', async () => {
  const fnSourceProbes = PROBES.filter((p) => p.probeKind === 'functionSource');
  // Body missing the SUPABASE_DB_URL fallback — Brad's pre-Sprint-51.5 deploy.
  const fetchMock = makeFetchMock({
    'rumen-tick': { ok: true, body: "const url = Deno.env.get('DATABASE_URL');" },
    'graph-inference': { ok: true, body: "const url = Deno.env.get('DATABASE_URL');" },
  });
  const orig = process.env.SUPABASE_ACCESS_TOKEN;
  process.env.SUPABASE_ACCESS_TOKEN = 'sbp_test_token';
  try {
    const client = makePgClient([]);
    const result = await auditUpgrade({
      pgClient: client,
      projectRef: 'abc123def456',
      probes: fnSourceProbes,
      _fetch: fetchMock,
      _migrations: defaultMockMigrations(),
    });
    assert.equal(result.present.length, 0);
    assert.equal(result.skipped.length, fnSourceProbes.length,
      'drift should report via skipped[], not missing[] (no auto-apply)');
    assert.equal(result.missing.length, 0,
      'functionSource probes go to skipped[], NOT missing[]');
    for (const s of result.skipped) {
      assert.match(s.reason, /missing marker/);
    }
    assert.equal(result.applied.length, 0,
      'functionSource probes never apply — redeploy is via init --rumen');
  } finally {
    if (orig === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
    else process.env.SUPABASE_ACCESS_TOKEN = orig;
  }
});

test('functionSource probe fails-soft when SUPABASE_ACCESS_TOKEN is missing', async () => {
  const fnSourceProbes = PROBES.filter((p) => p.probeKind === 'functionSource');
  const fetchMock = () => { throw new Error('should not fetch without access token'); };
  const orig = process.env.SUPABASE_ACCESS_TOKEN;
  delete process.env.SUPABASE_ACCESS_TOKEN;
  try {
    const client = makePgClient([]);
    const result = await auditUpgrade({
      pgClient: client,
      projectRef: 'abc123def456',
      probes: fnSourceProbes,
      _fetch: fetchMock,
      _migrations: defaultMockMigrations(),
    });
    // No access token → probe records error message, drops to skipped[].
    assert.equal(result.skipped.length, fnSourceProbes.length);
    for (const s of result.skipped) {
      assert.match(s.reason, /SUPABASE_ACCESS_TOKEN not set/);
    }
  } finally {
    if (orig !== undefined) process.env.SUPABASE_ACCESS_TOKEN = orig;
  }
});

test('functionSource probe handles Management API HTTP errors fail-soft', async () => {
  const fnSourceProbes = PROBES.filter((p) => p.probeKind === 'functionSource');
  const fetchMock = makeFetchMock({
    'rumen-tick': { ok: false, status: 404, body: 'function not found' },
    'graph-inference': { ok: false, status: 401, body: 'unauthorized' },
  });
  const orig = process.env.SUPABASE_ACCESS_TOKEN;
  process.env.SUPABASE_ACCESS_TOKEN = 'sbp_test_token';
  try {
    const client = makePgClient([]);
    const result = await auditUpgrade({
      pgClient: client,
      projectRef: 'abc123def456',
      probes: fnSourceProbes,
      _fetch: fetchMock,
      _migrations: defaultMockMigrations(),
    });
    assert.equal(result.skipped.length, fnSourceProbes.length);
    assert.match(result.skipped[0].reason, /HTTP (?:404|401)/);
    assert.match(result.skipped[1].reason, /HTTP (?:404|401)/);
  } finally {
    if (orig === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
    else process.env.SUPABASE_ACCESS_TOKEN = orig;
  }
});

// ── Sprint 51.6 T3: bundled mig 017 verification ────────────────────────────

test('bundled mnestra-migrations directory contains 017 (memory_sessions session_metadata)', () => {
  const fs = require('node:fs');
  const dir = path.join(repoRoot, 'packages', 'server', 'src', 'setup', 'mnestra-migrations');
  const files = fs.readdirSync(dir);
  assert.ok(files.includes('017_memory_sessions_session_metadata.sql'),
    'Sprint 51.6 T3: mig 017 must ship in the bundled tree');
});

test('mig 017 SQL contains session_id, summary_embedding, and the unique-constraint do-block', () => {
  const fs = require('node:fs');
  const sql = fs.readFileSync(path.join(repoRoot,
    'packages', 'server', 'src', 'setup', 'mnestra-migrations',
    '017_memory_sessions_session_metadata.sql'), 'utf8');
  assert.match(sql, /add column if not exists session_id text/i);
  assert.match(sql, /add column if not exists summary_embedding vector/i);
  assert.match(sql, /add column if not exists started_at/i);
  assert.match(sql, /add column if not exists ended_at/i);
  assert.match(sql, /memory_sessions_session_id_key/);
  assert.match(sql, /create index if not exists memory_sessions_summary_embedding_hnsw_idx/i);
});
