// Regression tests for normalizeDatabaseUrl() and isTransactionPoolerUrl()
// in packages/server/src/setup/supabase-url.js (v0.6.6 candidate).
//
// Background: Brad's 2026-04-26 Rumen logs warned:
//   "[rumen] DATABASE_URL is a Shared Pooler URL but does not have
//    ?pgbouncer=true. Append ?pgbouncer=true&connection_limit=1 for
//    transaction-mode compatibility."
//
// v0.6.6 auto-appends those params on transaction-pooler URLs at wizard
// write time, and again at init-rumen read time so partial-upgrade installs
// still get a clean URL handed to the Edge Function. These fixtures pin the
// detection rules and the modify-only-when-needed contract.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { normalizeDatabaseUrl, isTransactionPoolerUrl } = require(
  path.resolve(__dirname, '..', 'packages', 'server', 'src', 'setup', 'supabase-url.js')
);

// Helper — pull the just-set query params out of a normalized URL string so
// assertions don't depend on URL.toString() ordering quirks.
function paramsOf(urlString) {
  return new URL(urlString).searchParams;
}

// ── Detection: only transaction-pooler shape (host *.pooler.supabase.com + 6543) ──

test('isTransactionPoolerUrl: aws-0 transaction pooler at 6543 is detected', () => {
  const u = new URL('postgres://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
  assert.equal(isTransactionPoolerUrl(u), true);
});

test('isTransactionPoolerUrl: session-mode pooler (port 5432) is NOT detected', () => {
  const u = new URL('postgres://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres');
  assert.equal(isTransactionPoolerUrl(u), false);
});

test('isTransactionPoolerUrl: direct db.<ref>.supabase.co URL is NOT detected', () => {
  const u = new URL('postgres://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres');
  assert.equal(isTransactionPoolerUrl(u), false);
});

test('isTransactionPoolerUrl: non-Supabase host is NOT detected', () => {
  const u = new URL('postgres://user:pw@my-self-hosted-pg.example.com:6543/mydb');
  assert.equal(isTransactionPoolerUrl(u), false);
});

test('isTransactionPoolerUrl: future regional prefix (gcp-1, etc) at *.pooler.supabase.com:6543 still detected', () => {
  // Future-proof: don't pin the regional prefix beyond `.pooler.supabase.com`.
  const u = new URL('postgres://postgres.abc:pw@gcp-1-eu-central-2.pooler.supabase.com:6543/postgres');
  assert.equal(isTransactionPoolerUrl(u), true);
});

// ── Brad's exact case: transaction pooler missing pgbouncer params ──

test('normalizeDatabaseUrl: transaction pooler missing pgbouncer gets both params appended', () => {
  const input = 'postgres://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
  const result = normalizeDatabaseUrl(input);

  assert.equal(result.modified, true);
  const params = paramsOf(result.url);
  assert.equal(params.get('pgbouncer'), 'true');
  assert.equal(params.get('connection_limit'), '1');

  // Hostname / port / credentials must be preserved exactly.
  const u = new URL(result.url);
  assert.equal(u.hostname, 'aws-0-us-east-1.pooler.supabase.com');
  assert.equal(u.port, '6543');
  assert.equal(u.username, 'postgres.abc');
});

// ── Idempotence: don't double-append, don't override user choice ──

test('normalizeDatabaseUrl: URL already has pgbouncer=true is unchanged', () => {
  const input = 'postgres://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
  const result = normalizeDatabaseUrl(input);

  assert.equal(result.modified, false);
  assert.equal(result.url, input);
});

test('normalizeDatabaseUrl: URL with pgbouncer=true and a different connection_limit is left alone', () => {
  // User intent — don't overwrite a chosen connection_limit even if we'd
  // have set 1 ourselves.
  const input = 'postgres://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5';
  const result = normalizeDatabaseUrl(input);

  assert.equal(result.modified, false);
  assert.equal(result.url, input);
});

test('normalizeDatabaseUrl: URL with connection_limit but no pgbouncer gets pgbouncer added; connection_limit preserved', () => {
  // Edge case: user set connection_limit but forgot pgbouncer. We add pgbouncer
  // and leave their connection_limit alone.
  const input = 'postgres://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?connection_limit=3';
  const result = normalizeDatabaseUrl(input);

  assert.equal(result.modified, true);
  const params = paramsOf(result.url);
  assert.equal(params.get('pgbouncer'), 'true');
  assert.equal(params.get('connection_limit'), '3');  // preserved, not overwritten
});

// ── Don't touch URLs that don't need it ──

test('normalizeDatabaseUrl: direct connection URL (port 5432, db.* hostname) is unchanged', () => {
  const input = 'postgres://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres';
  const result = normalizeDatabaseUrl(input);

  assert.equal(result.modified, false);
  assert.equal(result.url, input);
});

test('normalizeDatabaseUrl: session-mode pooler URL (port 5432 on pooler hostname) is unchanged', () => {
  const input = 'postgres://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
  const result = normalizeDatabaseUrl(input);

  assert.equal(result.modified, false);
  assert.equal(result.url, input);
});

test('normalizeDatabaseUrl: non-Supabase URL is unchanged even if it looks pooler-shaped', () => {
  const input = 'postgres://user:pw@my-self-hosted-pg.example.com:6543/mydb';
  const result = normalizeDatabaseUrl(input);

  assert.equal(result.modified, false);
  assert.equal(result.url, input);
});

// ── Other query params are preserved alongside the new ones ──

test('normalizeDatabaseUrl: existing unrelated query params are preserved', () => {
  const input = 'postgres://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&application_name=rumen';
  const result = normalizeDatabaseUrl(input);

  assert.equal(result.modified, true);
  const params = paramsOf(result.url);
  assert.equal(params.get('pgbouncer'), 'true');
  assert.equal(params.get('connection_limit'), '1');
  assert.equal(params.get('sslmode'), 'require');
  assert.equal(params.get('application_name'), 'rumen');
});

// ── Defensive: malformed input should not throw ──

test('normalizeDatabaseUrl: empty / null / non-string input returns gracefully', () => {
  for (const bad of ['', null, undefined, 42]) {
    const result = normalizeDatabaseUrl(bad);
    assert.equal(result.modified, false);
    assert.equal(result.url, bad);
  }
});

test('normalizeDatabaseUrl: unparseable URL returns the original unchanged', () => {
  const input = 'not a url at all';
  const result = normalizeDatabaseUrl(input);
  assert.equal(result.modified, false);
  assert.equal(result.url, input);
});
