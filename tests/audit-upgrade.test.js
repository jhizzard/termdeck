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
      '/mock/015_source_agent.sql'
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
      '002_pg_cron_schedule.sql':
        "select cron.schedule('rumen-tick', '*/15 * * * *', $$ select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/rumen-tick'); $$);",
      '003_graph_inference_schedule.sql':
        "select cron.schedule('graph-inference-tick', '0 3 * * *', $$ select net.http_post(url := 'https://<project-ref>.supabase.co/functions/v1/graph-inference'); $$);"
    }
  });
}

// ── Probe-set sanity ────────────────────────────────────────────────────────

test('PROBES has 7 entries covering 5 mnestra + 2 rumen targets', () => {
  assert.equal(PROBES.length, 7);
  const mnestra = PROBES.filter((p) => p.kind === 'mnestra');
  const rumen = PROBES.filter((p) => p.kind === 'rumen');
  assert.equal(mnestra.length, 5);
  assert.equal(rumen.length, 2);
  // Every probe maps to a bundled migration file.
  for (const p of PROBES) {
    assert.ok(p.migrationFile, `probe ${p.name} missing migrationFile`);
    assert.ok(p.probeSql, `probe ${p.name} missing probeSql`);
  }
  // Both rumen schedule probes must be templated (require projectRef).
  assert.equal(rumen.every((p) => p.templated === true), true,
    'both rumen schedule probes must be templated');
});

test('PROBES order matches dependency requirement: M-009 before M-013, M-013 before M-015', () => {
  const idx = (name) => PROBES.findIndex((p) => p.name === name);
  assert.ok(idx('memory_relationships.weight') < idx('memory_items.reclassified_by'));
  assert.ok(idx('memory_items.reclassified_by') < idx('memory_items.source_agent'));
});

// ── Behavior on a fresh / up-to-date install ────────────────────────────────

test('all probes present → applied=[] (idempotent up-to-date case)', async () => {
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
    _migrations: mockMig
  });
  assert.equal(result.probed.length, 7);
  assert.equal(result.present.length, 7);
  assert.equal(result.missing.length, 0);
  assert.equal(result.applied.length, 0);
  assert.equal(result.errors.length, 0);
});

test('all probes absent → all 7 migrations apply in PROBES order', async () => {
  // Default makePgClient returns [] for any non-matched SQL → all probes absent.
  // Apply queries also succeed (return []).
  const client = makePgClient([]);
  const mockMig = defaultMockMigrations();
  const result = await auditUpgrade({
    pgClient: client,
    projectRef: 'abc123def456',
    _migrations: mockMig
  });
  assert.equal(result.missing.length, 7);
  assert.equal(result.applied.length, 7);
  assert.equal(result.errors.length, 0);
  // Apply order matches PROBES order.
  assert.deepEqual(result.applied, PROBES.map((p) => p.name));
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
    _migrations: mockMig
  });
  assert.deepEqual(result.missing, ['memory_items.source_agent']);
  assert.deepEqual(result.applied, ['memory_items.source_agent']);
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
    _migrations: mockMig
  });
  assert.equal(result.missing.length, 7);
  assert.equal(result.applied.length, 0,
    'dryRun must not apply anything');
  assert.equal(result.errors.length, 0);
  // Calls should be exactly 7 probes (one per target), no apply queries.
  assert.equal(client.calls.length, 7);
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

test('every PROBES.migrationFile resolves to a real bundled file', () => {
  const mnestraFiles = realMigrations.listMnestraMigrations()
    .map((f) => path.basename(f));
  const rumenFiles = realMigrations.listRumenMigrations()
    .map((f) => path.basename(f));
  for (const probe of PROBES) {
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
  assert.equal(setup.auditUpgrade.PROBES.length, 7);
});
