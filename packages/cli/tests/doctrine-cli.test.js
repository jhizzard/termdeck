// Sprint 79 T3 — termdeck doctrine list|ratify|reject|promote behavior
// tests. T4-CODEX flagged (STATUS.md ~12:53/12:55/13:06 ET) that no test
// file exercised `cmdRatify()` directly — these close that gap.
//
// No real Postgres, no real gh, no real OpenAI: a fake pg client (SQL-text
// pattern matching, mirrors tests/audit-upgrade.test.js's makePgClient
// convention), `ghBin` pointed at a tiny stub script (canned `gh pr
// list|create|close` JSON), and `docSync.generateEmbedding` monkey-patched
// (CommonJS module objects are mutable — a common DI technique when a
// function has no injectable seam) so no network call happens and both the
// success AND failure embedding paths are exercised deterministically.
// `doctrine/registry.jsonl` operations run against a real plain temp
// directory (no git needed — updateRegistryEntry is a pure fs read/write).
//
// Run: node --test packages/cli/tests/doctrine-cli.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const doctrineCli = require(path.join(repoRoot, 'packages', 'cli', 'src', 'doctrine-cli.js'));
const docSync = require(path.join(repoRoot, 'packages', 'server', 'src', 'doctrine-sync.js'));
const doctrine = require(path.join(repoRoot, 'doctrine', 'index.js'));

const STUB_GH = path.join(__dirname, 'fixtures', 'stub-gh.sh');

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctrine-cli-test-'));
  fs.mkdirSync(path.join(dir, 'doctrine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doctrine', 'registry.jsonl'), '', 'utf8');
  return dir;
}

function sampleRow(overrides = {}) {
  return Object.assign({
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    status: 'proposed',
    title: 'Test doctrine row',
    doctrine_text: 'A principle worth ratifying.',
    cluster_member_ids: ['bbbbbbbb-2222-4222-8222-222222222222', 'cccccccc-3333-4333-8333-333333333333'],
    occurrence_count: 5,
    projects: ['termdeck'],
    evidence: [{ date: '2026-06-01', gist: 'seen twice' }],
    trigger_hints: [],
    origin: 'doctrine-scan',
  }, overrides);
}

// Seeds the repo's registry.jsonl with a 'proposed' entry for the given row,
// exactly as doctrine-sync.js's materialize step would have written it.
function seedRegistryEntry(repoPath, row) {
  const entry = docSync.buildRegistryEntry(row, docSync.docRelPathFor(row));
  fs.appendFileSync(path.join(repoPath, 'doctrine', 'registry.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

function readRegistry(repoPath) {
  const raw = fs.readFileSync(path.join(repoPath, 'doctrine', 'registry.jsonl'), 'utf8');
  return raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Fake pg client — SQL-text pattern matching, tracks every call + a
// `committed`/`rolledBack` flag so tests can assert transaction discipline.
function makeFakeClient(behavior = {}) {
  const calls = [];
  let committed = false;
  let rolledBack = false;
  return {
    calls,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.trim();
      if (/^begin$/i.test(s)) return {};
      if (/^commit$/i.test(s)) { committed = true; return {}; }
      if (/^rollback$/i.test(s)) { rolledBack = true; return {}; }
      if (/from doctrine_registry where id = \$1/i.test(sql)) {
        return { rows: behavior.row === undefined ? [sampleRow()] : (behavior.row ? [behavior.row] : []) };
      }
      if (/insert into memory_items/i.test(sql)) {
        if (behavior.insertThrows) throw new Error(behavior.insertThrows);
        return { rows: [{ id: behavior.newMemoryId || 'new-memory-id-001' }] };
      }
      if (/update doctrine_registry set status = 'ratified'/i.test(sql)) {
        if (behavior.statusUpdateThrows) throw new Error(behavior.statusUpdateThrows);
        return {};
      }
      if (/update doctrine_registry set status = 'rejected'/i.test(sql)) return {};
      if (/insert into memory_relationships/i.test(sql)) {
        if (behavior.edgeThrows) throw new Error(behavior.edgeThrows);
        return {};
      }
      if (/from doctrine_registry order by updated_at/i.test(sql) || /from doctrine_registry where status = \$1 order by updated_at/i.test(sql)) {
        return { rows: behavior.listRows || [] };
      }
      return { rows: [] };
    },
    async end() {},
  };
}

function withStubGhState(state, fn) {
  const prev = process.env.STUB_GH_PR_STATE;
  process.env.STUB_GH_PR_STATE = state;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.STUB_GH_PR_STATE;
    else process.env.STUB_GH_PR_STATE = prev;
  });
}

// ---------------------------------------------------------------------------
// cmdRatify — the embedding-first / transaction-wrapped ordering
// (T4-CODEX AUDIT-FAIL 12:46 ET, fixed, re-verified 12:55 ET).
// ---------------------------------------------------------------------------

test('cmdRatify refuses when no PR exists yet', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow();
  seedRegistryEntry(repoPath, row);
  const client = makeFakeClient({ row });
  try {
    await withStubGhState('NONE', async () => {
      const code = await doctrineCli.__test.cmdRatify(client, repoPath, doctrine, row.id, { ghBin: STUB_GH });
      assert.equal(code, 1, 'no PR found -> refuse, exit 1');
    });
    assert.equal(client.calls.some((c) => /insert into memory_items/i.test(c.sql)), false,
      'must not have attempted the memory_items insert with no PR');
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('cmdRatify refuses while the PR is OPEN (not yet merged)', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow();
  seedRegistryEntry(repoPath, row);
  const client = makeFakeClient({ row });
  try {
    await withStubGhState('OPEN', async () => {
      const code = await doctrineCli.__test.cmdRatify(client, repoPath, doctrine, row.id, { ghBin: STUB_GH });
      assert.equal(code, 1, 'PR open -> refuse, exit 1');
    });
    assert.equal(client.calls.some((c) => /insert into memory_items/i.test(c.sql)), false);
    const entries = readRegistry(repoPath);
    assert.equal(entries[0].status, 'proposed', 'registry entry unchanged while PR is open');
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('cmdRatify ABORTS with nothing mutated when embedding generation fails (AMEND-1 / T4 12:46 ET)', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow();
  seedRegistryEntry(repoPath, row);
  const client = makeFakeClient({ row });
  const origGenerate = docSync.generateEmbedding;
  docSync.generateEmbedding = async () => { throw new Error('OpenAI unreachable (simulated)'); };
  try {
    await withStubGhState('MERGED', async () => {
      const code = await doctrineCli.__test.cmdRatify(client, repoPath, doctrine, row.id, { ghBin: STUB_GH });
      assert.equal(code, 2, 'embedding failure -> infra-failure exit code');
    });
    assert.equal(client.calls.some((c) => /^begin$/i.test(c.sql.trim())), false,
      'must never even open a transaction if the embedding failed first');
    assert.equal(client.calls.some((c) => /insert into memory_items/i.test(c.sql)), false);
    assert.equal(client.calls.some((c) => /update doctrine_registry set status = .ratified./i.test(c.sql)), false);
    const entries = readRegistry(repoPath);
    assert.equal(entries[0].status, 'proposed', 'registry entry stays proposed — nothing mutated on embedding failure');
  } finally {
    docSync.generateEmbedding = origGenerate;
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('cmdRatify succeeds end-to-end when the PR is MERGED: embedding -> INSERT -> COMMIT -> registry -> edges, in that order', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow();
  seedRegistryEntry(repoPath, row);
  const client = makeFakeClient({ row, newMemoryId: 'memory-xyz' });
  const origGenerate = docSync.generateEmbedding;
  const fakeEmbedding = new Array(1536).fill(0.01);
  docSync.generateEmbedding = async () => fakeEmbedding;
  try {
    await withStubGhState('MERGED', async () => {
      const code = await doctrineCli.__test.cmdRatify(client, repoPath, doctrine, row.id, { ghBin: STUB_GH });
      assert.equal(code, 0, 'merged PR + healthy embedding -> success');
    });

    // Ordering: embedding must be generated (implied by the insert carrying
    // it) BEFORE the transaction opens; INSERT before status UPDATE; COMMIT
    // before the registry.jsonl write (verified below via final file state).
    const sqlSeq = client.calls.map((c) => c.sql.trim().split('\n')[0]);
    const beginIdx = sqlSeq.findIndex((s) => /^begin$/i.test(s));
    const insertIdx = client.calls.findIndex((c) => /insert into memory_items/i.test(c.sql));
    const statusIdx = client.calls.findIndex((c) => /update doctrine_registry set status = 'ratified'/i.test(c.sql));
    const commitIdx = sqlSeq.findIndex((s) => /^commit$/i.test(s));
    assert.ok(beginIdx < insertIdx, 'BEGIN before INSERT');
    assert.ok(insertIdx < statusIdx, 'INSERT before the ratified status UPDATE');
    assert.ok(statusIdx < commitIdx, 'status UPDATE before COMMIT');
    assert.equal(client.committed, true);
    assert.equal(client.rolledBack, false);

    // The embedding actually reached the INSERT params.
    const insertCall = client.calls[insertIdx];
    assert.ok(insertCall.params.some((p) => typeof p === 'string' && p.startsWith('[0.01,')),
      'the fake embedding must be formatted into the INSERT params');

    // memory_link 'elevated_to' edges attempted for both cluster members.
    const edgeCalls = client.calls.filter((c) => /insert into memory_relationships/i.test(c.sql));
    assert.equal(edgeCalls.length, 2);
    assert.ok(edgeCalls.every((c) => c.params[1] === 'memory-xyz'), 'every edge targets the new memory row');

    // registry.jsonl flipped proposed -> active only AFTER commit succeeded.
    const entries = readRegistry(repoPath);
    assert.equal(entries[0].status, 'active');
    assert.equal(doctrine.validateEntry(entries[0]).valid, true);
  } finally {
    docSync.generateEmbedding = origGenerate;
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('cmdRatify rolls back the transaction (never commits) when the memory_items insert throws', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow();
  seedRegistryEntry(repoPath, row);
  const client = makeFakeClient({ row, insertThrows: 'simulated insert failure' });
  const origGenerate = docSync.generateEmbedding;
  docSync.generateEmbedding = async () => new Array(1536).fill(0.02);
  try {
    await withStubGhState('MERGED', async () => {
      const code = await doctrineCli.__test.cmdRatify(client, repoPath, doctrine, row.id, { ghBin: STUB_GH });
      assert.equal(code, 2);
    });
    assert.equal(client.committed, false);
    assert.equal(client.rolledBack, true);
    const entries = readRegistry(repoPath);
    assert.equal(entries[0].status, 'proposed', 'registry never touched — DB rollback means no ratification happened');
  } finally {
    docSync.generateEmbedding = origGenerate;
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('cmdRatify refuses a row that is not status=proposed (e.g. still drafted, or already ratified)', async () => {
  for (const status of ['drafted', 'ratified', 'rejected', 'candidate']) {
    const repoPath = tmpRepo();
    const row = sampleRow({ status });
    const client = makeFakeClient({ row });
    try {
      const code = await doctrineCli.__test.cmdRatify(client, repoPath, doctrine, row.id, { ghBin: STUB_GH });
      assert.equal(code, 1, `status=${status} must refuse`);
      assert.equal(client.calls.some((c) => /insert into memory_items/i.test(c.sql)), false);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }
});

test('cmdRatify reports the registry.jsonl update failure honestly instead of claiming status=active (T4 12:55 ET)', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow();
  // Deliberately do NOT seed a registry entry — updateRegistryEntry will
  // fail to find it, simulating a registry.jsonl write/read problem.
  const client = makeFakeClient({ row, newMemoryId: 'memory-no-registry' });
  const origGenerate = docSync.generateEmbedding;
  docSync.generateEmbedding = async () => new Array(1536).fill(0.03);
  const origWarn = console.warn;
  const origLog = console.log;
  const warnings = [];
  const logs = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await withStubGhState('MERGED', async () => {
      const code = await doctrineCli.__test.cmdRatify(client, repoPath, doctrine, row.id, { ghBin: STUB_GH });
      // Still a SUCCESS at the process level — the memory row is ratified
      // and recallable; only the repo-file mirror lagged.
      assert.equal(code, 0);
    });
    assert.ok(warnings.some((w) => /registry/i.test(w)), 'a warning about the registry mismatch must be printed');
    assert.ok(!logs.some((l) => /status='active'/.test(l)),
      'the final success line must NOT claim status=active when the registry write failed');
    assert.ok(logs.some((l) => /could NOT be updated/i.test(l)),
      'the final success line must say the registry entry could not be updated');
  } finally {
    console.warn = origWarn;
    console.log = origLog;
    docSync.generateEmbedding = origGenerate;
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cmdReject
// ---------------------------------------------------------------------------

test('cmdReject flips status to rejected and best-effort closes an OPEN PR', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow();
  const client = makeFakeClient({ row });
  try {
    const ghLog = path.join(repoPath, 'gh.log');
    const prevLog = process.env.STUB_GH_LOG;
    process.env.STUB_GH_LOG = ghLog;
    await withStubGhState('OPEN', async () => {
      const code = await doctrineCli.__test.cmdReject(client, repoPath, row.id, { reason: 'bad cluster' }, { ghBin: STUB_GH });
      assert.equal(code, 0);
    });
    if (prevLog === undefined) delete process.env.STUB_GH_LOG; else process.env.STUB_GH_LOG = prevLog;
    assert.ok(client.calls.some((c) => /update doctrine_registry set status = 'rejected'/i.test(c.sql)));
    const logText = fs.readFileSync(ghLog, 'utf8');
    assert.match(logText, /gh pr close 9999/, 'an OPEN PR must be closed on reject');
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('cmdReject refuses a row that is already ratified', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow({ status: 'ratified' });
  const client = makeFakeClient({ row });
  try {
    const code = await doctrineCli.__test.cmdReject(client, repoPath, row.id, {}, { ghBin: STUB_GH });
    assert.equal(code, 1);
    assert.equal(client.calls.some((c) => /status = 'rejected'/i.test(c.sql)), false);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cmdPromote
// ---------------------------------------------------------------------------

test('cmdPromote requires status=ratified and stages preToolUse-deny/block metadata (AMEND-5 forward-declaration)', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow({ status: 'ratified' });
  const entry = seedRegistryEntry(repoPath, row);
  // The seeded entry has status:'proposed' (buildRegistryEntry's default) —
  // simulate a prior ratify having already flipped it to 'active' on disk.
  const lines = fs.readFileSync(path.join(repoPath, 'doctrine', 'registry.jsonl'), 'utf8').trim().split('\n');
  fs.writeFileSync(path.join(repoPath, 'doctrine', 'registry.jsonl'),
    `${JSON.stringify({ ...JSON.parse(lines[0]), status: 'active' })}\n`, 'utf8');
  const client = makeFakeClient({ row });
  try {
    const code = await doctrineCli.__test.cmdPromote(client, repoPath, doctrine, row.id);
    assert.equal(code, 0);
    const after = readRegistry(repoPath)[0];
    assert.equal(after.enforcement.surface, 'preToolUse-deny');
    assert.equal(after.enforcement.max_severity, 'block');
    assert.ok(after.promoted_at);
    assert.equal(doctrine.validateEntry(after).valid, true, 'block on preToolUse-deny is architecturally allowed (BLOCK_ALLOWED_SURFACES)');
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

test('cmdPromote refuses a row that is not yet ratified', async () => {
  const repoPath = tmpRepo();
  const row = sampleRow({ status: 'proposed' });
  const client = makeFakeClient({ row });
  try {
    const code = await doctrineCli.__test.cmdPromote(client, repoPath, doctrine, row.id);
    assert.equal(code, 1);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// cmdList
// ---------------------------------------------------------------------------

test('cmdList prints a friendly message on an empty registry and does not throw', async () => {
  const client = makeFakeClient({ listRows: [] });
  const origLog = console.log;
  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await doctrineCli.__test.cmdList(client, {});
    assert.equal(code, 0);
    assert.ok(logs.some((l) => /empty/i.test(l)));
  } finally {
    console.log = origLog;
  }
});

test('cmdList filters by --status', async () => {
  const client = makeFakeClient({ listRows: [sampleRow({ status: 'proposed' })] });
  const origLog = console.log;
  console.log = () => {};
  try {
    const code = await doctrineCli.__test.cmdList(client, { status: 'proposed' });
    assert.equal(code, 0);
    assert.ok(client.calls.some((c) => c.params && c.params[0] === 'proposed'));
  } finally {
    console.log = origLog;
  }
});
