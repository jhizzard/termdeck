// Sprint 61 T2 — applyPendingMigrations + MIGRATION_PROBES + tracker
// bootstrap unit tests.
//
// Covers the six cases from the lane brief:
//   1. Empty tracker + bundled-set of N → applies all N. Tracker has N rows.
//   2. Partial applied (5 of N) + bundled-set of N → applies (N-5).
//      Tracker has N rows.
//   3. Backfill detects post-Sprint-38 schema state (synth probes-present
//      for 001-018, 019 absent), no tracker → seeds the eligible-probe
//      bundled set as backfill rows + applies the probe-ineligible files
//      (003/011/012 null probes) + 019 + 020 = 20 tracker rows.
//   4. Re-running with no diff (all in tracker) returns
//      applied=[], skipped=[...all], errored=null.
//   5. Bad-checksum-vs-DB: tracker has filename X with checksum Y, bundled
//      file checksum Z (Y≠Z) → returns warning entry, does NOT auto-overwrite.
//   6. Migration with bad SQL: synthesized errored migration in tempdir
//      bundle → ROLLBACK, no tracker row written, errored summary,
//      subsequent migrations not attempted.
//
// Mocks pg client + migrations module so these run without a real database.
// Pattern mirrors tests/audit-upgrade.test.js (line 33-73 makePgClient /
// makeMockMigrations).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const SETUP_DIR = path.join(repoRoot, 'packages', 'server', 'src', 'setup');

const migrationsMod = require(path.join(SETUP_DIR, 'migrations.js'));
const {
  applyPendingMigrations,
  MIGRATION_PROBES,
  TRACKER_FILE
} = migrationsMod;

// ── Test infrastructure ─────────────────────────────────────────────────────

// Build a stateful mock pg client. Tracks:
//   - trackerExists       — whether public.mnestra_migrations is "deployed"
//   - trackerRows         — Map<filename, { applied_at, checksum, schema_version }>
//   - probePresence       — Map<probe-substring → bool> (tested in order)
//   - transactionDepth    — counts BEGIN minus COMMIT/ROLLBACK
//   - rollbacks           — counter incremented on ROLLBACK
//   - rollbackSnapshot    — pre-BEGIN tracker copy for ROLLBACK undo
//   - queries[]           — every executed query (sql + params), for assertions
function makeMockPgClient(spec = {}) {
  const trackerRows = new Map();
  for (const [filename, data] of Object.entries(spec.trackerRows || {})) {
    trackerRows.set(filename, {
      applied_at: data.applied_at || '2026-01-01T00:00:00Z',
      checksum: data.checksum,
      schema_version: data.schema_version ?? null
    });
  }

  // Probe presence: array of [substring, bool] pairs. First match wins.
  const probePresence = Array.from(
    Object.entries(spec.probePresence || {})
  );

  const state = {
    trackerExists: !!spec.trackerExists,
    trackerRows,
    probePresence,
    queries: [],
    transactionDepth: 0,
    rollbacks: 0,
    rollbackSnapshot: null,
    appliesViaApplyFile: []
  };

  const client = {
    state,
    queries: state.queries,
    async query(sql, params) {
      state.queries.push({ sql, params });
      const trimmedUpper = sql.trim().toUpperCase();

      if (trimmedUpper.startsWith('BEGIN')) {
        state.transactionDepth++;
        // Snapshot tracker rows for ROLLBACK undo.
        state.rollbackSnapshot = new Map(
          [...state.trackerRows.entries()].map(([k, v]) => [k, { ...v }])
        );
        return { rows: [], rowCount: 0 };
      }
      if (trimmedUpper.startsWith('COMMIT')) {
        state.transactionDepth = Math.max(0, state.transactionDepth - 1);
        state.rollbackSnapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (trimmedUpper.startsWith('ROLLBACK')) {
        state.transactionDepth = Math.max(0, state.transactionDepth - 1);
        state.rollbacks++;
        if (state.rollbackSnapshot) {
          state.trackerRows = state.rollbackSnapshot;
          state.rollbackSnapshot = null;
        }
        return { rows: [], rowCount: 0 };
      }

      // SELECT FROM tracker.
      if (/SELECT\s+filename,\s*checksum\s+FROM\s+public\.mnestra_migrations/i.test(sql)) {
        if (!state.trackerExists) {
          const err = new Error('relation "public.mnestra_migrations" does not exist');
          err.code = '42P01';
          throw err;
        }
        return {
          rows: [...state.trackerRows.entries()].map(([filename, data]) => ({
            filename,
            checksum: data.checksum
          })),
          rowCount: state.trackerRows.size
        };
      }

      // INSERT INTO tracker.
      if (/INSERT\s+INTO\s+public\.mnestra_migrations/i.test(sql)) {
        const [filename, appliedAtParam, checksum, schema_version] = params || [];
        // Detect ON CONFLICT clause shape.
        const isDoNothing = /ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING/i.test(sql);
        const isDoUpdate = /ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE/i.test(sql);
        const existing = state.trackerRows.get(filename);
        if (existing && isDoNothing) {
          return { rowCount: 0 };
        }
        // Parse applied_at — string sentinel ('1970-01-01T00:00:00Z') stays
        // as-is; otherwise treat as "now" (which the SQL passes literally
        // via now() rather than a parameter; but for the bootstrap+real-apply
        // paths the second positional parameter happens to be the checksum,
        // not applied_at). Deal: when params has 4 positional values, that
        // matches the backfill INSERT (filename, applied_at, checksum,
        // schema_version). When params has 3, that matches the
        // bootstrap/real-apply INSERT (filename, checksum, schema_version)
        // because applied_at is hard-coded as now() in the SQL.
        let applied_at;
        if ((params || []).length === 4) {
          applied_at = appliedAtParam;
        } else if ((params || []).length === 3) {
          applied_at = '2026-05-07T18:50:00Z'; // mock "now" — deterministic
        } else {
          throw new Error(`mock pg INSERT: unexpected param count ${(params || []).length}`);
        }
        // Also adjust the parameter mapping when there are only 3 params:
        // [filename, checksum, schema_version].
        const finalChecksum = (params || []).length === 3 ? appliedAtParam : checksum;
        const finalSchemaVersion = (params || []).length === 3 ? checksum : schema_version;
        if (existing && (isDoNothing)) {
          // Already handled above.
        }
        state.trackerRows.set(filename, {
          applied_at,
          checksum: finalChecksum,
          schema_version: finalSchemaVersion ?? null
        });
        return { rowCount: 1 };
      }

      // Probe lookup — exact match. The test maps probe SQL strings to their
      // truthy/falsy presence answers; substring matching causes false-positive
      // collisions when one probe SQL contains another's marker (e.g., 019's
      // probe contains "proname='memory_hybrid_search'" which would otherwise
      // match 002's marker).
      for (const [probeSql, present] of probePresence) {
        if (sql === probeSql) {
          return { rows: present ? [{ '?column?': 1 }] : [], rowCount: present ? 1 : 0 };
        }
      }

      // Probe SQL not matched in probePresence → empty rows (absent).
      // Most non-tracker SELECTs in tests should match a probePresence entry;
      // anything else is an unexpected SELECT and should be flagged via
      // spec.unexpectedQuery if the test wants to catch it.
      if (spec.unexpectedQueryThrows) {
        throw new Error(`mock pg: unexpected query: ${sql.slice(0, 200)}`);
      }
      return { rows: [], rowCount: 0 };
    }
  };

  return { client, state };
}

// Build a mock applyFile that defers to a per-test policy. Default: every
// apply succeeds. Tests can override via spec.applyResults (per-basename).
// Side effect: when 020 is "applied," flip state.trackerExists = true so
// subsequent SELECTs see the table.
function makeMockApplyFile(state, spec = {}) {
  return function applyFileMock(client, filepath) {
    const base = path.basename(filepath);
    state.appliesViaApplyFile.push(base);
    if (spec.applyResults && Object.prototype.hasOwnProperty.call(spec.applyResults, base)) {
      const cfg = spec.applyResults[base];
      // Even on failure, record the attempt; don't flip trackerExists.
      return cfg;
    }
    if (base === TRACKER_FILE) {
      state.trackerExists = true;
    }
    return { ok: true, file: base, elapsedMs: 1, rowCount: 0 };
  };
}

// Build a mock migrations module returning synthetic file paths. Tests
// supply per-file SQL bodies via sqlByBasename; readFile resolves by
// basename.
function makeMockMigrations({ files, sqlByBasename }) {
  return {
    listMnestraMigrations: () => files,
    readFile: (filepath) => {
      const base = path.basename(filepath);
      if (!Object.prototype.hasOwnProperty.call(sqlByBasename, base)) {
        throw new Error(`mock readFile: no canned SQL for ${base}`);
      }
      return sqlByBasename[base];
    }
  };
}

// Generate a synthetic bundled-set list 001..NN with deterministic SQL
// bodies (one statement each — body content is irrelevant for this suite
// because every applyFile is mocked).
function syntheticBundle(count) {
  const filenames = [];
  const sqlByBasename = {};
  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(3, '0');
    const base = `${n}_synth.sql`;
    filenames.push(`/mock/${base}`);
    sqlByBasename[base] = `-- synthetic migration ${n}\nselect ${i};\n`;
  }
  // Always include 020 as the tracker so the bootstrap path can find it.
  if (!filenames.some((f) => path.basename(f) === TRACKER_FILE)) {
    filenames.push(`/mock/${TRACKER_FILE}`);
    sqlByBasename[TRACKER_FILE] =
      'create table if not exists public.mnestra_migrations (filename text primary key);\n';
  }
  filenames.sort();
  return { filenames, sqlByBasename };
}

function checksum(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ── Probe-set sanity ────────────────────────────────────────────────────────

test('MIGRATION_PROBES has exactly 19 entries (001-019)', () => {
  const keys = Object.keys(MIGRATION_PROBES);
  assert.equal(keys.length, 19);
  for (let i = 1; i <= 19; i++) {
    const n = String(i).padStart(3, '0');
    const present = keys.some((k) => k.startsWith(`${n}_`));
    assert.ok(present, `MIGRATION_PROBES missing entry for ${n}_*`);
  }
});

test('MIGRATION_PROBES has non-null probes for every 001-019 entry (post-audit refinement)', () => {
  // Sprint 61 T2 audit refinement: 003 (placeholder), 011 (DML), 012 (DML)
  // were initially null-probed, but the brief's "18 backfilled rows" target
  // requires probes for all 18 of 001-018. 003 uses an always-present
  // probe (`select 1`); 011/012 use bucket-presence probes that are
  // false-positive-tolerant because the migrations themselves are no-ops on
  // already-tagged rows.
  for (const [file, probe] of Object.entries(MIGRATION_PROBES)) {
    assert.notEqual(probe, null, `MIGRATION_PROBES[${file}] should not be null`);
    assert.ok(typeof probe === 'string' && probe.length > 0,
      `MIGRATION_PROBES[${file}] must be a non-empty string`);
  }
});

test('MIGRATION_PROBES special-case probes for 003/011/012 carry their refinement shape', () => {
  // 003 = always-present (placeholder migration body).
  assert.equal(MIGRATION_PROBES['003_mnestra_event_webhook.sql'], 'select 1');
  // 011/012 reference memory_items.project IN-list against post-Sprint-41
  // bucket vocabulary. The values are intentional: false-positive backfill
  // costs nothing because the migration body is a no-op on already-tagged rows.
  assert.match(
    MIGRATION_PROBES['011_project_tag_backfill.sql'],
    /memory_items.*project\s+in\s*\(.*'termdeck'.*'rumen'.*'podium'.*'pvb'.*'dor'.*\)/i
  );
  assert.match(
    MIGRATION_PROBES['012_project_tag_re_taxonomy.sql'],
    /memory_items.*project\s+in\s*\(.*'chopin-in-bohemia'.*'chopin-scheduler'.*'claimguard'.*\)/i
  );
});

// ── Case 1: empty tracker + bundled-set of N → applies all N ────────────────

test('Case 1: empty tracker + bundled-set of N applies all N (bootstrap + apply)', async () => {
  const { filenames, sqlByBasename } = syntheticBundle(19);
  const { client, state } = makeMockPgClient({ trackerExists: false });
  const _applyFile = makeMockApplyFile(state);
  const _migrations = makeMockMigrations({ files: filenames, sqlByBasename });

  const summary = await applyPendingMigrations(client, {
    _migrations,
    _readFile: _migrations.readFile,
    _applyFile,
    _probes: {} // no probes match → every non-tracker file goes through apply
  });

  // 020 + 001..019 = 20 applied.
  assert.equal(summary.errored, null);
  assert.equal(summary.applied.length, 20);
  // 020 is first (bootstrap), then 001..019 in order.
  assert.equal(summary.applied[0], TRACKER_FILE);
  for (let i = 1; i <= 19; i++) {
    const n = String(i).padStart(3, '0');
    assert.ok(
      summary.applied.includes(`${n}_synth.sql`),
      `summary.applied missing ${n}_synth.sql`
    );
  }
  assert.equal(summary.skipped.length, 0);
  assert.equal(summary.backfilled.length, 0);
  assert.equal(state.trackerRows.size, 20);
  assert.equal(state.rollbacks, 0);
});

// ── Case 2: partial applied (5 of N) → applies (N-5) ────────────────────────

test('Case 2: partial applied (5 of 20) → applies remaining 15', async () => {
  const { filenames, sqlByBasename } = syntheticBundle(19);
  // Pre-seed 001..005 in the tracker with correct checksums.
  const trackerRows = {};
  for (let i = 1; i <= 5; i++) {
    const n = String(i).padStart(3, '0');
    const base = `${n}_synth.sql`;
    trackerRows[base] = {
      checksum: checksum(sqlByBasename[base]),
      schema_version: null
    };
  }
  const { client, state } = makeMockPgClient({
    trackerExists: true,
    trackerRows
  });
  const _applyFile = makeMockApplyFile(state);
  const _migrations = makeMockMigrations({ files: filenames, sqlByBasename });

  const summary = await applyPendingMigrations(client, {
    _migrations,
    _readFile: _migrations.readFile,
    _applyFile,
    _probes: {}
  });

  assert.equal(summary.errored, null);
  // 006..019 + 020 = 15 applied.
  assert.equal(summary.applied.length, 15);
  for (let i = 6; i <= 19; i++) {
    const n = String(i).padStart(3, '0');
    assert.ok(
      summary.applied.includes(`${n}_synth.sql`),
      `summary.applied missing ${n}_synth.sql`
    );
  }
  assert.ok(summary.applied.includes(TRACKER_FILE));
  // 001..005 skipped.
  assert.equal(summary.skipped.length, 5);
  for (let i = 1; i <= 5; i++) {
    const n = String(i).padStart(3, '0');
    assert.ok(summary.skipped.includes(`${n}_synth.sql`));
  }
  // Tracker now has all 20.
  assert.equal(state.trackerRows.size, 20);
  assert.equal(summary.warnings.length, 0);
});

// ── Case 3: backfill (post-Sprint-38 install, no tracker) ───────────────────

test('Case 3: backfill detects schema-present probes; seeds backfill + applies probe-ineligible', async () => {
  // Synthesize the real bundled migration filenames so the probe table maps.
  const realFilenames = [
    '001_mnestra_tables.sql', '002_mnestra_search_function.sql',
    '003_mnestra_event_webhook.sql', '004_mnestra_match_count_cap_and_explain.sql',
    '005_v0_1_to_v0_2_upgrade.sql', '006_memory_status_rpc.sql',
    '007_add_source_session_id.sql', '008_legacy_rag_tables.sql',
    '009_memory_relationship_metadata.sql', '010_memory_recall_graph.sql',
    '011_project_tag_backfill.sql', '012_project_tag_re_taxonomy.sql',
    '013_reclassify_uncertain.sql', '014_explicit_grants.sql',
    '015_source_agent.sql', '016_mnestra_doctor_probes.sql',
    '017_memory_sessions_session_metadata.sql', '018_rumen_processed_at.sql',
    '019_security_hardening.sql', '020_migration_tracking.sql'
  ];
  const sqlByBasename = {};
  const filenames = realFilenames.map((b) => {
    sqlByBasename[b] = `-- canned ${b}\nselect 1;\n`;
    return `/mock/${b}`;
  });

  // probePresence: every non-null probe in MIGRATION_PROBES should be PRESENT
  // EXCEPT 019. Use the EXACT probe SQL string from MIGRATION_PROBES as the
  // mock lookup key — substring matching collides because 019's probe SQL
  // contains "proname='memory_hybrid_search'" which would otherwise match
  // 002's substring marker. Exact match avoids the collision class.
  const probePresenceExact = {};
  for (const [file, probeSql] of Object.entries(MIGRATION_PROBES)) {
    if (probeSql === null) continue; // null probes never reach the mock
    if (file === '019_security_hardening.sql') {
      probePresenceExact[probeSql] = false; // 019 NOT applied → genuine apply
    } else {
      probePresenceExact[probeSql] = true; // 001-018 (less null-probe ones) already applied
    }
  }

  const { client, state } = makeMockPgClient({
    trackerExists: false,
    probePresence: probePresenceExact
  });
  const _applyFile = makeMockApplyFile(state);
  const _migrations = makeMockMigrations({ files: filenames, sqlByBasename });

  const summary = await applyPendingMigrations(client, {
    _migrations,
    _readFile: _migrations.readFile,
    _applyFile
    // _probes default = real MIGRATION_PROBES (so the probe SQL strings match
    // the markers above)
  });

  assert.equal(summary.errored, null);
  // 18 backfilled (all of 001-018, including 003/011/012 with their
  // refined probes per the post-audit update). Matches the brief's literal
  // "18 backfilled rows + 19 + 20 = 20 total" acceptance.
  const backfilledExpected = [
    '001_mnestra_tables.sql', '002_mnestra_search_function.sql',
    '003_mnestra_event_webhook.sql',
    '004_mnestra_match_count_cap_and_explain.sql',
    '005_v0_1_to_v0_2_upgrade.sql', '006_memory_status_rpc.sql',
    '007_add_source_session_id.sql', '008_legacy_rag_tables.sql',
    '009_memory_relationship_metadata.sql', '010_memory_recall_graph.sql',
    '011_project_tag_backfill.sql', '012_project_tag_re_taxonomy.sql',
    '013_reclassify_uncertain.sql', '014_explicit_grants.sql',
    '015_source_agent.sql', '016_mnestra_doctor_probes.sql',
    '017_memory_sessions_session_metadata.sql', '018_rumen_processed_at.sql'
  ];
  assert.deepEqual(summary.backfilled.sort(), backfilledExpected.sort());
  assert.equal(summary.backfilled.length, 18);

  // Applied: 020 (bootstrap) + 019 (probe-absent → genuine apply) = 2.
  const appliedExpected = [
    TRACKER_FILE,
    '019_security_hardening.sql'
  ];
  assert.deepEqual(summary.applied.sort(), appliedExpected.sort());
  assert.equal(summary.applied.length, 2);

  // Tracker total: 18 + 2 = 20.
  assert.equal(state.trackerRows.size, 20);

  // Specifically check that backfilled rows have the epoch sentinel.
  const epochRow = state.trackerRows.get('001_mnestra_tables.sql');
  assert.equal(epochRow.applied_at, '1970-01-01T00:00:00Z');
  assert.equal(epochRow.schema_version, 'backfill');

  // No warnings, no rollbacks.
  assert.equal(summary.warnings.length, 0);
  assert.equal(state.rollbacks, 0);
});

// ── Case 4: re-running with no diff ────────────────────────────────────────

test('Case 4: re-running with no diff returns applied=[], skipped=all, errored=null', async () => {
  const { filenames, sqlByBasename } = syntheticBundle(19);
  // Pre-seed all 20 (001..019 + 020) with correct checksums.
  const trackerRows = {};
  for (const fn of filenames) {
    const base = path.basename(fn);
    trackerRows[base] = {
      checksum: checksum(sqlByBasename[base]),
      schema_version: null
    };
  }
  const { client, state } = makeMockPgClient({
    trackerExists: true,
    trackerRows
  });
  const _applyFile = makeMockApplyFile(state);
  const _migrations = makeMockMigrations({ files: filenames, sqlByBasename });

  const summary = await applyPendingMigrations(client, {
    _migrations,
    _readFile: _migrations.readFile,
    _applyFile,
    _probes: {}
  });

  assert.equal(summary.errored, null);
  assert.equal(summary.applied.length, 0);
  assert.equal(summary.backfilled.length, 0);
  assert.equal(summary.skipped.length, 20);
  assert.equal(summary.warnings.length, 0);
  // No applies should have been attempted.
  assert.equal(state.appliesViaApplyFile.length, 0);
});

// ── Case 5: bad-checksum drift warning, no auto-overwrite ──────────────────

test('Case 5: tracked checksum != bundled checksum → warning, no auto-overwrite', async () => {
  const { filenames, sqlByBasename } = syntheticBundle(2);
  // Pre-seed tracker with WRONG checksums for 001 and 002 (and 020 correct).
  const wrongChecksum = 'a'.repeat(64);
  const trackerRows = {
    '001_synth.sql': {
      checksum: wrongChecksum,
      schema_version: null
    },
    '002_synth.sql': {
      checksum: checksum(sqlByBasename['002_synth.sql']), // correct
      schema_version: null
    },
    [TRACKER_FILE]: {
      checksum: checksum(sqlByBasename[TRACKER_FILE]),
      schema_version: null
    }
  };
  const { client, state } = makeMockPgClient({
    trackerExists: true,
    trackerRows
  });
  const _applyFile = makeMockApplyFile(state);
  const _migrations = makeMockMigrations({ files: filenames, sqlByBasename });

  const summary = await applyPendingMigrations(client, {
    _migrations,
    _readFile: _migrations.readFile,
    _applyFile,
    _probes: {}
  });

  assert.equal(summary.errored, null);
  // No applies, no auto-overwrite.
  assert.equal(summary.applied.length, 0);
  assert.equal(summary.backfilled.length, 0);
  // 001 + 002 + 020 all skipped.
  assert.equal(summary.skipped.length, 3);
  assert.ok(summary.skipped.includes('001_synth.sql'));
  // Warning for 001 only (002 has correct checksum).
  assert.equal(summary.warnings.length, 1);
  assert.equal(summary.warnings[0].file, '001_synth.sql');
  assert.equal(summary.warnings[0].trackedChecksum, wrongChecksum);
  assert.equal(
    summary.warnings[0].bundledChecksum,
    checksum(sqlByBasename['001_synth.sql'])
  );
  // Tracker row for 001 NOT overwritten.
  assert.equal(state.trackerRows.get('001_synth.sql').checksum, wrongChecksum);
  // No applies attempted.
  assert.equal(state.appliesViaApplyFile.length, 0);
});

// ── Case 6: bad SQL → ROLLBACK, no tracker row, halt ───────────────────────

test('Case 6: migration with bad SQL → ROLLBACK, no tracker row, halts subsequent migrations', async () => {
  const { filenames, sqlByBasename } = syntheticBundle(3);
  // 002 will fail.
  const errorMsg = 'syntax error at or near "frobble"';
  const { client, state } = makeMockPgClient({
    trackerExists: true,
    trackerRows: {
      [TRACKER_FILE]: {
        checksum: checksum(sqlByBasename[TRACKER_FILE]),
        schema_version: null
      }
    }
  });
  const _applyFile = makeMockApplyFile(state, {
    applyResults: {
      '002_synth.sql': {
        ok: false,
        file: '002_synth.sql',
        elapsedMs: 1,
        error: errorMsg
      }
    }
  });
  const _migrations = makeMockMigrations({ files: filenames, sqlByBasename });

  const summary = await applyPendingMigrations(client, {
    _migrations,
    _readFile: _migrations.readFile,
    _applyFile,
    _probes: {}
  });

  // 001 applied, 002 errored, 003 NOT attempted, 020 skipped.
  assert.equal(summary.applied.length, 1);
  assert.equal(summary.applied[0], '001_synth.sql');
  assert.equal(summary.errored && summary.errored.file, '002_synth.sql');
  assert.equal(summary.errored.error, errorMsg);
  // 003 was not attempted via applyFile.
  assert.ok(!state.appliesViaApplyFile.includes('003_synth.sql'));
  // ROLLBACK happened.
  assert.ok(state.rollbacks >= 1, 'expected at least one ROLLBACK');
  // Tracker has 020 (pre-seeded) + 001 (applied), NOT 002.
  assert.ok(state.trackerRows.has('001_synth.sql'));
  assert.ok(!state.trackerRows.has('002_synth.sql'));
  assert.ok(!state.trackerRows.has('003_synth.sql'));
});

// ── Self-transactional detection (Sprint 61 T2 audit refinement) ──────────

test('isSelfTransactional matches top-level BEGIN; / COMMIT; but NOT PL/pgSQL block delimiters', () => {
  const { _isSelfTransactional } = migrationsMod;
  // Top-level BEGIN; on its own line (011/012 shape).
  assert.equal(_isSelfTransactional('select 1;\nBEGIN;\nupdate t set x = 1;\nCOMMIT;\n'), true);
  // Top-level COMMIT; only.
  assert.equal(_isSelfTransactional('select 1;\nCOMMIT;\n'), true);
  // Indented BEGIN; (still self-transactional — Postgres parses leading WS away).
  assert.equal(_isSelfTransactional('  BEGIN;\n'), true);
  // PL/pgSQL block delimiters (lowercase, no semicolon-on-its-own-line, inside `do $$ ... $$`).
  assert.equal(_isSelfTransactional('do $$\nbegin\n  raise notice \'hi\';\nend $$;\n'), false);
  // No transaction control at all.
  assert.equal(_isSelfTransactional('alter table memory_items add column if not exists x text;\n'), false);
  // Function body with begin (uppercase) but inside CREATE FUNCTION.
  assert.equal(_isSelfTransactional("create function f() returns void as $$ BEGIN raise notice 'x'; END $$ language plpgsql;\n"), false);
});

test('isSelfTransactional flags both 011 and 012 but NOT 019', () => {
  const fs = require('node:fs');
  const { _isSelfTransactional } = migrationsMod;
  const bundleDir = path.join(repoRoot, 'packages', 'server', 'src', 'setup', 'mnestra-migrations');
  const sql011 = fs.readFileSync(path.join(bundleDir, '011_project_tag_backfill.sql'), 'utf-8');
  const sql012 = fs.readFileSync(path.join(bundleDir, '012_project_tag_re_taxonomy.sql'), 'utf-8');
  const sql019 = fs.readFileSync(path.join(bundleDir, '019_security_hardening.sql'), 'utf-8');
  assert.equal(_isSelfTransactional(sql011), true, '011 ships top-level BEGIN; + COMMIT;');
  assert.equal(_isSelfTransactional(sql012), true, '012 ships top-level BEGIN; + COMMIT;');
  assert.equal(_isSelfTransactional(sql019), false, '019 uses do $$ ... $$ blocks only, no top-level BEGIN/COMMIT');
});

test('Self-transactional migration takes the no-outer-wrapper path (no BEGIN/COMMIT/ROLLBACK queries from tracker)', async () => {
  const { filenames, sqlByBasename } = syntheticBundle(0); // 020 only
  // Add a synthetic file that LOOKS self-transactional.
  filenames.unshift('/mock/099_self_tx.sql');
  filenames.sort();
  sqlByBasename['099_self_tx.sql'] = '-- synth self-tx\nBEGIN;\nupdate t set x = 1;\nCOMMIT;\n';

  const { client, state } = makeMockPgClient({ trackerExists: false });
  const _applyFile = makeMockApplyFile(state);
  const _migrations = makeMockMigrations({ files: filenames, sqlByBasename });

  const summary = await applyPendingMigrations(client, {
    _migrations,
    _readFile: _migrations.readFile,
    _applyFile,
    _probes: {} // no probe → falls through to apply path
  });

  assert.equal(summary.errored, null);
  assert.equal(summary.applied.length, 2); // 020 (bootstrap) + 099 (apply)
  assert.ok(summary.applied.includes('099_self_tx.sql'));

  // Crucially, the tracker SHOULD NOT have run BEGIN/COMMIT/ROLLBACK for 099
  // (the file's own BEGIN/COMMIT will, but those go through applyFile, not
  // client.query directly). Count BEGIN/COMMIT/ROLLBACK at the client.query
  // level — these are issued by applyPendingMigrations itself. Self-tx path
  // skips outer wrapper entirely.
  const tcRelatedQueries = state.queries.filter(({ sql }) => {
    const t = sql.trim().toUpperCase();
    return t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK';
  });
  assert.equal(
    tcRelatedQueries.length, 0,
    `expected zero outer-wrapper BEGIN/COMMIT/ROLLBACK queries for self-tx 099, got ${tcRelatedQueries.length}: ${JSON.stringify(tcRelatedQueries.map((q) => q.sql))}`
  );
});

// ── Bonus: bootstrap path inserts 020 own row + flips trackerExists ────────

test('Bootstrap: pre-020 install applies 020 + INSERTs its tracker row', async () => {
  const { filenames, sqlByBasename } = syntheticBundle(0); // only 020
  const { client, state } = makeMockPgClient({ trackerExists: false });
  const _applyFile = makeMockApplyFile(state);
  const _migrations = makeMockMigrations({ files: filenames, sqlByBasename });

  const summary = await applyPendingMigrations(client, {
    _migrations,
    _readFile: _migrations.readFile,
    _applyFile,
    _probes: {}
  });

  assert.equal(summary.errored, null);
  assert.equal(summary.applied.length, 1);
  assert.equal(summary.applied[0], TRACKER_FILE);
  // After bootstrap: trackerExists is true, tracker has 020's row.
  assert.equal(state.trackerExists, true);
  assert.equal(state.trackerRows.size, 1);
  assert.ok(state.trackerRows.has(TRACKER_FILE));
  // applyFile called once for 020.
  assert.deepEqual(state.appliesViaApplyFile, [TRACKER_FILE]);
});
