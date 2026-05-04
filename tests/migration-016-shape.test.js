// Sprint 51.9 — structural fixtures for migration 016_mnestra_doctor_probes.sql.
//
// Pins the pg_cron conditional guard added 2026-05-04 after T3 caught
// fresh-install RED at 14:55 ET during Sprint 51.5b dogfood: mig 016
// referenced `cron.job_run_details` + `cron.job` in `language sql` function
// bodies, and Postgres parse-time-resolves identifiers in those, so CREATE
// failed when fresh Supabase projects (mnestra-only-no-rumen path) didn't
// have pg_cron enabled. Fix: split mig 016 into cron-independent (always
// applied) + cron-dependent (do$$ guard checks pg_extension first, runs
// EXECUTE only when pg_cron is enabled).
//
// We don't run a live Postgres in CI, so this test pins the migration's
// shape so a regression at file level (accidental delete of the do$$
// guard, accidental move of cron-dependent functions outside the guard,
// accidental scope-widening) fails loudly before the migration ever ships.
//
// What this test guarantees, in order of importance:
//   1. The file exists at the bundled mirror path.
//   2. The file is byte-identical to the Mnestra-repo primary copy.
//   3. The do$$ pg_cron conditional guard is present.
//   4. Cron-DEPENDENT functions (mnestra_doctor_cron_runs +
//      mnestra_doctor_cron_job_exists) appear ONLY inside the guard.
//   5. Cron-INDEPENDENT functions (mnestra_doctor_column_exists,
//      mnestra_doctor_rpc_exists, mnestra_doctor_vault_secret_exists)
//      appear OUTSIDE the guard (always applied).
//   6. Grants for cron-dependent functions are inside the guard.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '..');

const BUNDLED_PATH = path.join(
  repoRoot,
  'packages',
  'server',
  'src',
  'setup',
  'mnestra-migrations',
  '016_mnestra_doctor_probes.sql'
);

const MNESTRA_REPO_PATH = path.join(
  process.env.HOME || os.homedir(),
  'Documents',
  'Graciella',
  'engram',
  'migrations',
  '016_mnestra_doctor_probes.sql'
);

test('migration 016 exists in the bundled mnestra-migrations directory', () => {
  assert.ok(fs.existsSync(BUNDLED_PATH), `missing: ${BUNDLED_PATH}`);
});

test('bundled migration 016 is byte-identical to the Mnestra-repo primary copy', { skip: !fs.existsSync(MNESTRA_REPO_PATH) ? 'Mnestra repo not present on this machine' : false }, () => {
  const a = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const b = fs.readFileSync(MNESTRA_REPO_PATH, 'utf8');
  assert.equal(a, b, 'TermDeck bundled mirror has drifted from Mnestra repo primary');
});

test('migration 016 contains the do$$ pg_cron conditional guard', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // Match: do $cron_guard$ ... if exists ... pg_extension ... extname = 'pg_cron' ... end ... $cron_guard$;
  assert.match(
    sql,
    /do\s+\$cron_guard\$[\s\S]*?if\s+exists[\s\S]*?pg_extension[\s\S]*?extname\s*=\s*'pg_cron'[\s\S]*?end[\s\S]*?\$cron_guard\$/i,
    'expected do$cron_guard$ block checking pg_extension for extname=pg_cron'
  );
});

test('migration 016 cron-DEPENDENT functions appear ONLY inside the do$$ guard', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const guardMatch = sql.match(/do\s+\$cron_guard\$([\s\S]*?)\$cron_guard\$/i);
  assert.ok(guardMatch, 'do$cron_guard$ block missing');
  const insideGuard = guardMatch[1];
  const outsideGuard = sql.replace(/do\s+\$cron_guard\$[\s\S]*?\$cron_guard\$/i, '');

  // mnestra_doctor_cron_runs: must be inside guard, not outside
  assert.match(insideGuard, /mnestra_doctor_cron_runs/i, 'mnestra_doctor_cron_runs must appear inside the guard');
  assert.doesNotMatch(
    outsideGuard.replace(/--.*$/gm, ''), // strip line comments — docstrings can mention names freely
    /create\s+or\s+replace\s+function\s+mnestra_doctor_cron_runs/i,
    'mnestra_doctor_cron_runs must NOT have a CREATE OR REPLACE outside the guard'
  );

  // mnestra_doctor_cron_job_exists: same constraint
  assert.match(insideGuard, /mnestra_doctor_cron_job_exists/i, 'mnestra_doctor_cron_job_exists must appear inside the guard');
  assert.doesNotMatch(
    outsideGuard.replace(/--.*$/gm, ''),
    /create\s+or\s+replace\s+function\s+mnestra_doctor_cron_job_exists/i,
    'mnestra_doctor_cron_job_exists must NOT have a CREATE OR REPLACE outside the guard'
  );
});

test('migration 016 cron-INDEPENDENT functions are OUTSIDE the guard (always applied)', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const outsideGuard = sql.replace(/do\s+\$cron_guard\$[\s\S]*?\$cron_guard\$/i, '');

  for (const fname of ['mnestra_doctor_column_exists', 'mnestra_doctor_rpc_exists', 'mnestra_doctor_vault_secret_exists']) {
    assert.match(
      outsideGuard,
      new RegExp(`create\\s+or\\s+replace\\s+function\\s+${fname}\\b`, 'i'),
      `${fname} must have a CREATE OR REPLACE outside the guard (cron-independent — always applies)`
    );
  }
});

test('migration 016 grants for cron-dependent functions are inside the guard', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const guardMatch = sql.match(/do\s+\$cron_guard\$([\s\S]*?)\$cron_guard\$/i);
  assert.ok(guardMatch);
  const insideGuard = guardMatch[1];
  // Both grants must be inside the guard (otherwise the GRANT itself fails when functions don't exist on a fresh project).
  assert.match(insideGuard, /grant\s+execute\s+on\s+function\s+mnestra_doctor_cron_runs/i, 'cron_runs grant must be inside guard');
  assert.match(insideGuard, /grant\s+execute\s+on\s+function\s+mnestra_doctor_cron_job_exists/i, 'cron_job_exists grant must be inside guard');
});

test('migration 016 does not use CREATE EXTENSION pg_cron (Option B was rejected)', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // Option B (auto-enable pg_cron from the migration) was rejected per T3's recommendation —
  // it couples mnestra to a cron extension it doesn't otherwise need. We use Option A
  // (conditional skip) instead. Pin: don't accidentally regress to Option B.
  assert.doesNotMatch(
    sql,
    /create\s+extension\s+(if\s+not\s+exists\s+)?pg_cron\b/i,
    'mig 016 must not auto-enable pg_cron — that was the rejected Option B'
  );
});
