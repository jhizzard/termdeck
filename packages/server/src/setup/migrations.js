// Discover the SQL migration files that ship bundled inside the TermDeck
// package. Both init wizards call this — init-mnestra for the seven Mnestra
// migrations, init-rumen for the two Rumen migrations.
//
// The wizards intentionally do NOT fall back to a sibling `../../mnestra`
// working copy. Resolution order (BUNDLED FIRST as of v0.6.8):
//
//   1. Files bundled at `packages/server/src/setup/mnestra-migrations/*.sql`
//      (this directory is covered by the root package.json `files` glob).
//      ALWAYS preferred when it has any .sql files.
//   2. Files at `node_modules/@jhizzard/mnestra/migrations/*.sql` if that
//      package is installed alongside TermDeck. Used ONLY as a fallback when
//      the bundled directory is missing (e.g. someone deleted it manually).
//
// Why bundled-first: the meta-installer (`@jhizzard/termdeck-stack`) installs
// `@jhizzard/mnestra` globally as a peer. When TermDeck releases a new
// migration ahead of a Mnestra release, or when a user upgrades TermDeck
// without also upgrading the global Mnestra package, the previous loader
// silently picked the older Mnestra migration set. This bit Brad on
// 2026-04-26 with v0.6.5: he upgraded TermDeck, ran `init --mnestra --yes`,
// the wizard reported "6 migrations applied cleanly" (because his global
// mnestra@0.2.1 had only 6), and the bundled 007 — the one we shipped to
// fix his Rumen schema-drift issue — was never seen. Bundled is the source
// of truth TermDeck developed and tested against. Fall-back to node_modules
// is preserved as a safety valve, not a preference.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SETUP_DIR = __dirname;

// Sprint 61 T2 — durable migration tracking table + filename + table name.
// `mnestra_migrations` is created by bundled migration 020 (RLS-on,
// service_role-only, no policies). The applyPendingMigrations diff loop and
// the backfill probe both target this table.
const TRACKER_TABLE = 'public.mnestra_migrations';
const TRACKER_FILE = '020_migration_tracking.sql';

// Sprint 61 T2 — declarative probe set.
//
// One row per bundled mnestra migration 001-019 (020 itself is the tracker
// and is bootstrap-special-cased; not probed). Each probe is a single
// presence-style SQL statement: returns ≥1 row when the migration's schema
// artifact is in place, 0 rows otherwise.
//
// Used by applyPendingMigrations() during the backfill pass: when an install
// is pre-020 (no tracker table yet) and a bundled migration is not in the
// applied-set, the probe decides whether the migration's effects are already
// present (→ INSERT a backfill tracker row, skip apply) or genuinely missing
// (→ run the migration via the normal apply path, INSERT a real tracker row).
//
// Probe values:
//   - string: SQL fragment to run via client.query(). Probe is "present"
//             when the result has ≥1 row.
//   - null:   no schema artifact to introspect (DML migrations, comments-only
//             placeholders). The first apply runs the migration; the tracker
//             row prevents re-application on subsequent passes. The brief
//             notes 003 (event_webhook placeholder), 011 (project_tag_backfill
//             DML), and 012 (project_tag_re_taxonomy DML) fall here.
const MIGRATION_PROBES = Object.freeze({
  '001_mnestra_tables.sql':
    "select 1 from information_schema.tables where table_schema='public' and table_name='memory_items'",
  '002_mnestra_search_function.sql':
    "select 1 from pg_proc where proname='memory_hybrid_search'",
  // 003 is a comments-only placeholder migration with no DDL/DML body. The
  // apply path is a no-op on every install. Always-present probe is the
  // honest schema fingerprint — every install for which 001 has run is
  // also "compatible with 003." Post-Sprint-61-T2-audit refinement.
  '003_mnestra_event_webhook.sql':
    "select 1",
  '004_mnestra_match_count_cap_and_explain.sql':
    "select 1 from pg_proc where proname='memory_hybrid_search_explain'",
  '005_v0_1_to_v0_2_upgrade.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_items' and column_name='archived'",
  '006_memory_status_rpc.sql':
    "select 1 from pg_proc where proname='memory_status_aggregation'",
  '007_add_source_session_id.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_items' and column_name='source_session_id'",
  '008_legacy_rag_tables.sql':
    "select 1 from information_schema.tables where table_schema='public' and table_name='mnestra_session_memory'",
  '009_memory_relationship_metadata.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_relationships' and column_name='weight'",
  '010_memory_recall_graph.sql':
    "select 1 from pg_proc where proname='memory_recall_graph'",
  // 011 retags chopin-nashville rows into post-Sprint-41 buckets (termdeck,
  // rumen, podium, pvb, dor). Probe present iff any row carries one of those
  // tags — meaning either 011 has run, or the install legitimately has rows
  // tagged that way through other means. Either way the apply is a no-op
  // (the UPDATEs are gated on `project = 'chopin-nashville'`), so a false-
  // positive backfill costs nothing. Post-Sprint-61-T2-audit refinement.
  '011_project_tag_backfill.sql':
    "select 1 from memory_items where project in ('termdeck', 'rumen', 'podium', 'pvb', 'dor') limit 1",
  // 012 expands 011's taxonomy with chopin-in-bohemia, chopin-scheduler, and
  // claimguard buckets. Probe present iff any row is in those expanded
  // buckets. Same false-positive-is-harmless reasoning as 011.
  // Post-Sprint-61-T2-audit refinement.
  '012_project_tag_re_taxonomy.sql':
    "select 1 from memory_items where project in ('chopin-in-bohemia', 'chopin-scheduler', 'claimguard') limit 1",
  '013_reclassify_uncertain.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_items' and column_name='reclassified_by'",
  '014_explicit_grants.sql':
    "select 1 where has_table_privilege('service_role', 'public.memory_items', 'INSERT')",
  '015_source_agent.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_items' and column_name='source_agent'",
  '016_mnestra_doctor_probes.sql':
    "select 1 from pg_proc where proname='mnestra_doctor_vault_secret_exists'",
  '017_memory_sessions_session_metadata.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_sessions' and column_name='session_id'",
  '018_rumen_processed_at.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_sessions' and column_name='rumen_processed_at'",
  '019_security_hardening.sql':
    "select 1 from pg_proc p, unnest(coalesce(p.proconfig,'{}'::text[])) c where p.proname='memory_hybrid_search' and c like 'search_path=%' and c like '%extensions%'",
  // 021 canonicalizes legacy gorgias / gorgias-ticket-monitor project tags to
  // claimguard. Probe is NOT-EXISTS-shaped: returns 1 row when both legacy
  // tags carry zero rows (021's effects are in place OR the install never had
  // legacy data). Returns 0 rows when at least one legacy tag still has rows
  // (021 has not yet run). False-positive backfill costs nothing because the
  // migration's UPDATE is gated on `project IN ('gorgias', 'gorgias-ticket-monitor')`
  // so a re-apply against an already-canonicalized corpus is a 0-row no-op.
  // Sprint 62 T2 added this; 020 is bootstrap-special-cased and intentionally
  // absent from MIGRATION_PROBES.
  '021_project_tag_canonicalize_claimguard.sql':
    "select 1 where not exists (select 1 from memory_items where project in ('gorgias', 'gorgias-ticket-monitor'))",
  // 022 backfills source_agent for the rows where the writer is inferable from
  // row shape (Predicate A: decision/bug_fix/architecture/preference/code_context
  // → 'claude'; Predicate B: fact rows with source_session_id → 'claude';
  // Predicate D: document_chunk → 'orchestrator'). Predicate C (fact rows
  // with no session and no path) is intentionally NOT backfilled — see the
  // migration body for the provenance-preservation rationale. Probe is
  // NOT-EXISTS-shaped over the A/B/D row-set: returns 1 when those targets
  // all have source_agent set (022's effects in place), 0 when any A/B/D
  // target still has NULL (022 has not yet run). Excludes Predicate C from
  // the probe predicate so the residual NULL slice doesn't keep the probe
  // false forever. False-positive backfill costs nothing because the
  // migration body is gated on `source_agent IS NULL` and a re-apply against
  // an already-tagged corpus is a 0-row no-op. Sprint 62 T3.
  '022_source_agent_backfill.sql':
    "select 1 where not exists (select 1 from memory_items where source_agent is null and (source_type in ('decision','bug_fix','architecture','preference','code_context') or (source_type='fact' and source_session_id is not null) or source_type='document_chunk'))",
  // Sprint 81 T3 (ORCH R1) — 023-029 synced byte-identical from engram HEAD so
  // `termdeck init --mnestra` stops shadowing them (bundled-first). Probes are
  // presence-style; 025 is a COMMENT-only migration (no schema artifact → null,
  // like 003), so its first apply runs the COMMENT and the tracker prevents re-run.
  '023_privacy_tags_column.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_items' and column_name='privacy_tags'",
  '024_email_assistant_recall.sql':
    "select 1 from pg_proc where proname='email_assistant_recall'",
  '025_source_agent_web_surfaces.sql':
    null,
  '026_memory_inbox.sql':
    "select 1 from information_schema.tables where table_schema='public' and table_name='memory_inbox'",
  '027_recall_telemetry.sql':
    "select 1 from information_schema.tables where table_schema='public' and table_name='memory_recall_log'",
  '028_capture_gates.sql':
    "select 1 from pg_proc where proname='ingest_capture'",
  // 029 rewrites memory_hybrid_search with the doctrine ×1.5 type-weight + 365d
  // decay tier; probe the function BODY for 'doctrine' to distinguish it from
  // the pre-029 (002-era) version that only presence-matches on the name.
  '029_doctrine_recall_boost.sql':
    "select 1 from pg_proc where proname='memory_hybrid_search' and prosrc like '%doctrine%'",
  // Sprint 81 T1/T3 (ORCH R1 + R3) — 030-032. 030 redefines ingest_capture with
  // an ARBITER-FREE precompact branch (advisory-lock, no ON CONFLICT); presence
  // on the name matches from 028, so probe the BODY for the advisory lock to
  // distinguish 030's version. 031/032 probe their new columns.
  '030_precompact_rolling.sql':
    "select 1 from pg_proc where proname='ingest_capture' and prosrc like '%advisory_xact_lock%'",
  '031_recall_provenance.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_recall_log' and column_name='recall_group_id'",
  '032_recall_boost.sql':
    "select 1 from information_schema.columns where table_schema='public' and table_name='memory_items' and column_name='recall_boost'"
});

// Sprint 61 T2 — self-transactional detection.
//
// Bundled migrations 011 + 012 contain top-level `BEGIN;` and `COMMIT;`
// statements (011:75/217, 012:76/353). When the diff-apply loop wrapped
// these in its own outer BEGIN/COMMIT, the inner COMMIT closed the outer
// transaction prematurely and the subsequent `recordApplied` INSERT ran
// auto-committed — defeating the per-file atomicity contract. T4-CODEX
// audit-concern 2026-05-07 18:51 ET surfaced this.
//
// Detection: case-sensitive match for a line that is exactly `BEGIN;` or
// `COMMIT;` (top-level). PL/pgSQL anonymous block delimiters (`begin ... end`
// inside `do $$ ... $$`) use lowercase without trailing semicolon-on-its-
// own-line, so they don't match.
//
// Behavior for self-transactional migrations: SKIP the outer wrapper.
// Apply via pgRunner.applyFile (which sends the file as a single batched
// query, inner BEGIN/COMMIT handled by Postgres). Then INSERT the tracker
// row in a separate auto-commit. The tracker INSERT is recoverable on
// failure: 011/012 are idempotent (`WHERE project = 'chopin-nashville'`
// gates every UPDATE; re-running on an already-retagged install is a no-op),
// so a missing tracker row from a failed INSERT will be re-applied on the
// next pass and the INSERT retried. The brief explicitly notes this
// recovery shape under "out-of-T2 scope: rumen migration tracker."
function isSelfTransactional(sql) {
  return /^[ \t]*(BEGIN|COMMIT)[ \t]*;[ \t]*$/m.test(sql);
}

function listBundled(subdir) {
  const dir = path.join(SETUP_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f));
}

function tryNodeModules(packageName, migrationSubdir = 'migrations') {
  try {
    // Resolve the package's main file, then look for a migrations sibling dir.
    const pkgJsonPath = require.resolve(`${packageName}/package.json`, {
      paths: [process.cwd(), SETUP_DIR]
    });
    const pkgDir = path.dirname(pkgJsonPath);
    const migrationDir = path.join(pkgDir, migrationSubdir);
    if (!fs.existsSync(migrationDir)) return [];
    return fs.readdirSync(migrationDir)
      .filter((f) => f.toLowerCase().endsWith('.sql'))
      .sort()
      .map((f) => path.join(migrationDir, f));
  } catch (_err) {
    return [];
  }
}

function listMnestraMigrations() {
  // Bundled FIRST (v0.6.8+). See the file header for why — this prevents
  // a stale `@jhizzard/mnestra` install in global node_modules from
  // silently shadowing migrations TermDeck ships with the latest version.
  const bundled = listBundled('mnestra-migrations');
  if (bundled.length > 0) return bundled;
  return tryNodeModules('@jhizzard/mnestra');
}

function listRumenMigrations() {
  // Bundled FIRST (v0.6.8+). Same rationale as listMnestraMigrations —
  // a stale global `@jhizzard/rumen` cannot shadow newer bundled migrations.
  const bundled = listBundled(path.join('rumen', 'migrations'));
  if (bundled.length > 0) return bundled;
  return tryNodeModules('@jhizzard/rumen');
}

// Resolve the parent directory containing the bundled Rumen Edge Function
// source. Sprint 43 T3: bundled-FIRST (matches listMnestraMigrations and
// listRumenMigrations since v0.6.8). The npm `@jhizzard/rumen` package's
// `files` array is `["dist", "migrations", "README.md", "LICENSE",
// "CHANGELOG.md"]` — it does NOT ship `supabase/functions/`. So the npm
// fallback only ever matters for someone who has installed `@jhizzard/rumen`
// from a local checkout (not the published tarball). Bundled-first prevents
// a stale local rumen install from shadowing the source TermDeck developed
// and tested against.
//
// Returns the directory whose immediate children are the function-name
// subdirectories (e.g., `rumen-tick/`, `graph-inference/`).
function rumenFunctionsRoot() {
  const bundledRoot = path.join(SETUP_DIR, 'rumen', 'functions');
  if (fs.existsSync(bundledRoot) && fs.readdirSync(bundledRoot).length > 0) {
    return bundledRoot;
  }
  try {
    const pkgJsonPath = require.resolve('@jhizzard/rumen/package.json', {
      paths: [process.cwd(), SETUP_DIR]
    });
    const candidate = path.join(path.dirname(pkgJsonPath), 'supabase', 'functions');
    if (fs.existsSync(candidate)) return candidate;
  } catch (_err) { /* fallthrough */ }
  return bundledRoot;
}

// Enumerate the function-name subdirectories under the resolved Rumen
// functions root. Each entry must contain at least an `index.ts`. Sprint 43
// T3 bundled both `rumen-tick` and `graph-inference`.
function listRumenFunctions() {
  const root = rumenFunctionsRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => {
      const dir = path.join(root, name);
      return fs.statSync(dir).isDirectory()
        && fs.existsSync(path.join(dir, 'index.ts'));
    })
    .sort();
}

// Back-compat: pre-Sprint-43 callers expected a single path resolving to the
// `rumen-tick/` directory specifically. Delegates to rumenFunctionsRoot()
// + 'rumen-tick'. Prefer rumenFunctionsRoot() / listRumenFunctions() for new
// code that needs to operate over multiple functions.
function rumenFunctionDir() {
  return path.join(rumenFunctionsRoot(), 'rumen-tick');
}

function readFile(filepath) {
  return fs.readFileSync(filepath, 'utf-8');
}

// ── Sprint 61 T2 — durable migration tracker + diff-and-apply ──────────────
//
// applyPendingMigrations(client, opts) replaces the per-wizard
// "apply every bundled migration" loop with a tracker-aware diff loop:
//
//   1. Try `SELECT filename, checksum FROM public.mnestra_migrations`.
//      On 42P01 (relation does not exist), the project is pre-020 — bootstrap
//      by applying 020 directly, then INSERT 020's own tracker row, then
//      re-query.
//   2. Iterate bundled migrations 001..N in lex-filename order. For each
//      bundled file:
//        - Already in tracker: skip; if tracked checksum != bundled checksum,
//          push to warnings[] (do NOT auto-overwrite).
//        - Not in tracker AND probe says present: INSERT backfill row
//          (applied_at = '1970-01-01T00:00:00Z', schema_version = 'backfill'),
//          skip apply. (As of Sprint 61 T2 audit refinement, every bundled
//          migration 001-019 has a non-null probe in MIGRATION_PROBES; the
//          null-probe branch is preserved for forward-compatibility.)
//        - Not in tracker AND probe absent (or null probe):
//            * Self-transactional file (top-level BEGIN; / COMMIT;, currently
//              011/012): SKIP the outer wrapper. apply via pgRunner.applyFile
//              (the file's own transaction control runs through Postgres).
//              INSERT tracker row in a separate auto-commit. Tracker INSERT
//              failure is recoverable: re-running applyPendingMigrations
//              re-applies the migration (idempotent — the bundled self-tx
//              files are gated on chopin-nashville rows, no-op on subsequent
//              runs) and retries the tracker INSERT.
//            * Non-self-transactional file: BEGIN, apply via
//              pgRunner.applyFile, INSERT real tracker row, COMMIT. On
//              error, ROLLBACK and halt — record errored summary, do not
//              attempt subsequent migrations.
//
// Returns:
//   {
//     applied:     string[]                       // filenames applied this pass
//     skipped:     string[]                       // filenames already in tracker
//     backfilled:  string[]                       // filenames probe-seeded this pass
//     warnings:    Array<{ file, trackedChecksum, bundledChecksum }>
//     errored:     null | { file, error }
//   }
//
// Idempotent: a second invocation against an up-to-date project reports
// applied=[], backfilled=[], errored=null, and skipped=[...all bundled].
//
// Test injection (every dependency is replaceable):
//   opts._migrations  — module override for listMnestraMigrations / readFile
//                       (defaults to this module's own exports).
//   opts._readFile    — file-read shim (defaults to fs.readFileSync utf-8).
//   opts._applyFile   — pgRunner.applyFile shim (defaults to lazy-required
//                       ./pg-runner.applyFile to avoid pulling node-postgres
//                       at module-load time).
//   opts._probes      — MIGRATION_PROBES override (defaults to the constant).

function computeChecksum(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

// Lazy-resolve pgRunner.applyFile so callers in test environments can avoid
// the `require('pg')` cost. Tests override via opts._applyFile.
function defaultApplyFile() {
  const pgRunner = require('./pg-runner');
  return (client, file) => pgRunner.applyFile(client, file);
}

// Returns Map<filename, checksum> when the tracker exists, null when the
// table is missing (PG error code 42P01 — relation does not exist). Any
// other error propagates.
async function loadAppliedSet(client) {
  let res;
  try {
    res = await client.query(
      `SELECT filename, checksum FROM ${TRACKER_TABLE}`
    );
  } catch (err) {
    if (err && err.code === '42P01') return null;
    throw err;
  }
  const map = new Map();
  for (const row of (res && res.rows) || []) {
    map.set(row.filename, row.checksum);
  }
  return map;
}

// Pre-020 bootstrap: the tracker doesn't exist yet, so apply 020 to create
// it, then INSERT 020's own tracker row. Caller re-queries the tracker
// afterwards to pick up the seeded row.
async function bootstrapTracker(client, files, applyFile, readFileImpl) {
  const trackerPath = files.find(
    (f) => path.basename(f) === TRACKER_FILE
  );
  if (!trackerPath) {
    throw new Error(
      `applyPendingMigrations: bundled ${TRACKER_FILE} not found in migration set — ` +
      `the migration tracker cannot bootstrap. Re-publish the package or sync ` +
      `the engram migrations directory into packages/server/src/setup/mnestra-migrations/.`
    );
  }
  const result = await applyFile(client, trackerPath);
  if (!result || result.ok !== true) {
    const detail = (result && result.error) || 'apply returned not-ok with no error message';
    throw new Error(
      `applyPendingMigrations: failed to bootstrap tracker via ${TRACKER_FILE}: ${detail}`
    );
  }
  const sql = readFileImpl(trackerPath);
  const checksum = computeChecksum(sql);
  await client.query(
    `INSERT INTO ${TRACKER_TABLE} (filename, applied_at, checksum, schema_version) ` +
    `VALUES ($1, now(), $2, $3) ` +
    `ON CONFLICT (filename) DO UPDATE SET applied_at = EXCLUDED.applied_at, ` +
    `checksum = EXCLUDED.checksum, schema_version = EXCLUDED.schema_version`,
    [TRACKER_FILE, checksum, null]
  );
}

// Run a probe SQL string and return whether the schema artifact is present.
// Null probes always return false. Probe-side errors (e.g. relation does
// not exist when probing into the live schema) are swallowed and degrade
// to "absent" — same posture as audit-upgrade.js::probeOne. The artifact's
// real apply path will surface any underlying error with full context.
async function probePresent(client, probeSql) {
  if (!probeSql) return false;
  try {
    const res = await client.query(probeSql);
    return Array.isArray(res && res.rows) && res.rows.length > 0;
  } catch (_err) {
    return false;
  }
}

// Insert a backfill row for a migration whose probe came back present on
// a pre-020 install. applied_at is the epoch sentinel so audit queries
// can distinguish "applied at install" from "tracked from day one." The
// checksum is recorded too so future bundle drift can still be detected
// against backfilled rows.
async function recordBackfill(client, filename, checksum) {
  await client.query(
    `INSERT INTO ${TRACKER_TABLE} (filename, applied_at, checksum, schema_version) ` +
    `VALUES ($1, $2::timestamptz, $3, $4) ` +
    `ON CONFLICT (filename) DO NOTHING`,
    [filename, '1970-01-01T00:00:00Z', checksum, 'backfill']
  );
}

// Insert a real tracker row after a successful apply.
async function recordApplied(client, filename, checksum) {
  await client.query(
    `INSERT INTO ${TRACKER_TABLE} (filename, applied_at, checksum, schema_version) ` +
    `VALUES ($1, now(), $2, $3) ` +
    `ON CONFLICT (filename) DO UPDATE SET applied_at = EXCLUDED.applied_at, ` +
    `checksum = EXCLUDED.checksum, schema_version = EXCLUDED.schema_version`,
    [filename, checksum, null]
  );
}

async function applyPendingMigrations(client, opts = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('applyPendingMigrations: client with .query() is required');
  }

  const _migrations = opts._migrations || module.exports;
  const _readFile = opts._readFile || ((p) => fs.readFileSync(p, 'utf-8'));
  const _applyFile = opts._applyFile || defaultApplyFile();
  const _probes = opts._probes || MIGRATION_PROBES;

  const files = _migrations.listMnestraMigrations();
  if (!files || files.length === 0) {
    throw new Error(
      'applyPendingMigrations: no Mnestra migrations bundled — TermDeck install looks corrupted.'
    );
  }

  const summary = {
    applied: [],
    skipped: [],
    backfilled: [],
    warnings: [],
    errored: null
  };

  // Step 1: load applied-set (or bootstrap if missing).
  let applied = await loadAppliedSet(client);
  let bootstrapped = false;
  if (applied === null) {
    // Pre-020 — apply 020 + INSERT row.
    await bootstrapTracker(client, files, _applyFile, _readFile);
    bootstrapped = true;
    summary.applied.push(TRACKER_FILE);
    applied = await loadAppliedSet(client);
    if (applied === null) {
      throw new Error(
        'applyPendingMigrations: tracker still missing after bootstrap — ' +
        'check that 020_migration_tracking.sql actually created public.mnestra_migrations.'
      );
    }
  }

  // Step 2: iterate bundled files in lex order.
  for (const file of files) {
    const base = path.basename(file);

    // Tracker file: bootstrap already accounted for it in summary.applied.
    // On a non-bootstrap pass (post-020 install where 020 is in the tracker),
    // record as skipped. On any other state (tracker present but somehow
    // missing 020), fall through to the normal apply path so the diff loop
    // can re-record it.
    if (base === TRACKER_FILE) {
      if (bootstrapped) {
        // Already in summary.applied via bootstrap; do not duplicate.
        continue;
      }
      if (applied.has(TRACKER_FILE)) {
        summary.skipped.push(base);
        continue;
      }
      // Defensive fall-through: tracker exists (loadAppliedSet succeeded) but
      // doesn't have 020's row. Apply path below will re-record it.
    }

    let sql;
    try {
      sql = _readFile(file);
    } catch (err) {
      summary.errored = {
        file: base,
        error: err && err.message ? err.message : String(err)
      };
      return summary;
    }
    const checksum = computeChecksum(sql);

    if (applied.has(base)) {
      // Already applied — checksum-drift guard.
      const trackedChecksum = applied.get(base);
      if (trackedChecksum && trackedChecksum !== checksum) {
        summary.warnings.push({
          file: base,
          trackedChecksum,
          bundledChecksum: checksum
        });
      }
      summary.skipped.push(base);
      continue;
    }

    // Not applied. Try probe-backfill (only meaningful on pre-020 installs
    // that just bootstrapped, but cheap to evaluate on every pass; an
    // already-tracked migration short-circuits above before reaching here).
    const probeSql = Object.prototype.hasOwnProperty.call(_probes, base)
      ? _probes[base]
      : null;
    if (probeSql) {
      const present = await probePresent(client, probeSql);
      if (present) {
        try {
          await recordBackfill(client, base, checksum);
        } catch (err) {
          summary.errored = {
            file: base,
            error: `backfill INSERT failed: ${err && err.message ? err.message : String(err)}`
          };
          return summary;
        }
        summary.backfilled.push(base);
        applied.set(base, checksum);
        continue;
      }
    }

    // Genuinely needs apply. Self-transactional migrations (011, 012) ship
    // top-level BEGIN/COMMIT in their bodies — see isSelfTransactional + the
    // header comment near its definition. For those, skip the outer wrapper
    // and rely on the file's own transaction control + idempotency for
    // recovery on tracker INSERT failure. For everything else, wrap in
    // outer BEGIN/COMMIT for per-file atomicity (apply + tracker row commit
    // or roll back together).
    const selfTx = isSelfTransactional(sql);

    if (selfTx) {
      let applyResult;
      try {
        applyResult = await _applyFile(client, file);
      } catch (err) {
        summary.errored = {
          file: base,
          error: err && err.message ? err.message : String(err)
        };
        return summary;
      }
      if (!applyResult || applyResult.ok !== true) {
        summary.errored = {
          file: base,
          error: (applyResult && applyResult.error) || 'apply returned not-ok with no error message'
        };
        return summary;
      }
      try {
        await recordApplied(client, base, checksum);
      } catch (err) {
        summary.errored = {
          file: base,
          error: `tracker INSERT failed (self-transactional ${base} applied; re-run will replay it idempotently and retry the tracker insert): ${err && err.message ? err.message : String(err)}`
        };
        return summary;
      }
      summary.applied.push(base);
      applied.set(base, checksum);
      continue;
    }

    // Non-self-transactional path: outer BEGIN/COMMIT wrapper.
    try {
      await client.query('BEGIN');
    } catch (err) {
      summary.errored = {
        file: base,
        error: `BEGIN failed: ${err && err.message ? err.message : String(err)}`
      };
      return summary;
    }

    let applyResult;
    try {
      applyResult = await _applyFile(client, file);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* best-effort */ }
      summary.errored = {
        file: base,
        error: err && err.message ? err.message : String(err)
      };
      return summary;
    }

    if (!applyResult || applyResult.ok !== true) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* best-effort */ }
      summary.errored = {
        file: base,
        error: (applyResult && applyResult.error) || 'apply returned not-ok with no error message'
      };
      return summary;
    }

    try {
      await recordApplied(client, base, checksum);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_e) { /* best-effort */ }
      summary.errored = {
        file: base,
        error: `tracker INSERT failed: ${err && err.message ? err.message : String(err)}`
      };
      return summary;
    }

    summary.applied.push(base);
    applied.set(base, checksum);
  }

  return summary;
}

module.exports = {
  listMnestraMigrations,
  listRumenMigrations,
  rumenFunctionsRoot,
  listRumenFunctions,
  rumenFunctionDir,
  readFile,
  // Sprint 61 T2 — migration tracker.
  applyPendingMigrations,
  MIGRATION_PROBES,
  TRACKER_TABLE,
  TRACKER_FILE,
  // Test surface — kept exported so tests/migration-tracker.test.js can pin
  // each helper without a live pg client.
  _computeChecksum: computeChecksum,
  _loadAppliedSet: loadAppliedSet,
  _bootstrapTracker: bootstrapTracker,
  _probePresent: probePresent,
  _recordBackfill: recordBackfill,
  _recordApplied: recordApplied,
  _isSelfTransactional: isSelfTransactional
};
