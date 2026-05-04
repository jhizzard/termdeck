// Sprint 51.9 — structural fixtures for migration 002_mnestra_search_function.sql.
//
// Pins the signature-drift guard added 2026-05-04 to handle existing
// v0.6.x-era installs where `memory_hybrid_search` was created with a
// 10-arg drift overload (extra `recency_weight`/`decay_days` parameters
// from a pre-canonical Mnestra iteration or the rag-system writer's
// bootstrap) coexisting with the canonical 8-arg signature. PostgREST +
// MCP clients hit ambiguous-overload errors. Codex T4-CODEX surfaced
// this 2026-05-04 14:42 ET during Sprint 51.5b dogfood when their
// MCP-wired memory_recall failed against petvetbid.
//
// Same do$$ pattern as mig 001's match_memories guard (Sprint 52.1).
// We don't run a live Postgres in CI, so this test pins the migration's
// shape so a regression at file level (accidental delete of the do-block,
// scope widening, CASCADE addition, schema-scope removal) fails loudly
// before the migration ever ships.

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
  '002_mnestra_search_function.sql'
);

const MNESTRA_REPO_PATH = path.join(
  process.env.HOME || os.homedir(),
  'Documents',
  'Graciella',
  'engram',
  'migrations',
  '002_mnestra_search_function.sql'
);

test('migration 002 exists in the bundled mnestra-migrations directory', () => {
  assert.ok(fs.existsSync(BUNDLED_PATH), `missing: ${BUNDLED_PATH}`);
});

test('bundled migration 002 is byte-identical to the Mnestra-repo primary copy', { skip: !fs.existsSync(MNESTRA_REPO_PATH) ? 'Mnestra repo not present on this machine' : false }, () => {
  const a = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const b = fs.readFileSync(MNESTRA_REPO_PATH, 'utf8');
  assert.equal(a, b, 'TermDeck bundled mirror has drifted from Mnestra repo primary');
});

test('migration 002 contains the do$$ signature-drift guard before memory_hybrid_search', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // The guard must appear textually before the create-or-replace.
  const guardIdx = sql.search(/do\s+\$\$[\s\S]*?from\s+pg_proc[\s\S]*?memory_hybrid_search[\s\S]*?end\s+\$\$;/i);
  const createIdx = sql.search(/create\s+or\s+replace\s+function\s+memory_hybrid_search\b/i);
  assert.ok(guardIdx >= 0, 'expected do$$ block referencing pg_proc + memory_hybrid_search');
  assert.ok(createIdx >= 0, 'expected create or replace function memory_hybrid_search');
  assert.ok(guardIdx < createIdx, 'do$$ guard must precede create or replace function memory_hybrid_search');
});

test('migration 002 scopes the drift guard to schema public', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const block = sql.match(/do\s+\$\$[\s\S]*?end\s+\$\$;/i);
  assert.ok(block, 'do$$ block missing');
  assert.match(
    block[0],
    /nspname\s*=\s*'public'/i,
    'drift guard must scope to schema public — got an unscoped DROP loop',
  );
});

test('migration 002 drift guard does NOT use CASCADE', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const block = sql.match(/do\s+\$\$[\s\S]*?end\s+\$\$;/i);
  assert.ok(block, 'do$$ block missing');
  assert.doesNotMatch(
    block[0],
    /\bcascade\b/i,
    'drift guard must not use CASCADE — that would silently drop dependent objects',
  );
});

test('migration 002 drift guard iterates pg_proc with regprocedure execute', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  const block = sql.match(/do\s+\$\$[\s\S]*?end\s+\$\$;/i);
  assert.ok(block, 'do$$ block missing');
  assert.match(block[0], /for\s+\w+\s+in/i, 'expected a for-loop over pg_proc rows');
  assert.match(block[0], /pg_proc/i, 'expected pg_proc enumeration');
  assert.match(block[0], /proname\s*=\s*'memory_hybrid_search'/i, "expected proname = 'memory_hybrid_search' filter");
  assert.match(block[0], /execute\s+'drop function/i, 'expected dynamic execute "drop function"');
});

test('migration 002 preserves the canonical 8-arg memory_hybrid_search signature', () => {
  const sql = fs.readFileSync(BUNDLED_PATH, 'utf8');
  // Find the function arg list immediately following CREATE OR REPLACE.
  const m = sql.match(/create\s+or\s+replace\s+function\s+memory_hybrid_search\s*\(([\s\S]*?)\)\s*returns/i);
  assert.ok(m, 'could not find memory_hybrid_search arg list');
  const argLines = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  // Strip default-value clauses; just count + name args.
  const argNames = argLines.map((line) => line.split(/\s+/)[0]);
  assert.deepEqual(
    argNames,
    [
      'query_text',
      'query_embedding',
      'match_count',
      'full_text_weight',
      'semantic_weight',
      'rrf_k',
      'filter_project',
      'filter_source_type',
    ],
    'memory_hybrid_search arg list drifted from canonical 8-arg shape (Sprint 51.9 fixed the 10-arg drift overload in this exact spot)',
  );
});
