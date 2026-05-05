// Sprint 58 T2 — version-gated RPC probe tests for Brad finding #4.
//
// Pre-fix, `termdeck doctor` always probed `search_memories()` regardless of
// the installed Mnestra version. Mnestra 0.4.0 renamed that RPC to
// `memory_hybrid_search()`, so every install at Mnestra ≥ 0.4.0 reported
// false-RED on the schema check. The fix gates the probe name on the
// detected Mnestra version, with a graceful fallback when the version
// cannot be determined.
//
// These tests cover three branches:
//   1. Mnestra ≥ 0.4.0 → probe `memory_hybrid_search()`, GREEN when present
//      and `search_memories()` is absent. Post-fix only.
//   2. Mnestra ≤ 0.3.x → probe `search_memories()`, GREEN when present and
//      `memory_hybrid_search()` is absent. No regression.
//   3. Unknown Mnestra version → probe both names, GREEN if either exists.
//      Graceful — covers offline / non-globally-installed cases.
//
// Plus a couple of pure-function tests on `_selectHybridSearchRpcNames` so
// the version-decision logic is verified independently of pg.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const doctor = require(path.join(__dirname, '..', 'packages', 'cli', 'src', 'doctor.js'));

// Build a fake pg client whose `query(sql)` returns `{ rows: [{ ok }] }`
// based on which schema query is being asked. The test specifies which
// table / column / RPC / extension names exist; everything else returns
// `{ ok: false }`. This sidesteps `pg`, `dotenv`, `pg-runner`, and a real
// Supabase project entirely.
function makeFakeClient(present) {
  const has = {
    tables: new Set(present.tables || []),
    columns: new Set((present.columns || []).map(([t, c]) => `${t}.${c}`)),
    rpcs: new Set(present.rpcs || []),
    extensions: new Set(present.extensions || []),
  };
  return {
    async query(sql) {
      const tableMatch = sql.match(
        /information_schema\.tables [^']*table_name = '([^']+)'/
      );
      if (tableMatch) {
        return { rows: [{ ok: has.tables.has(tableMatch[1]) }] };
      }
      const colMatch = sql.match(
        /information_schema\.columns [^']*table_name = '([^']+)' AND column_name = '([^']+)'/
      );
      if (colMatch) {
        const key = `${colMatch[1]}.${colMatch[2]}`;
        return { rows: [{ ok: has.columns.has(key) }] };
      }
      const rpcMatch = sql.match(/pg_proc WHERE proname = '([^']+)'/);
      if (rpcMatch) {
        return { rows: [{ ok: has.rpcs.has(rpcMatch[1]) }] };
      }
      const extInMatch = sql.match(
        /pg_extension WHERE extname IN \(([^)]+)\)/
      );
      if (extInMatch) {
        const names = extInMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''));
        return { rows: [{ ok: names.some((n) => has.extensions.has(n)) }] };
      }
      const extMatch = sql.match(/pg_extension WHERE extname = '([^']+)'/);
      if (extMatch) {
        return { rows: [{ ok: has.extensions.has(extMatch[1]) }] };
      }
      // Default: not present.
      return { rows: [{ ok: false }] };
    },
    async end() { /* no-op for fake */ },
  };
}

// Write a throwaway `secrets.env` so `_runSchemaCheck`'s `fs.existsSync`
// guard passes. Returns `{ secretsPath, cleanup }`.
function makeFakeSecretsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-doctor-'));
  const secretsPath = path.join(dir, 'secrets.env');
  fs.writeFileSync(
    secretsPath,
    'DATABASE_URL=postgres://fake:fake@localhost:5432/fake\n' +
      'SUPABASE_URL=https://test.supabase.co\n',
    { mode: 0o600 }
  );
  return {
    secretsPath,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
    },
  };
}

function findHybridCheck(result) {
  // Mnestra modern is the first section.
  const modern = result.sections.find((s) => s.name === 'Mnestra modern schema');
  assert.ok(modern, 'expected "Mnestra modern schema" section');
  const hybrid = modern.checks.find((c) => /search_memories|memory_hybrid_search/.test(c.label));
  assert.ok(hybrid, 'expected one hybrid-search check in modern section');
  return hybrid;
}

// ── Pure-function tests for `_selectHybridSearchRpcNames` ─────────────────

test('rpc-name selector: Mnestra >= 0.4.0 picks memory_hybrid_search only', () => {
  assert.deepEqual(doctor._selectHybridSearchRpcNames('0.4.0'), ['memory_hybrid_search']);
  assert.deepEqual(doctor._selectHybridSearchRpcNames('0.4.3'), ['memory_hybrid_search']);
  assert.deepEqual(doctor._selectHybridSearchRpcNames('1.0.0'), ['memory_hybrid_search']);
});

test('rpc-name selector: Mnestra <= 0.3.x picks search_memories only', () => {
  assert.deepEqual(doctor._selectHybridSearchRpcNames('0.3.5'), ['search_memories']);
  assert.deepEqual(doctor._selectHybridSearchRpcNames('0.3.0'), ['search_memories']);
  assert.deepEqual(doctor._selectHybridSearchRpcNames('0.2.1'), ['search_memories']);
  assert.deepEqual(doctor._selectHybridSearchRpcNames('0.1.0'), ['search_memories']);
});

test('rpc-name selector: null/undefined falls back to probing both names', () => {
  assert.deepEqual(
    doctor._selectHybridSearchRpcNames(null),
    ['memory_hybrid_search', 'search_memories']
  );
  assert.deepEqual(
    doctor._selectHybridSearchRpcNames(undefined),
    ['memory_hybrid_search', 'search_memories']
  );
});

// ── Integration tests through `_runSchemaCheck` ────────────────────────────

test('doctor schema: Mnestra 0.4.3 + memory_hybrid_search exists, search_memories absent → GREEN (post-fix)', async () => {
  const fake = makeFakeSecretsFile();
  try {
    const client = makeFakeClient({
      rpcs: ['memory_hybrid_search', 'match_memories', 'memory_status_aggregation'],
      // search_memories deliberately ABSENT — this is the canonical 0.4.0+
      // shape that pre-fix doctor reported as false-RED.
    });
    const result = await doctor._runSchemaCheck({
      mnestraVersion: '0.4.3',
      _pgClient: client,
      secretsPath: fake.secretsPath,
    });
    assert.equal(result.skipped, false);
    const hybrid = findHybridCheck(result);
    assert.equal(hybrid.label, 'memory_hybrid_search() RPC');
    assert.equal(hybrid.status, 'pass');
    assert.match(hybrid.hint, /Mnestra 0\.4\.3 expects memory_hybrid_search/);
  } finally {
    fake.cleanup();
  }
});

test('doctor schema: Mnestra 0.3.5 + search_memories exists, memory_hybrid_search absent → GREEN (no regression)', async () => {
  const fake = makeFakeSecretsFile();
  try {
    const client = makeFakeClient({
      rpcs: ['search_memories', 'match_memories', 'memory_status_aggregation'],
      // memory_hybrid_search ABSENT — legacy Mnestra ≤ 0.3.x shape.
    });
    const result = await doctor._runSchemaCheck({
      mnestraVersion: '0.3.5',
      _pgClient: client,
      secretsPath: fake.secretsPath,
    });
    assert.equal(result.skipped, false);
    const hybrid = findHybridCheck(result);
    assert.equal(hybrid.label, 'search_memories() RPC');
    assert.equal(hybrid.status, 'pass');
    assert.match(hybrid.hint, /Mnestra 0\.3\.5 expects search_memories/);
  } finally {
    fake.cleanup();
  }
});

test('doctor schema: version unknown + only memory_hybrid_search exists → GREEN (graceful)', async () => {
  const fake = makeFakeSecretsFile();
  try {
    const client = makeFakeClient({
      rpcs: ['memory_hybrid_search', 'match_memories', 'memory_status_aggregation'],
    });
    const result = await doctor._runSchemaCheck({
      mnestraVersion: null,
      _pgClient: client,
      secretsPath: fake.secretsPath,
    });
    assert.equal(result.skipped, false);
    const hybrid = findHybridCheck(result);
    assert.equal(hybrid.label, 'memory_hybrid_search or search_memories() RPC');
    assert.equal(hybrid.status, 'pass');
  } finally {
    fake.cleanup();
  }
});

test('doctor schema: version unknown + only search_memories exists → GREEN (graceful)', async () => {
  const fake = makeFakeSecretsFile();
  try {
    const client = makeFakeClient({
      rpcs: ['search_memories', 'match_memories', 'memory_status_aggregation'],
    });
    const result = await doctor._runSchemaCheck({
      mnestraVersion: null,
      _pgClient: client,
      secretsPath: fake.secretsPath,
    });
    assert.equal(result.skipped, false);
    const hybrid = findHybridCheck(result);
    assert.equal(hybrid.label, 'memory_hybrid_search or search_memories() RPC');
    assert.equal(hybrid.status, 'pass');
  } finally {
    fake.cleanup();
  }
});

test('doctor schema: Mnestra 0.4.3 with neither RPC present → RED (catches Brad-class drift)', async () => {
  const fake = makeFakeSecretsFile();
  try {
    const client = makeFakeClient({
      rpcs: ['match_memories', 'memory_status_aggregation'],
      // BOTH hybrid names absent — this is the pre-Sprint-51.6 Brad-bug
      // shape on a fresh 0.4.0+ install where the function never landed.
    });
    const result = await doctor._runSchemaCheck({
      mnestraVersion: '0.4.3',
      _pgClient: client,
      secretsPath: fake.secretsPath,
    });
    assert.equal(result.skipped, false);
    const hybrid = findHybridCheck(result);
    assert.equal(hybrid.label, 'memory_hybrid_search() RPC');
    assert.equal(hybrid.status, 'fail');
    assert.equal(result.hasGaps, true);
  } finally {
    fake.cleanup();
  }
});

test('doctor schema: when mnestraVersion not passed, falls back to _detectMnestraVersion', async () => {
  const fake = makeFakeSecretsFile();
  const origDetect = doctor._detectMnestraVersion;
  try {
    let calls = 0;
    doctor._detectMnestraVersion = async () => { calls += 1; return '0.4.3'; };
    const client = makeFakeClient({
      rpcs: ['memory_hybrid_search', 'match_memories', 'memory_status_aggregation'],
    });
    const result = await doctor._runSchemaCheck({
      // mnestraVersion deliberately omitted — should trigger fallback.
      _pgClient: client,
      secretsPath: fake.secretsPath,
    });
    assert.equal(calls, 1, 'fallback _detectMnestraVersion must be called exactly once');
    const hybrid = findHybridCheck(result);
    assert.equal(hybrid.label, 'memory_hybrid_search() RPC');
    assert.equal(hybrid.status, 'pass');
  } finally {
    doctor._detectMnestraVersion = origDetect;
    fake.cleanup();
  }
});
