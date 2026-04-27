// Sprint 38 (T1) — structural fixtures for migration 009_memory_relationship_metadata.sql.
//
// We don't run a live Postgres in CI, so this test pins the migration's
// shape so a regression at file level (accidental delete, accidental edit
// dropping the DO block, accidental rename) fails loudly before the
// migration ever ships.
//
// What this test guarantees, in order of importance:
//   1. The file exists at the bundled mirror path.
//   2. The file is byte-identical to the Mnestra-repo primary copy. The
//      release process depends on this — `@jhizzard/mnestra@0.3.0` ships
//      from the Mnestra repo and `@jhizzard/termdeck@0.10.0` ships the
//      bundled mirror. They MUST match or fresh installs diverge from
//      `npm i -g @jhizzard/mnestra` installs.
//   3. The migration is idempotent (uses IF NOT EXISTS / OR REPLACE / DO
//      block for the anonymous-CHECK drop).
//   4. The expanded vocabulary covers all 8 relationship types.
//   5. The recursive CTE wires up cycle protection (NOT … = ANY(path)).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

const BUNDLED_PATH = path.join(
  repoRoot,
  'packages',
  'server',
  'src',
  'setup',
  'mnestra-migrations',
  '009_memory_relationship_metadata.sql'
);

const MNESTRA_REPO_PATH = path.join(
  process.env.HOME || require('node:os').homedir(),
  'Documents',
  'Graciella',
  'engram',
  'migrations',
  '009_memory_relationship_metadata.sql'
);

test('migration 009 exists in the bundled mnestra-migrations directory', () => {
  assert.ok(fs.existsSync(BUNDLED_PATH), `missing: ${BUNDLED_PATH}`);
});

test('bundled migration 009 is byte-identical to the Mnestra-repo primary copy', { skip: !fs.existsSync(MNESTRA_REPO_PATH) ? 'Mnestra repo not present on this machine' : false }, () => {
  const a = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const b = fs.readFileSync(MNESTRA_REPO_PATH, 'utf8');
  assert.equal(a, b, 'TermDeck bundled mirror has drifted from Mnestra repo primary');
});

test('migration 009 adds weight, inferred_at, inferred_by columns idempotently', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  assert.match(sql, /add column if not exists weight\s+float/i);
  assert.match(sql, /add column if not exists inferred_at\s+timestamptz/i);
  assert.match(sql, /add column if not exists inferred_by\s+text/i);
});

test('migration 009 drops the anonymous old CHECK via a DO block, not a hardcoded constraint name', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // The old constraint is anonymous (auto-named by Postgres). A naive
  // DROP CONSTRAINT IF EXISTS would silently no-op against the live DB.
  // Pin that we use a DO/PLPGSQL block walking pg_constraint instead.
  assert.match(sql, /do \$\$/i, 'expected a PL/pgSQL DO block to drop the anonymous CHECK');
  assert.match(sql, /pg_constraint/i, 'DO block should walk pg_constraint to find the anonymous CHECK');
  assert.match(sql, /pg_get_constraintdef/i, 'DO block should match by constraint definition (relationship_type IN)');
});

test('migration 009 expanded CHECK accepts all 8 relationship types', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const types = [
    'supersedes',
    'relates_to',
    'contradicts',
    'elaborates',
    'caused_by',
    'blocks',
    'inspired_by',
    'cross_project_link',
  ];
  for (const t of types) {
    assert.ok(
      sql.includes(`'${t}'`),
      `expanded CHECK is missing relationship type "${t}"`
    );
  }
});

test('migration 009 expanded CHECK uses the underscore convention (no hyphens)', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // PLANNING.md proposed hyphen forms (relates-to / inspired-by / cross-project-link)
  // which would collide with the existing 749 underscore-form rows. Pin the fix.
  assert.equal(sql.includes("'relates-to'"), false, 'hyphen form must not appear');
  assert.equal(sql.includes("'inspired-by'"), false, 'hyphen form must not appear');
  assert.equal(sql.includes("'cross-project-link'"), false, 'hyphen form must not appear');
});

test('migration 009 adds partial indexes on weight and inferred_at', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  assert.match(
    sql,
    /create index if not exists memory_relationships_weight_idx[\s\S]*where weight is not null/i
  );
  assert.match(
    sql,
    /create index if not exists memory_relationships_inferred_at_idx[\s\S]*where inferred_at is not null/i
  );
});

test('migration 009 ships expand_memory_neighborhood as a recursive CTE with cycle protection', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  assert.match(sql, /create or replace function expand_memory_neighborhood/i);
  assert.match(sql, /with recursive neighborhood as/i);
  // Cycle protection: the next-hop node must not already be in path[].
  assert.match(sql, /not\s*\(\s*case when r\.source_id = n\.memory_id[\s\S]*= any \(n\.path\)/i);
});

test('migration 009 expand_memory_neighborhood signature returns (memory_id, depth, path, edge_kinds)', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // Pin the public RETURNS TABLE shape — T3 (graph-aware recall) and T4
  // (graph viz endpoints) both depend on these column names.
  assert.match(sql, /returns table\s*\(\s*memory_id\s+uuid/i);
  assert.match(sql, /depth\s+int/i);
  assert.match(sql, /path\s+uuid\[\]/i);
  assert.match(sql, /edge_kinds\s+text\[\]/i);
});

test('migration 009 max_depth has a default value of 2', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  assert.match(sql, /max_depth\s+int\s+default\s+2/i);
});
