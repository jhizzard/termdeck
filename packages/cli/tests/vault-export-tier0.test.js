// Sprint 71 B-T2 — the vault's tier-0 render (Home.md + every MOC).
//
// The property under test is SYMMETRY. The human opening the vault and the
// agent booting a panel must be looking at the same standing objectives, in the
// same order, with the same wording. If the vault renders its own variant, the
// operator ends up reasoning about a system that is being told something else —
// and that divergence is invisible from either side alone.
//
// Fixture-driven on purpose: no live vault regeneration (that would rewrite a
// real Obsidian tree), and no DB (the objectives table does not exist yet).
//
// Run: node --test packages/cli/tests/vault-export-tier0.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const vaultExport = require('../src/vault-export');
const tier0lib = require('../../server/src/tier0');

const OBJECTIVES = tier0lib.normalizeObjectives([
  { id: 'o1', project: 'termdeck', text: 'Zero build step is locked.', rank: 1, ratified_at: '2026-08-01' },
  { id: 'o2', project: 'termdeck', text: 'Never leak the internal project name externally.', rank: 2 },
]);

const HOME_VIEW = {
  stats: { notes: 12, edges: 3, newest: '2026-08-05', oldest: '2026-01-01', excluded_privacy: 0, dangling_members: 0 },
  hubs: [],
  projects: [{ moc_name: 'MOC - termdeck', project: 'termdeck', slug: 'termdeck', count: 12, hub_count: 0 }],
  recent: [],
  doctrine: [],
};

const MOC_VIEW = {
  project: 'termdeck', slug: 'termdeck', hubs: [], recent: [], count: 12,
};

// ── Home ────────────────────────────────────────────────────────────────────

test('Home.md — renders the tier-0 block when objectives exist', () => {
  const md = vaultExport.renderHome({ ...HOME_VIEW, tier0: OBJECTIVES });
  assert.match(md, /## Objectives \(tier 0\)/);
  assert.match(md, /1\. Zero build step is locked\./);
  assert.match(md, /2\. Never leak the internal project name externally\./);
  assert.match(md, /Tier 0 — injected into every agent session/);
});

test('Home.md — the tier-0 block sits ABOVE the store statistics', () => {
  const md = vaultExport.renderHome({ ...HOME_VIEW, tier0: OBJECTIVES });
  assert.ok(
    md.indexOf('## Objectives (tier 0)') < md.indexOf('## The store right now'),
    'the first thing on the page should be what the project is FOR, not how '
    + 'many notes are in it',
  );
});

test('Home.md — emits NOTHING tier-0-shaped when there are no objectives', () => {
  const md = vaultExport.renderHome({ ...HOME_VIEW, tier0: [] });
  assert.doesNotMatch(md, /Objectives \(tier 0\)/);
  assert.doesNotMatch(md, /Tier 0 —/);
  // A heading over an empty list reads as a broken feature. Absence reads as
  // absence, which is the truth on every store until migration 038 applies.
});

test('Home.md — an absent tier0 field degrades exactly like an empty one', () => {
  // The exporter must survive being called by anything that predates this
  // field, including its own older tests.
  const withUndefined = vaultExport.renderHome({ ...HOME_VIEW });
  const withEmpty = vaultExport.renderHome({ ...HOME_VIEW, tier0: [] });
  assert.equal(withUndefined, withEmpty);
});

// ── MOCs ────────────────────────────────────────────────────────────────────

test('MOC — renders the project tier-0 block above the note count', () => {
  const md = vaultExport.renderMoc({ ...MOC_VIEW, tier0: OBJECTIVES });
  assert.match(md, /## Objectives \(tier 0\)/);
  assert.ok(
    md.indexOf('## Objectives (tier 0)') < md.indexOf('**12** notes in this project.'),
  );
});

test('MOC — no objectives for this project means no tier-0 section', () => {
  const md = vaultExport.renderMoc({ ...MOC_VIEW, tier0: [] });
  assert.doesNotMatch(md, /Objectives \(tier 0\)/);
  assert.match(md, /\*\*12\*\* notes in this project\./, 'the rest of the MOC is unchanged');
});

test('MOC — still renders correctly with the tier0 field absent', () => {
  assert.equal(
    vaultExport.renderMoc({ ...MOC_VIEW }),
    vaultExport.renderMoc({ ...MOC_VIEW, tier0: [] }),
  );
});

// ── symmetry with what the agents are injected ──────────────────────────────

test('SYMMETRY — the vault block is byte-identical to the injected block', () => {
  const md = vaultExport.renderHome({ ...HOME_VIEW, tier0: OBJECTIVES });
  const injected = tier0lib.renderTier0Block(OBJECTIVES);
  assert.ok(md.includes(injected),
    'the vault must embed the exact rendered block the agents receive — a '
    + 'reworded vault copy means the human and the agent are reading two '
    + 'different sets of rules');
});

test('SYMMETRY — retired objectives are absent from the vault, as from injection', () => {
  const rows = tier0lib.normalizeObjectives([
    { id: 'live', text: 'Still binding.', rank: 1 },
    { id: 'dead', text: 'This was retired.', rank: 2, status: 'superseded' },
    { id: 'chained', text: 'Replaced by a newer one.', rank: 3, superseded_by: 'live' },
  ]);
  const md = vaultExport.renderHome({ ...HOME_VIEW, tier0: rows });
  assert.match(md, /Still binding\./);
  assert.doesNotMatch(md, /This was retired\./);
  assert.doesNotMatch(md, /Replaced by a newer one\./);
});

// ── the pg guard ────────────────────────────────────────────────────────────

test('fetchTier0FromPg — pre-038 store (table absent) returns [] without querying it', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push(sql);
      if (sql.includes('to_regclass')) return { rows: [{ t: null }] };
      throw new Error('the objectives table must NOT be queried when to_regclass says it is absent');
    },
  };
  assert.deepEqual(await vaultExport.fetchTier0FromPg(client, 'termdeck'), []);
  assert.equal(queries.length, 1, 'exactly one catalog probe, no table read');
});

test('fetchTier0FromPg — reads and normalizes when the table exists', async () => {
  const client = {
    async query(sql, params) {
      if (sql.includes('to_regclass')) return { rows: [{ t: 'memory_objectives' }] };
      if (sql.includes('information_schema.columns')) return { rows: [{ '?column?': 1 }] };
      assert.deepEqual(params, ['termdeck'], 'scoped to the requested project');
      return { rows: [
        { id: 'b', text: 'second', rank: 2 },
        { id: 'a', text: 'first', rank: 1 },
      ] };
    },
  };
  const out = await vaultExport.fetchTier0FromPg(client, 'termdeck');
  assert.deepEqual(out.map((o) => o.text), ['first', 'second']);
});

test('fetchTier0FromPg — filters to active WHEN the status column exists', async () => {
  let selectSql = '';
  const client = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rows: [{ t: 'memory_objectives' }] };
      if (sql.includes('information_schema.columns')) return { rows: [{ ok: 1 }] };
      selectSql = sql;
      return { rows: [] };
    },
  };
  await vaultExport.fetchTier0FromPg(client, 'termdeck');
  assert.match(selectSql, /status = 'active'/);
});

test('fetchTier0FromPg — omits the status filter when the column is ABSENT', async () => {
  // An unconditional `status = 'active'` would throw on a differently-shaped
  // table, and the catch turns a throw into an empty list — so the vault would
  // silently lose its objectives section instead of saying anything. The JS
  // deny-list filter is the real guarantee; this is only an optimisation, and
  // an optimisation must not be able to blank the feature.
  let selectSql = '';
  const client = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rows: [{ t: 'memory_objectives' }] };
      if (sql.includes('information_schema.columns')) return { rows: [] };
      selectSql = sql;
      return { rows: [{ id: 'a', text: 'still rendered', rank: 1 }] };
    },
  };
  const out = await vaultExport.fetchTier0FromPg(client, 'termdeck');
  assert.doesNotMatch(selectSql, /status = 'active'/);
  assert.equal(out.length, 1, 'the objectives still render on a table without a status column');
});

test('fetchTier0FromPg — a retired row is dropped even when SQL did not filter it', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('to_regclass')) return { rows: [{ t: 'memory_objectives' }] };
      if (sql.includes('information_schema.columns')) return { rows: [] };
      return { rows: [
        { id: 'a', text: 'live one', rank: 1, status: 'active' },
        { id: 'b', text: 'superseded one', rank: 2, status: 'superseded' },
      ] };
    },
  };
  const out = await vaultExport.fetchTier0FromPg(client, 'termdeck');
  assert.deepEqual(out.map((o) => o.text), ['live one']);
});

test('fetchTier0FromPg — a throwing client yields [] rather than failing the export', async () => {
  const client = { async query() { throw new Error('permission denied'); } };
  assert.deepEqual(await vaultExport.fetchTier0FromPg(client, 'termdeck'), []);
});

test('fetchTier0FromPg — refuses a non-identifier table name instead of escaping it', async () => {
  const orig = process.env.TERMDECK_TIER0_TABLE;
  process.env.TERMDECK_TIER0_TABLE = 'objectives"; drop table memory_items; --';
  try {
    let called = false;
    const client = { async query() { called = true; return { rows: [] }; } };
    assert.deepEqual(await vaultExport.fetchTier0FromPg(client, null), []);
    assert.equal(called, false, 'the value reaches a query as an IDENTIFIER — an '
      + 'allow-list is the only honest handling; it is never escaped and passed on');
  } finally {
    if (orig === undefined) delete process.env.TERMDECK_TIER0_TABLE;
    else process.env.TERMDECK_TIER0_TABLE = orig;
  }
});
