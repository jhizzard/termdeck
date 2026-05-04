// Sprint 52.1 — structural fixtures for migration 001_mnestra_tables.sql.
//
// Pins the signature-drift guard added 2026-05-04 to handle existing
// v0.6.x-era installs (Joshua's petvetbid, Brad's jizzard-brain) where
// `match_memories` was created with a different RETURN-table column order.
// Postgres rejects `CREATE OR REPLACE FUNCTION` when the return-table
// shape changes — the migration replay throws `cannot change return type
// of existing function` and the wizard exits 5. The do$$ block drops all
// `public.match_memories` overloads regardless of arg list before the
// CREATE OR REPLACE, so the migration replays cleanly on greenfield AND
// existing-drift installs.
//
// We don't run a live Postgres in CI, so this test pins the migration's
// shape so a regression at file level (accidental delete of the do-block,
// accidental scope-widening, accidental CASCADE addition, accidental
// schema-scope removal) fails loudly before the migration ever ships.
//
// What this test guarantees, in order of importance:
//   1. The file exists at the bundled mirror path.
//   2. The file is byte-identical to the Mnestra-repo primary copy. The
//      release process depends on this — `@jhizzard/mnestra` ships from
//      the Mnestra repo and `@jhizzard/termdeck` ships the bundled mirror.
//      They MUST match or fresh installs diverge.
//   3. The do$$ signature-drift guard is present immediately before the
//      `create or replace function match_memories` block.
//   4. The guard scopes to schema `public` (so a same-named function in
//      another schema is never touched).
//   5. The guard does NOT use `CASCADE` (so a true hard dependency
//      surfaces as a loud error rather than silent destruction of
//      dependent objects).
//   6. The canonical match_memories return-table column order is preserved
//      — `(id, content, source_type, category, project, metadata,
//      similarity)`, not the v0.6.x-era drift order which had `metadata`
//      before `source_type` and a trailing `created_at`.

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
  '001_mnestra_tables.sql'
);

const MNESTRA_REPO_PATH = path.join(
  process.env.HOME || os.homedir(),
  'Documents',
  'Graciella',
  'engram',
  'migrations',
  '001_mnestra_tables.sql'
);

test('migration 001 exists in the bundled mnestra-migrations directory', () => {
  assert.ok(fs.existsSync(BUNDLED_PATH), `missing: ${BUNDLED_PATH}`);
});

test('bundled migration 001 is byte-identical to the Mnestra-repo primary copy', { skip: !fs.existsSync(MNESTRA_REPO_PATH) ? 'Mnestra repo not present on this machine' : false }, () => {
  const a = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const b = fs.readFileSync(MNESTRA_REPO_PATH, 'utf8');
  assert.equal(a, b, 'TermDeck bundled mirror has drifted from Mnestra repo primary');
});

test('migration 001 contains the do$$ signature-drift guard before match_memories', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // The guard must appear textually before the create-or-replace.
  const guardIdx = sql.search(/do\s+\$\$[\s\S]*?from\s+pg_proc[\s\S]*?match_memories[\s\S]*?end\s+\$\$;/i);
  const createIdx = sql.search(/create\s+or\s+replace\s+function\s+match_memories\b/i);
  assert.ok(guardIdx >= 0, 'expected do$$ block referencing pg_proc + match_memories');
  assert.ok(createIdx >= 0, 'expected create or replace function match_memories');
  assert.ok(guardIdx < createIdx, 'do$$ guard must precede create or replace function match_memories');
});

test('migration 001 scopes the drift guard to schema public', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // The do-block must filter by nspname = 'public' — a guard that drops
  // match_memories from any schema would reach into user-authored work.
  const block = sql.match(/do\s+\$\$[\s\S]*?end\s+\$\$;/i);
  assert.ok(block, 'do$$ block missing');
  assert.match(
    block[0],
    /nspname\s*=\s*'public'/i,
    'drift guard must scope to schema public — got an unscoped DROP loop',
  );
});

test('migration 001 drift guard does NOT use CASCADE', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const block = sql.match(/do\s+\$\$[\s\S]*?end\s+\$\$;/i);
  assert.ok(block, 'do$$ block missing');
  // CASCADE on a function drop would silently destroy any view, generated
  // column, or other hard dependency. We want the drop to fail loud if
  // such a dependency ever shows up — that's a signal worth surfacing.
  assert.doesNotMatch(
    block[0],
    /\bcascade\b/i,
    'drift guard must not use CASCADE — that would silently drop dependent objects',
  );
});

test('migration 001 drift guard iterates pg_proc with regprocedure execute', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const block = sql.match(/do\s+\$\$[\s\S]*?end\s+\$\$;/i);
  assert.ok(block, 'do$$ block missing');
  // Pin the iteration shape: `for r in select ... from pg_proc ... where proname = 'match_memories'`
  // followed by `execute 'drop function ' || r.sig::text` (or equivalent).
  assert.match(block[0], /for\s+\w+\s+in/i, 'expected a for-loop over pg_proc rows');
  assert.match(block[0], /pg_proc/i, 'expected pg_proc enumeration');
  assert.match(block[0], /proname\s*=\s*'match_memories'/i, "expected proname = 'match_memories' filter");
  assert.match(block[0], /execute\s+'drop function/i, 'expected dynamic execute "drop function"');
});

test('migration 001 preserves the canonical match_memories return-table column order', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // Find the `returns table (...)` block immediately following
  // `create or replace function match_memories`.
  const m = sql.match(/create\s+or\s+replace\s+function\s+match_memories\b[\s\S]*?returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  assert.ok(m, 'could not find match_memories returns-table block');
  const cols = m[1]
    .split(',')
    .map((c) => c.trim().split(/\s+/)[0].toLowerCase())
    .filter((name) => name && !name.startsWith('--'));
  assert.deepEqual(
    cols,
    ['id', 'content', 'source_type', 'category', 'project', 'metadata', 'similarity'],
    'return-table column order drifted from canonical (Sprint 52.1 fixed v0.6.x-era drift in this exact spot)',
  );
});

test("migration 001 does not contain a stale 'created_at' in the match_memories return-table", () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const m = sql.match(/create\s+or\s+replace\s+function\s+match_memories\b[\s\S]*?returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  assert.ok(m);
  // The v0.6.x-era drift had a trailing `created_at` column in the
  // return-table that the canonical shape removed. Pin the canonical:
  // no `created_at` in the return-table.
  assert.doesNotMatch(
    m[1],
    /\bcreated_at\b/i,
    "match_memories return-table must not contain `created_at` (that's the v0.6.x-era drift shape)",
  );
});
