// Sprint 42 T3 — pure unit tests for the migration-templating helper.
//
// Covers: both placeholder syntaxes, no-placeholder pass-through,
// idempotency, missing-vars throw, multi-occurrence substitution, and
// integration against the actual bundled migrations 002 + 003.
//
// Run: node --test tests/migration-templating.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { applyTemplating } = require(
  '../packages/server/src/setup/migration-templating'
);

const MIGRATIONS_DIR = path.resolve(
  __dirname, '..', 'packages', 'server', 'src', 'setup', 'rumen', 'migrations'
);

test('substitutes <project-ref> with the supplied value', () => {
  const sql = "url := 'https://<project-ref>.supabase.co/functions/v1/foo';";
  const out = applyTemplating(sql, { projectRef: 'abcdefghij' });
  assert.equal(out, "url := 'https://abcdefghij.supabase.co/functions/v1/foo';");
});

test('also accepts {{PROJECT_REF}} sigil syntax', () => {
  const sql = 'host := {{PROJECT_REF}}.supabase.co;';
  const out = applyTemplating(sql, { projectRef: 'xyz' });
  assert.equal(out, 'host := xyz.supabase.co;');
});

test('substitutes every occurrence, not just the first', () => {
  const sql = '<project-ref> <project-ref> {{PROJECT_REF}}';
  const out = applyTemplating(sql, { projectRef: 'qq' });
  assert.equal(out, 'qq qq qq');
});

test('passes through SQL with no placeholders unchanged', () => {
  const sql = 'SELECT 1;\n-- nothing to substitute here\nSELECT 2;';
  assert.equal(applyTemplating(sql, { projectRef: 'irrelevant' }), sql);
  assert.equal(applyTemplating(sql, {}), sql);
  assert.equal(applyTemplating(sql), sql);
});

test('is idempotent: applying twice yields the same result', () => {
  const sql = "url := 'https://<project-ref>.supabase.co/x';";
  const once = applyTemplating(sql, { projectRef: 'abc' });
  const twice = applyTemplating(once, { projectRef: 'abc' });
  assert.equal(once, twice);
});

test('throws when projectRef placeholder present but vars missing', () => {
  const sql = "url := 'https://<project-ref>.supabase.co/x';";
  assert.throws(() => applyTemplating(sql, {}), /projectRef/);
  assert.throws(() => applyTemplating(sql), /projectRef/);
  assert.throws(() => applyTemplating(sql, { projectRef: '' }), /projectRef/);
  assert.throws(() => applyTemplating(sql, { projectRef: null }), /projectRef/);
});

test('throws on non-string sql input', () => {
  assert.throws(() => applyTemplating(undefined, { projectRef: 'x' }), /string/);
  assert.throws(() => applyTemplating(null, { projectRef: 'x' }), /string/);
  assert.throws(() => applyTemplating(42, { projectRef: 'x' }), /string/);
});

test('substituted SQL contains no remaining <project-ref> markers', () => {
  const sql = "a <project-ref> b {{PROJECT_REF}} c";
  const out = applyTemplating(sql, { projectRef: 'r' });
  assert.doesNotMatch(out, /<project-ref>/);
  assert.doesNotMatch(out, /\{\{PROJECT_REF\}\}/);
});

// Integration against the actual bundled files — pins the contract that
// 002 + 003 each contain a `<project-ref>` placeholder that the helper
// consumes cleanly. Catches the bug where someone removes the placeholder
// from the bundled SQL but forgets to update the apply path.
test('bundled migration 002 has a project-ref placeholder and templates cleanly', () => {
  const file = path.join(MIGRATIONS_DIR, '002_pg_cron_schedule.sql');
  const raw = fs.readFileSync(file, 'utf8');
  // Body (cron-call URL) MUST have the placeholder — the comment block above
  // it also mentions <project-ref>, so a substring check is enough.
  assert.match(raw, /<project-ref>/);
  const out = applyTemplating(raw, { projectRef: 'xxxxxxxxxxxxxxxxxxxx' });
  assert.match(out, /https:\/\/xxxxxxxxxxxxxxxxxxxx\.supabase\.co\/functions\/v1\/rumen-tick/);
  assert.doesNotMatch(out, /<project-ref>/);
});

test('bundled migration 003 has a project-ref placeholder and templates cleanly', () => {
  const file = path.join(MIGRATIONS_DIR, '003_graph_inference_schedule.sql');
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /<project-ref>/);
  const out = applyTemplating(raw, { projectRef: 'xxxxxxxxxxxxxxxxxxxx' });
  assert.match(out, /https:\/\/xxxxxxxxxxxxxxxxxxxx\.supabase\.co\/functions\/v1\/graph-inference/);
  assert.doesNotMatch(out, /<project-ref>/);
});
