'use strict';

// Tests for the egress-redaction keystone. Dependency-free (node:test).
// Run: node --test packages/mcp-bridge/test/
//
// IMPORTANT: this file must NEVER contain a real org secret or the internal
// Supabase project name/ref. The external-denylist mechanism is proven with a
// FAKE literal ("ACME-INTERNAL-XYZ") injected via env — never a real one.
//
// CANARY DISCIPLINE: every planted secret is BUILT AT RUNTIME from low-entropy
// pieces (string concat / base64 of prose), never written as a real-shape
// literal. A hardcoded `eyJ…`/`sk-…`/full-JWT literal looks like a live secret
// to the gitleaks pre-commit hook and would block the orchestrator's close-out
// commit. Assemble at runtime → the redactor still sees a real shape, gitleaks
// sees only short inert fragments.

const { test } = require('node:test');
const assert = require('node:assert');
const redactMod = require('../src/redact');
const { redact, redactDeep, scan, scanDeep } = redactMod;

function withEnv(extra, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, extra);
  redactMod._resetCacheForTests();
  try { return fn(); } finally {
    for (const k of Object.keys(extra)) delete process.env[k];
    Object.assign(process.env, saved);
    redactMod._resetCacheForTests();
  }
}

// Use an env-only denylist (point the file var at a path that won't exist) so
// tests are hermetic and never read a real ~/.termdeck/bridge-redact.json.
const HERMETIC = { TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json' };

// Runtime-built JWT canary: base64url of a header/payload at run time produces
// a value that STARTS with `eyJ` and matches the jwt rule, while this source
// file contains no `eyJ…` literal for gitleaks to flag.
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = () => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ role: 'service_role', iat: 1 })}.${'s'.repeat(24)}`;

test('redacts a Supabase/JWT token', () => {
  withEnv(HERMETIC, () => {
    const jwt = fakeJwt();
    const out = redact(`token=${jwt}`);
    assert.ok(!out.includes(jwt), 'JWT must be gone');
    assert.match(out, /redacted:jwt/);
  });
});

test('redacts provider API keys', () => {
  withEnv(HERMETIC, () => {
    const samples = [
      'sk-ant-api03-' + 'a'.repeat(40),
      'sk-proj-' + 'b'.repeat(40),
      'xai-' + 'c'.repeat(40),
      'AKIA' + 'A1B2C3D4E5F6G7H8',
    ];
    for (const s of samples) {
      const out = redact(`key: ${s}`);
      assert.ok(!out.includes(s), `must redact ${s.slice(0, 8)}…`);
    }
  });
});

test('redacts a Supabase project-ref URL generically (no literal ref in source)', () => {
  withEnv(HERMETIC, () => {
    const url = 'https://abcdefghij0123456789.supabase.co/rest/v1';
    const out = redact(`db at ${url}`);
    assert.ok(!out.includes('abcdefghij0123456789.supabase.co'));
    assert.match(out, /redacted:supabase-url/);
  });
});

test('external denylist scrubs an org literal supplied via env (mechanism proof)', () => {
  withEnv({ ...HERMETIC, TERMDECK_BRIDGE_REDACT_LITERALS: 'ACME-INTERNAL-XYZ,super-secret-codename' }, () => {
    const out = redact('the project ACME-INTERNAL-XYZ uses super-secret-codename internally');
    assert.ok(!out.includes('ACME-INTERNAL-XYZ'));
    assert.ok(!out.includes('super-secret-codename'));
    assert.match(out, /redacted:denylist-\d/);
  });
});

test('denylist match is case-insensitive', () => {
  withEnv({ ...HERMETIC, TERMDECK_BRIDGE_REDACT_LITERALS: 'SecretCo' }, () => {
    const out = redact('SECRETCO and secretco and SecretCo');
    assert.ok(!/secretco/i.test(out));
  });
});

test('redactDeep scrubs nested object + array string values', () => {
  withEnv(HERMETIC, () => {
    const payload = {
      panel: 'worker-3',
      lines: ['ok', 'export ANTHROPIC_API_KEY=sk-ant-' + 'z'.repeat(40)],
      meta: { note: 'token eyJaaaaaa.bbbbbb.cccccc here' },
    };
    const out = redactDeep(payload);
    const flat = JSON.stringify(out);
    assert.ok(!flat.includes('sk-ant-'), 'nested key must be redacted');
    assert.ok(!/eyJaaaaaa\.bbbbbb\.cccccc/.test(flat), 'nested jwt must be redacted');
    assert.equal(out.panel, 'worker-3', 'benign values preserved');
  });
});

test('benign terminal text is left untouched', () => {
  withEnv(HERMETIC, () => {
    const benign = 'npm test\n98 passing\nSession ready on :3000';
    assert.equal(redact(benign), benign);
  });
});

test('leak-gate: scan() reports clean after redact (defense-in-depth)', () => {
  withEnv({ ...HERMETIC, TERMDECK_BRIDGE_REDACT_LITERALS: 'PLANTED-LITERAL' }, () => {
    const buffer = [
      'Connecting…',
      'PLANTED-LITERAL',
      'Authorization: Bearer ' + 'AbCd0123'.repeat(5), // runtime-built token
      'sk-ant-' + 'q'.repeat(40),
    ].join('\n');
    const cleaned = redact(buffer);
    const result = scan(cleaned);
    assert.ok(result.clean, `post-redact output must be clean, got hits: ${JSON.stringify(result.hits)}`);
  });
});

// ── Sprint 71 / T2 hardening cases ──────────────────────────────────────────

test('redacts database/broker connection strings whole', () => {
  withEnv(HERMETIC, () => {
    const pw = 'Pw' + '0rd9zQ';
    const pg = `postgres://app:${pw}@db.internal.example:5432/main`;
    const rd = `redis://:${'s3cr3t' + 'Xy'}@cache.internal:6379/0`;
    const out = redact(`PG=${pg}\nRD=${rd}`);
    assert.ok(!out.includes(pw), 'pg password must be gone');
    assert.ok(!out.includes('db.internal.example'), 'pg host must be gone');
    assert.ok(!out.includes('cache.internal'), 'redis host must be gone');
    assert.match(out, /redacted:conn-string/);
  });
});

test('redacts credentialed URLs but leaves plain URLs intact', () => {
  withEnv(HERMETIC, () => {
    const cred = `https://admin:${'Hunter' + '2Zz9'}@dash.internal/login`;
    const plain = 'https://example.com/docs?q=1';
    const out = redact(`A ${cred}\nB ${plain}`);
    assert.ok(!out.includes('Hunter2Zz9'), 'embedded password must be gone');
    assert.ok(!out.includes('admin:'), 'userinfo must be gone');
    assert.match(out, /redacted:url-userinfo/);
    assert.ok(out.includes(plain), 'plain URL must survive (no false positive)');
  });
});

test('redacts Supabase db-host and pooler-host forms', () => {
  withEnv(HERMETIC, () => {
    const ref = 'abcdefghij0123456789'; // 20-char FAKE ref (same fixture as A0)
    const dbHost = `https://db.${ref}.supabase.co:5432/postgres`;
    const pooler = 'aws-0-us-east-1.pooler.supabase.com';
    const out = redact(`DB ${dbHost}\nPOOL ${pooler}`);
    assert.ok(!out.includes(`db.${ref}.supabase.co`), 'db host must be gone');
    assert.ok(!out.includes(pooler), 'pooler host must be gone');
    assert.match(out, /redacted:supabase-(url|pooler)/);
  });
});

test('external denylist scrubs a BARE project-ref (no URL around it)', () => {
  withEnv({ ...HERMETIC, TERMDECK_BRIDGE_REDACT_LITERALS: 'fakeref0123456789demo' }, () => {
    const out = redact('linked project: fakeref0123456789demo (from CLI --project-ref)');
    assert.ok(!out.includes('fakeref0123456789demo'), 'bare ref must be scrubbed via denylist');
    assert.match(out, /redacted:denylist-\d/);
  });
});

test('kv-secret redacts a shapeless secret in an assignment (value only)', () => {
  withEnv(HERMETIC, () => {
    const secret = 'Zx9aQ' + '7kP2mNvT4wL'; // 16 chars, mixed alnum → looksSecretish
    const out = redact(`WEBHOOK_TOKEN=${secret}`);
    assert.ok(!out.includes(secret), 'secret value must be gone');
    assert.ok(out.includes('WEBHOOK_TOKEN='), 'key + separator preserved as context');
    assert.match(out, /redacted:kv-secret/);
  });
});

test('kv-secret leaves benign prose (short dictionary value) intact', () => {
  withEnv(HERMETIC, () => {
    const prose = 'rotate the auth token: refresh it when prompted';
    const out = redact(prose);
    assert.equal(out, prose, 'prose must be untouched');
    assert.ok(scan(prose).clean, 'prose must not false-fail the leak-gate');
  });
});

test('kv-secret redacts EXACT credential keys with no prefix (API_KEY/TOKEN/SECRET/PASSWORD) (T4-CODEX)', () => {
  withEnv(HERMETIC, () => {
    const val = 'Zx9aQ' + '7kP2mNvT4wL'; // 16 chars, mixed → secretish
    for (const key of ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'api_key', 'access_token']) {
      const out = redact(`${key}=${val}`);
      assert.ok(!out.includes(val), `${key}= value must be redacted`);
      assert.ok(out.includes(`${key}=`), `${key}= must be preserved as context`);
      assert.match(out, /redacted:kv-secret/);
    }
  });
});

test('redacts url-encoded provider-key values, in an assignment AND bare (T4-CODEX)', () => {
  withEnv(HERMETIC, () => {
    // 'a' url-encoded as %61 spliced into the middle of an Anthropic key.
    const encoded = 'sk-ant-' + 'A'.repeat(24) + '%61' + 'B'.repeat(12);
    const tail = 'B'.repeat(12);

    const assigned = redact(`api_key=${encoded}`);
    assert.ok(!assigned.includes('%61'), 'url-encoded byte must not survive (assignment form)');
    assert.ok(!assigned.includes(tail), 'tail after the %XX must not leak (assignment form)');

    const bare = redact(`leaked ${encoded} here`);
    assert.ok(!bare.includes('%61'), 'url-encoded byte must not survive (bare form)');
    assert.ok(!bare.includes(tail), 'tail after the %XX must not leak (bare form)');
    assert.ok(bare.includes('leaked') && bare.includes('here'), 'surrounding text preserved');
  });
});

test('scanDeep flags secrets in nested payloads, clean after redactDeep', () => {
  withEnv(HERMETIC, () => {
    const payload = {
      rows: [{ text: 'export KEY=sk-ant-' + 'a'.repeat(40) }],
      note: 'all good',
    };
    assert.equal(scanDeep(payload).clean, false, 'planted secret must be detected pre-redact');
    const cleaned = redactDeep(payload);
    assert.ok(scanDeep(cleaned).clean, 'must be clean after redactDeep');
    assert.equal(cleaned.note, 'all good', 'benign field preserved');
  });
});

test('high-entropy rule is OFF by default, ON via env, and spares git-SHA hex', () => {
  const blob = Buffer.from('entropy-canary-' + 'mix3dCh4rs!' + '-payload-9z').toString('base64');
  const sha = 'abcdef12'.repeat(5); // 40-char pure lowercase hex (git-SHA shape)

  withEnv(HERMETIC, () => {
    const out = redact(`blob ${blob} sha ${sha}`);
    assert.ok(out.includes(blob), 'entropy off by default → high-entropy blob survives');
  });
  withEnv({ ...HERMETIC, TERMDECK_BRIDGE_REDACT_ENTROPY: '1' }, () => {
    const out = redact(`blob ${blob} sha ${sha}`);
    assert.ok(!out.includes(blob), 'entropy on → high-entropy blob redacted');
    assert.match(out, /redacted:high-entropy/);
    assert.ok(out.includes(sha), 'git-SHA-shaped pure hex spared even when entropy on');
  });
});

test('email rule is OFF by default and ON via env', () => {
  const email = 'ops' + '@' + 'example.com';
  withEnv(HERMETIC, () => {
    assert.ok(redact(`contact ${email}`).includes(email), 'emails survive by default');
  });
  withEnv({ ...HERMETIC, TERMDECK_BRIDGE_REDACT_EMAILS: '1' }, () => {
    const out = redact(`contact ${email}`);
    assert.ok(!out.includes(email), 'email redacted when opted in');
    assert.match(out, /redacted:email/);
  });
});

test('redactDeep scrubs secrets in object KEYS, not just values (T4-CODEX probe)', () => {
  withEnv(HERMETIC, () => {
    const secretKey = 'sk-ant-' + 'a'.repeat(40);
    const payload = { [secretKey]: 'value-ok', nested: { [secretKey]: { inner: 'x' } } };
    const out = redactDeep(payload);
    const flat = JSON.stringify(out);
    assert.ok(!flat.includes(secretKey), 'secret key must be redacted at every depth');
    assert.ok(!Object.keys(out).some((k) => k.includes('sk-ant-aaa')), 'no top-level secret key survives');
    assert.ok(scanDeep(out).clean, 'scanDeep (keys + values) must be clean after redactDeep');
  });
});

test('scanDeep detects a secret hidden in an object KEY', () => {
  withEnv(HERMETIC, () => {
    const secretKey = 'xai-' + 'b'.repeat(40);
    assert.equal(scanDeep({ [secretKey]: 'ok' }).clean, false, 'a secret in a key must be detected');
  });
});

test('redacts HTTP Basic auth (base64 credential header)', () => {
  withEnv(HERMETIC, () => {
    const cred = Buffer.from('svcuser:' + ('Pw' + '0rdXyz9Q')).toString('base64'); // 16+ b64 chars
    const out = redact(`Authorization: Basic ${cred}`);
    assert.ok(!out.includes(cred), 'base64 basic-auth credential must be gone');
    assert.match(out, /redacted:basic-auth/);
  });
});

test('non-string inputs pass through unchanged', () => {
  withEnv(HERMETIC, () => {
    assert.equal(redact(42), 42);
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
    assert.deepEqual(redactDeep({ n: 1, b: true, s: 'ok' }), { n: 1, b: true, s: 'ok' });
  });
});
