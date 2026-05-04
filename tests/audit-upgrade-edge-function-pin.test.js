// Sprint 52 — Class O: Edge Function pin-drift probe tests.
//
// Coverage:
//   - In-sync (npmRegistry resolver): deployed=current → present/green.
//   - In-sync (bundledSource resolver): deployed=bundled → present/green.
//   - Drift (npmRegistry): deployed=0.4.0, expected=0.4.5 → skipped[] with
//     recommendation containing BOTH versions + "init --rumen --yes".
//   - Drift (bundledSource): deployed=3.4.0, bundled=3.4.4 → skipped[].
//   - Deployed body missing the npm: import line → skipped[] with
//     "does not match" reason.
//   - Management API HTTP error (404 / 401) → skipped[] fail-soft.
//   - Network error → skipped[] fail-soft.
//   - Missing SUPABASE_ACCESS_TOKEN → skipped[] fail-soft.
//   - npm view failure → skipped[] fail-soft, no Management API call made.
//   - bundled source unreadable → skipped[] fail-soft.
//   - Integration via auditUpgrade(): two pin probes route to skipped[],
//     not missing[].

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const SETUP_DIR = path.join(repoRoot, 'packages', 'server', 'src', 'setup');

const auditMod = require(path.join(SETUP_DIR, 'audit-upgrade.js'));
const { auditUpgrade, PROBES, _probeEdgeFunctionPin } = auditMod;

// Pull the two new pin probes by name so the tests can target them
// individually without re-defining the probe shape.
const RUMEN_PIN_PROBE = PROBES.find((p) =>
  p.probeKind === 'edgeFunctionPin' && p.functionSlug === 'rumen-tick');
const GRAPH_PIN_PROBE = PROBES.find((p) =>
  p.probeKind === 'edgeFunctionPin' && p.functionSlug === 'graph-inference');

function makeFetchOk(body) {
  return async (_url, _opts) => ({
    ok: true,
    status: 200,
    text: async () => body
  });
}
function makeFetchStatus(status) {
  return async (_url, _opts) => ({
    ok: false,
    status,
    text: async () => `HTTP ${status}`
  });
}
function makeFetchThrow(message) {
  return async (_url, _opts) => { throw new Error(message); };
}

function makeNpmView({ ok, version, error }) {
  return async (_pkg) => ({ ok, version, error });
}

// Default body shape used in the in-sync / drift tests. The probe matches
// the `npm:@jhizzard/rumen@<version>` line; surrounding source is a
// minimal Edge Function template that doesn't materially affect the probe.
const RUMEN_BODY = (v) => `
import { runRumenJob } from 'npm:@jhizzard/rumen@${v}';
Deno.serve(async () => new Response('ok'));
`;

const GRAPH_BODY = (v) => `
import postgres from 'npm:postgres@${v}';
Deno.serve(async () => new Response('ok'));
`;

// Helper: scope SUPABASE_ACCESS_TOKEN env var for the duration of a test.
function withAccessToken(value, fn) {
  return async () => {
    const orig = process.env.SUPABASE_ACCESS_TOKEN;
    if (value === null) delete process.env.SUPABASE_ACCESS_TOKEN;
    else process.env.SUPABASE_ACCESS_TOKEN = value;
    try { await fn(); }
    finally {
      if (orig === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
      else process.env.SUPABASE_ACCESS_TOKEN = orig;
    }
  };
}

// ── Probe-set sanity (Class O) ─────────────────────────────────────────────

test('PROBES contains rumen-tick-pin (npmRegistry) + graph-inference-pin (bundledSource)', () => {
  assert.ok(RUMEN_PIN_PROBE, 'rumen-tick edgeFunctionPin probe must exist');
  assert.equal(RUMEN_PIN_PROBE.expectedFrom, 'npmRegistry');
  assert.equal(RUMEN_PIN_PROBE.npmRegistryPkg, '@jhizzard/rumen');
  assert.ok(RUMEN_PIN_PROBE.importPattern instanceof RegExp);

  assert.ok(GRAPH_PIN_PROBE, 'graph-inference edgeFunctionPin probe must exist');
  assert.equal(GRAPH_PIN_PROBE.expectedFrom, 'bundledSource');
  assert.equal(GRAPH_PIN_PROBE.bundledPath,
    'packages/server/src/setup/rumen/functions/graph-inference/index.ts');
  assert.ok(GRAPH_PIN_PROBE.importPattern instanceof RegExp);
});

// ── In-sync: green path (npmRegistry resolver) ──────────────────────────────

test('rumen-tick pin: deployed=expected → present (no drift)', withAccessToken('sbp_test', async () => {
  const result = await _probeEdgeFunctionPin(RUMEN_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: makeFetchOk(RUMEN_BODY('0.4.5')),
    npmViewImpl: makeNpmView({ ok: true, version: '0.4.5' }),
  });
  assert.equal(result.present, true);
  assert.equal(result.probeError, undefined);
}));

// ── Drift: petvetbid's actual case (deployed 0.4.0 vs current 0.4.5) ────────

test('rumen-tick pin: deployed=0.4.0, expected=0.4.5 → drift, recommendation includes both versions + init --rumen', withAccessToken('sbp_test', async () => {
  const result = await _probeEdgeFunctionPin(RUMEN_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: makeFetchOk(RUMEN_BODY('0.4.0')),
    npmViewImpl: makeNpmView({ ok: true, version: '0.4.5' }),
  });
  assert.equal(result.present, false);
  assert.match(result.probeError, /pin drift/i);
  assert.match(result.probeError, /0\.4\.0/, 'recommendation must include deployed version');
  assert.match(result.probeError, /0\.4\.5/, 'recommendation must include expected version');
  assert.match(result.probeError, /init --rumen/, 'recommendation must point at init --rumen');
}));

// ── In-sync: bundledSource resolver ─────────────────────────────────────────

test('graph-inference pin: deployed=bundled (bundled-source resolver) → present', withAccessToken('sbp_test', async () => {
  const result = await _probeEdgeFunctionPin(GRAPH_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: makeFetchOk(GRAPH_BODY('3.4.4')),
    readFileImpl: () => `import postgres from 'npm:postgres@3.4.4';`,
  });
  assert.equal(result.present, true);
  assert.equal(result.probeError, undefined);
}));

// ── Drift: bundledSource resolver ───────────────────────────────────────────

test('graph-inference pin: deployed=3.4.0, bundled=3.4.4 → drift', withAccessToken('sbp_test', async () => {
  const result = await _probeEdgeFunctionPin(GRAPH_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: makeFetchOk(GRAPH_BODY('3.4.0')),
    readFileImpl: () => `import postgres from 'npm:postgres@3.4.4';`,
  });
  assert.equal(result.present, false);
  assert.match(result.probeError, /pin drift/i);
  assert.match(result.probeError, /3\.4\.0/);
  assert.match(result.probeError, /3\.4\.4/);
  assert.match(result.probeError, /init --rumen/);
}));

// ── Probe-error degradation paths ───────────────────────────────────────────

test('rumen-tick pin: deployed body missing npm:@jhizzard/rumen import → unknown band', withAccessToken('sbp_test', async () => {
  const result = await _probeEdgeFunctionPin(RUMEN_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: makeFetchOk(`Deno.serve(() => new Response('hi'));`),
    npmViewImpl: makeNpmView({ ok: true, version: '0.4.5' }),
  });
  assert.equal(result.present, false);
  assert.match(result.probeError, /does not match/);
}));

test('rumen-tick pin: Management API 404 → fail-soft skipped', withAccessToken('sbp_test', async () => {
  const result = await _probeEdgeFunctionPin(RUMEN_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: makeFetchStatus(404),
    npmViewImpl: makeNpmView({ ok: true, version: '0.4.5' }),
  });
  assert.equal(result.present, false);
  assert.match(result.probeError, /HTTP 404/);
}));

test('rumen-tick pin: Management API network throw → fail-soft skipped', withAccessToken('sbp_test', async () => {
  const result = await _probeEdgeFunctionPin(RUMEN_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: makeFetchThrow('ENOTFOUND api.supabase.com'),
    npmViewImpl: makeNpmView({ ok: true, version: '0.4.5' }),
  });
  assert.equal(result.present, false);
  assert.match(result.probeError, /Management API fetch failed/);
  assert.match(result.probeError, /ENOTFOUND/);
}));

test('rumen-tick pin: missing SUPABASE_ACCESS_TOKEN → fail-soft skipped (no fetch made)', withAccessToken(null, async () => {
  let fetchCalled = false;
  const result = await _probeEdgeFunctionPin(RUMEN_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: async () => { fetchCalled = true; return { ok: true, status: 200, text: async () => '' }; },
    npmViewImpl: makeNpmView({ ok: true, version: '0.4.5' }),
  });
  assert.equal(result.present, false);
  assert.match(result.probeError, /SUPABASE_ACCESS_TOKEN not set/);
  assert.equal(fetchCalled, false, 'must not hit Management API without an access token');
}));

test('rumen-tick pin: npm view failure → fail-soft skipped (Management API not called)', withAccessToken('sbp_test', async () => {
  let fetchCalled = false;
  const result = await _probeEdgeFunctionPin(RUMEN_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: async () => { fetchCalled = true; return { ok: true, status: 200, text: async () => '' }; },
    npmViewImpl: makeNpmView({ ok: false, error: 'offline' }),
  });
  assert.equal(result.present, false);
  assert.match(result.probeError, /npm view @jhizzard\/rumen version failed/);
  assert.match(result.probeError, /offline/);
  assert.equal(fetchCalled, false, 'must short-circuit before Management API on npm view failure');
}));

test('graph-inference pin: bundled file unreadable → fail-soft skipped', withAccessToken('sbp_test', async () => {
  const result = await _probeEdgeFunctionPin(GRAPH_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: makeFetchOk(GRAPH_BODY('3.4.4')),
    readFileImpl: () => { throw new Error('ENOENT: no such file'); },
  });
  assert.equal(result.present, false);
  assert.match(result.probeError, /bundled source read failed/);
  assert.match(result.probeError, /ENOENT/);
}));

test('graph-inference pin: bundled source missing the npm:postgres import → fail-soft skipped', withAccessToken('sbp_test', async () => {
  const result = await _probeEdgeFunctionPin(GRAPH_PIN_PROBE, {
    projectRef: 'abc123',
    fetchImpl: makeFetchOk(GRAPH_BODY('3.4.4')),
    readFileImpl: () => `// no postgres import here at all`,
  });
  assert.equal(result.present, false);
  assert.match(result.probeError, /bundled source.*does not contain/);
}));

// ── Integration via auditUpgrade(): both pin probes route to skipped[] ──────

test('auditUpgrade integration: in-sync rumen-tick + drifted graph-inference → 1 present, 1 skipped', withAccessToken('sbp_test', async () => {
  const fetchImpl = async (url, _opts) => {
    if (url.includes('rumen-tick')) {
      return { ok: true, status: 200, text: async () => RUMEN_BODY('0.4.5') };
    }
    if (url.includes('graph-inference')) {
      // Drifted: deployed 3.4.0 vs bundled 3.4.4
      return { ok: true, status: 200, text: async () => GRAPH_BODY('3.4.0') };
    }
    return { ok: false, status: 404, text: async () => 'unknown' };
  };
  const npmViewImpl = makeNpmView({ ok: true, version: '0.4.5' });
  const readFileImpl = (p) => {
    if (p.includes('graph-inference')) return `import postgres from 'npm:postgres@3.4.4';`;
    throw new Error(`unexpected read: ${p}`);
  };
  const pinProbes = [RUMEN_PIN_PROBE, GRAPH_PIN_PROBE];
  const result = await auditUpgrade({
    pgClient: { async query() { return { rows: [] }; } },
    projectRef: 'abc123',
    probes: pinProbes,
    _fetch: fetchImpl,
    _npmView: npmViewImpl,
    _readFile: readFileImpl,
    _migrations: {
      listMnestraMigrations: () => [],
      listRumenMigrations: () => [],
      readFile: () => ''
    },
  });
  assert.equal(result.probed.length, 2);
  assert.deepEqual(result.present, [RUMEN_PIN_PROBE.name]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].name, GRAPH_PIN_PROBE.name);
  assert.match(result.skipped[0].reason, /pin drift/i);
  assert.equal(result.missing.length, 0,
    'edgeFunctionPin probes route absent → skipped[], NEVER missing[]');
  assert.equal(result.applied.length, 0,
    'edgeFunctionPin probes never auto-apply (redeploy is via init --rumen)');
}));

test('auditUpgrade integration: both probes drift → both skipped, never missing', withAccessToken('sbp_test', async () => {
  const fetchImpl = async (url, _opts) => {
    if (url.includes('rumen-tick')) {
      return { ok: true, status: 200, text: async () => RUMEN_BODY('0.4.0') }; // drift
    }
    if (url.includes('graph-inference')) {
      return { ok: true, status: 200, text: async () => GRAPH_BODY('3.4.0') }; // drift
    }
    return { ok: false, status: 404, text: async () => 'unknown' };
  };
  const result = await auditUpgrade({
    pgClient: { async query() { return { rows: [] }; } },
    projectRef: 'abc123',
    probes: [RUMEN_PIN_PROBE, GRAPH_PIN_PROBE],
    _fetch: fetchImpl,
    _npmView: makeNpmView({ ok: true, version: '0.4.5' }),
    _readFile: () => `import postgres from 'npm:postgres@3.4.4';`,
    _migrations: {
      listMnestraMigrations: () => [],
      listRumenMigrations: () => [],
      readFile: () => ''
    },
  });
  assert.equal(result.skipped.length, 2);
  assert.equal(result.missing.length, 0);
  assert.equal(result.present.length, 0);
  assert.equal(result.applied.length, 0);
  for (const s of result.skipped) {
    assert.match(s.reason, /pin drift/i);
    assert.match(s.reason, /init --rumen/);
  }
}));
