// Sprint 75 T2 (part B3) — DATABASE_URL endpoint-shape classifier tests.
//
// classifyDbEndpoint + directEndpointWarningLines in
// packages/server/src/setup/supabase-url.js are a CommonJS port of engram's
// src/db-endpoint.ts (Sprint 74 T2 — Brad's Dell R730 field report): the
// direct endpoint `db.<project-ref>.supabase.co` (and the Dedicated Pooler
// on the same host) is IPv6-only; on IPv4-only hosts pg clients hang until
// a pool timeout instead of failing fast. The classifier lets every
// DATABASE_URL ingress warn BEFORE the first hang.
//
// The classify matrix below is ported from engram tests/db-endpoint.test.ts
// so the two implementations cannot drift silently. Pure URL-shape units —
// no live DB, no ambient env, no network.
//
// Invariant under test (the one T4 will attack): warn ≠ reject.
// `looksLikePostgresUrl` stays the blocking validator and ACCEPTS direct
// URLs — IPv6-capable hosts use them legitimately. The warning helper only
// produces lines to print; it never blocks.
//
// Run: node --test packages/server/tests/supabase-url-endpoint.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyDbEndpoint,
  directEndpointWarningLines,
  looksLikePostgresUrl,
} = require('../src/setup/supabase-url');

// All fixtures use placeholder refs only — never a real project ref.
const REF = 'abcdefghijklmnopqrst';
const PW = 'p4ssw0rd';

const DIRECT_5432 = `postgres://postgres:${PW}@db.${REF}.supabase.co:5432/postgres`;
const DEDICATED_6543 = `postgres://postgres:${PW}@db.${REF}.supabase.co:6543/postgres`;
const SHARED_TX_AWS0 = `postgres://postgres.${REF}:${PW}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const SHARED_TX_AWS1 = `postgres://postgres.${REF}:${PW}@aws-1-us-east-2.pooler.supabase.com:6543/postgres`;
const SHARED_SESSION = `postgres://postgres.${REF}:${PW}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`;
const SHARED_BAD_USER = `postgres://postgres:${PW}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

// ── classifyDbEndpoint (matrix ported from engram) ───────────────────────

test('classify: direct endpoint at :5432 → direct', () => {
  const c = classifyDbEndpoint(DIRECT_5432);
  assert.equal(c.kind, 'direct');
  assert.equal(c.host, `db.${REF}.supabase.co`);
  assert.equal(c.port, '5432');
});

test('classify: Dedicated Pooler (:6543 on the db.* host) → direct (same IPv6-only DNS)', () => {
  const c = classifyDbEndpoint(DEDICATED_6543);
  assert.equal(c.kind, 'direct');
  assert.equal(c.port, '6543');
});

test('classify: direct endpoint with no explicit port → direct (libpq defaults 5432)', () => {
  assert.equal(classifyDbEndpoint(`postgresql://postgres:${PW}@db.${REF}.supabase.co/postgres`).kind, 'direct');
});

test('classify: .supabase.in direct host and trailing-dot FQDN → direct', () => {
  assert.equal(classifyDbEndpoint(`postgres://postgres:${PW}@db.${REF}.supabase.in:5432/postgres`).kind, 'direct');
  assert.equal(classifyDbEndpoint(`postgres://postgres:${PW}@db.${REF}.supabase.co.:5432/postgres`).kind, 'direct');
});

test('classify: Shared Pooler transaction mode, aws-0 and aws-1 regional prefixes → shared-pooler', () => {
  for (const url of [SHARED_TX_AWS0, SHARED_TX_AWS1]) {
    const c = classifyDbEndpoint(url);
    assert.equal(c.kind, 'shared-pooler');
    assert.equal(c.poolerUserMismatch, false);
  }
});

test('classify: Shared Pooler session mode (:5432) is still pooler-safe', () => {
  assert.equal(classifyDbEndpoint(SHARED_SESSION).kind, 'shared-pooler');
});

test('classify: pooler host with bare `postgres` user → poolerUserMismatch ("Tenant or user not found")', () => {
  const c = classifyDbEndpoint(SHARED_BAD_USER);
  assert.equal(c.kind, 'shared-pooler');
  assert.equal(c.poolerUserMismatch, true);
});

test('classify: localhost / 127.0.0.1 / [::1] → local', () => {
  assert.equal(classifyDbEndpoint('postgres://postgres:x@localhost:5432/db').kind, 'local');
  assert.equal(classifyDbEndpoint('postgres://postgres:x@127.0.0.1:5432/db').kind, 'local');
  assert.equal(classifyDbEndpoint('postgres://postgres:x@[::1]:5432/db').kind, 'local');
});

test('classify: self-hosted / non-Supabase host → other', () => {
  assert.equal(classifyDbEndpoint('postgres://app:x@pg.internal.example.com:5432/db').kind, 'other');
});

test('classify: absent and whitespace-only → absent', () => {
  assert.equal(classifyDbEndpoint(undefined).kind, 'absent');
  assert.equal(classifyDbEndpoint(null).kind, 'absent');
  assert.equal(classifyDbEndpoint('').kind, 'absent');
  assert.equal(classifyDbEndpoint('   ').kind, 'absent');
});

test('classify: garbage and non-postgres protocols → invalid', () => {
  assert.equal(classifyDbEndpoint('not a url').kind, 'invalid');
  // The HTTPS project URL (SUPABASE_URL) is NOT a connection string.
  assert.equal(classifyDbEndpoint(`https://${REF}.supabase.co`).kind, 'invalid');
});

test('classify: surrounding quotes are stripped before parsing (Brad #2 quoted-env defense)', () => {
  assert.equal(classifyDbEndpoint(`"${DIRECT_5432}"`).kind, 'direct');
  assert.equal(classifyDbEndpoint(`'${SHARED_TX_AWS0}'`).kind, 'shared-pooler');
});

test('classify: non-string input → absent (defensive)', () => {
  assert.equal(classifyDbEndpoint(42).kind, 'absent');
  assert.equal(classifyDbEndpoint({}).kind, 'absent');
});

// ── directEndpointWarningLines ───────────────────────────────────────────

test('warn: direct endpoint → 4 lines naming the IPv6 trap, the toggle, and the pooler shape', () => {
  const lines = directEndpointWarningLines(classifyDbEndpoint(DIRECT_5432));
  assert.equal(lines.length, 4);
  const joined = lines.join('\n');
  assert.match(joined, /IPv6-only endpoint/);
  assert.match(joined, /AAAA-only DNS/);
  assert.match(joined, /hang until a pool\/connect timeout/);
  assert.match(joined, /Use IPv4 connection \(Shared Pooler\)/);
  assert.match(joined, /postgres:\/\/postgres\.<project-ref>:<password>@aws-<n>-<region>\.pooler\.supabase\.com:6543\/postgres/);
});

test('warn: Dedicated Pooler (:6543 on db.* host) gets the same 4 lines (same AAAA-only host)', () => {
  assert.equal(directEndpointWarningLines(classifyDbEndpoint(DEDICATED_6543)).length, 4);
});

test('warn: pooler user mismatch → 1 line naming "Tenant or user not found" and the bad username', () => {
  const lines = directEndpointWarningLines(classifyDbEndpoint(SHARED_BAD_USER));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Tenant or user not found/);
  assert.match(lines[0], /"postgres"/);
  assert.match(lines[0], /postgres\.<project-ref>/);
});

test('warn: correct shared-pooler / local / other / absent / invalid → no lines', () => {
  for (const url of [SHARED_TX_AWS0, SHARED_SESSION, 'postgres://postgres:x@localhost:5432/db',
    'postgres://app:x@pg.internal.example.com:5432/db', undefined, '', 'not a url']) {
    assert.deepEqual(directEndpointWarningLines(classifyDbEndpoint(url)), []);
  }
});

test('warn: warning copy uses placeholders only — never a fixture ref or password', () => {
  for (const url of [DIRECT_5432, DEDICATED_6543, SHARED_BAD_USER]) {
    const joined = directEndpointWarningLines(classifyDbEndpoint(url)).join('\n');
    assert.ok(!joined.includes(REF), 'warning must not echo the project ref');
    assert.ok(!joined.includes(PW), 'warning must not echo the password');
  }
});

test('warn: malformed classification input → [] (defensive, never throws)', () => {
  assert.deepEqual(directEndpointWarningLines(null), []);
  assert.deepEqual(directEndpointWarningLines(undefined), []);
  assert.deepEqual(directEndpointWarningLines('direct'), []);
});

// ── warn ≠ reject invariant ──────────────────────────────────────────────

test('invariant: looksLikePostgresUrl ACCEPTS direct URLs — classification warns, validation passes', () => {
  for (const url of [DIRECT_5432, DEDICATED_6543]) {
    assert.equal(looksLikePostgresUrl(url), null, 'direct URL must remain valid');
    assert.equal(classifyDbEndpoint(url).kind, 'direct');
  }
  // And the pooler-mismatch URL also still validates (warn-only there too).
  assert.equal(looksLikePostgresUrl(SHARED_BAD_USER), null);
});
