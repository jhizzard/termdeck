// Sprint 59 — Brad #2 quote-strip tests.
//
// The Brad-#2 reproducer in .github/workflows/install-smoke.yml exports a
// literal-quoted DATABASE_URL into process.env (`export DATABASE_URL='"$URL"'`)
// then runs `termdeck init --mnestra --from-env --yes`. Pre-fix, the wizard's
// `looksLikePostgresUrl()` called `new URL("\"postgres://...\"")` and threw
// 'Invalid URL'. The fix strips a single pair of matched surrounding quotes
// at the validator boundary so a quoted env-var value gets the same handling
// as a quoted secrets.env line.
//
// Two surfaces, both covered here:
//   1. supabase-url helpers (parseProjectUrl, looksLikePostgresUrl, normalizeDatabaseUrl,
//      stripSurroundingQuotes) — defense-in-depth at the validator boundary.
//   2. dotenv-io writer (formatValue) — Sprint 59 contract: writer never adds
//      surrounding quotes to URL values that contain only `=` ambiguity. URLs
//      round-trip through write+read without picking up extra quotes.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const urlHelper = require(path.resolve(__dirname, '..', 'packages', 'server', 'src', 'setup', 'supabase-url.js'));
const dotenv = require(path.resolve(__dirname, '..', 'packages', 'server', 'src', 'setup', 'dotenv-io.js'));

const POSTGRES_URL = 'postgres://postgres.abcd:Pa55word@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
const SUPABASE_PROJECT_URL = 'https://abcdefghijklmnop.supabase.co';

// ── stripSurroundingQuotes ──────────────────────────────────────────────────

test('stripSurroundingQuotes — no quotes returns unchanged', () => {
  assert.equal(urlHelper.stripSurroundingQuotes(POSTGRES_URL), POSTGRES_URL);
});

test('stripSurroundingQuotes — double-quoted strips both', () => {
  assert.equal(urlHelper.stripSurroundingQuotes(`"${POSTGRES_URL}"`), POSTGRES_URL);
});

test('stripSurroundingQuotes — single-quoted strips both', () => {
  assert.equal(urlHelper.stripSurroundingQuotes(`'${POSTGRES_URL}'`), POSTGRES_URL);
});

test('stripSurroundingQuotes — mismatched quotes returns unchanged', () => {
  // `"foo'` is malformed, not "quoted with single", so leave it alone.
  assert.equal(urlHelper.stripSurroundingQuotes(`"${POSTGRES_URL}'`), `"${POSTGRES_URL}'`);
});

test('stripSurroundingQuotes — empty + single-char return unchanged', () => {
  assert.equal(urlHelper.stripSurroundingQuotes(''), '');
  assert.equal(urlHelper.stripSurroundingQuotes('"'), '"');
});

test('stripSurroundingQuotes — non-string returns input', () => {
  assert.equal(urlHelper.stripSurroundingQuotes(undefined), undefined);
  assert.equal(urlHelper.stripSurroundingQuotes(null), null);
  assert.equal(urlHelper.stripSurroundingQuotes(42), 42);
});

// ── looksLikePostgresUrl ────────────────────────────────────────────────────

test('looksLikePostgresUrl — accepts unquoted', () => {
  assert.equal(urlHelper.looksLikePostgresUrl(POSTGRES_URL), null);
});

test('looksLikePostgresUrl — accepts double-quoted (Brad #2 fix)', () => {
  // Pre-fix: returned 'not a valid URL' because `new URL('"postgres://..."')` threw.
  assert.equal(urlHelper.looksLikePostgresUrl(`"${POSTGRES_URL}"`), null);
});

test('looksLikePostgresUrl — accepts single-quoted', () => {
  assert.equal(urlHelper.looksLikePostgresUrl(`'${POSTGRES_URL}'`), null);
});

test('looksLikePostgresUrl — rejects non-postgres scheme', () => {
  assert.match(
    urlHelper.looksLikePostgresUrl('https://example.com/db'),
    /must start with postgres/
  );
});

// ── parseProjectUrl ─────────────────────────────────────────────────────────

test('parseProjectUrl — accepts unquoted Supabase URL', () => {
  const r = urlHelper.parseProjectUrl(SUPABASE_PROJECT_URL);
  assert.equal(r.ok, true);
  assert.equal(r.projectRef, 'abcdefghijklmnop');
});

test('parseProjectUrl — accepts double-quoted Supabase URL (Brad #2 fix)', () => {
  const r = urlHelper.parseProjectUrl(`"${SUPABASE_PROJECT_URL}"`);
  assert.equal(r.ok, true);
  assert.equal(r.projectRef, 'abcdefghijklmnop');
});

// ── normalizeDatabaseUrl ────────────────────────────────────────────────────

test('normalizeDatabaseUrl — strips quotes silently, modified=false on session pooler', () => {
  // Direct connection (not transaction-pooler), so no params get added.
  const direct = 'postgres://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres';
  const r = urlHelper.normalizeDatabaseUrl(`"${direct}"`);
  assert.equal(r.url, direct, 'returned URL has quotes stripped');
  assert.equal(r.modified, false, 'modified=false because no pgbouncer params added');
});

test('normalizeDatabaseUrl — strips quotes AND adds pgbouncer params on tx pooler', () => {
  const tx = 'postgres://postgres.abcd:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
  const r = urlHelper.normalizeDatabaseUrl(`"${tx}"`);
  assert.equal(r.modified, true, 'pgbouncer params got appended');
  assert.match(r.url, /pgbouncer=true/);
  assert.match(r.url, /connection_limit=1/);
  assert.ok(!r.url.startsWith('"'), 'quote stripped from output');
});

// ── dotenv writer no-quotes contract ────────────────────────────────────────

test('dotenv-io writeSecrets — DATABASE_URL written WITHOUT surrounding quotes (Sprint 59)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-quotes-'));
  const filepath = path.join(home, 'secrets.env');
  dotenv.writeSecrets({ DATABASE_URL: POSTGRES_URL }, filepath);
  const raw = fs.readFileSync(filepath, 'utf-8');
  // Must be exactly `DATABASE_URL=postgres://...` — no leading/trailing quotes.
  const line = raw.split('\n').find((l) => l.startsWith('DATABASE_URL='));
  assert.ok(line, 'DATABASE_URL line written');
  assert.equal(line, `DATABASE_URL=${POSTGRES_URL}`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dotenv-io writeSecrets — round-trip preserves URL value', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-quotes-rt-'));
  const filepath = path.join(home, 'secrets.env');
  dotenv.writeSecrets({
    DATABASE_URL: POSTGRES_URL,
    SUPABASE_URL: SUPABASE_PROJECT_URL,
    OPENAI_API_KEY: 'sk-proj-noquotes-needed-here',
    ANTHROPIC_API_KEY: 'sk-ant-also-no-quotes'
  }, filepath);
  const read = dotenv.readSecrets(filepath);
  assert.equal(read.DATABASE_URL, POSTGRES_URL);
  assert.equal(read.SUPABASE_URL, SUPABASE_PROJECT_URL);
  assert.equal(read.OPENAI_API_KEY, 'sk-proj-noquotes-needed-here');
  fs.rmSync(home, { recursive: true, force: true });
});

test('dotenv-io writeSecrets — values with whitespace still get quoted (no regression)', () => {
  // Only sanity-check the kept behavior; whitespace values genuinely DO need
  // quoting because dotenv parsers trim. Removing `=` from the regex must not
  // accidentally drop quoting for legitimate ambiguity.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-quotes-ws-'));
  const filepath = path.join(home, 'secrets.env');
  dotenv.writeSecrets({ MULTIWORD: 'foo bar baz' }, filepath);
  const raw = fs.readFileSync(filepath, 'utf-8');
  const line = raw.split('\n').find((l) => l.startsWith('MULTIWORD='));
  assert.equal(line, 'MULTIWORD="foo bar baz"');
  fs.rmSync(home, { recursive: true, force: true });
});
