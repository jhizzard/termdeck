// Sprint 50 T3 — /api/agents projection contract.
//
// Pins the shape of GET /api/agents (the richer adapter projection added in
// Sprint 50 T3) and the displayName-extended GET /api/agent-adapters
// projection. Both projections live inline in createServer() — this test
// guards their shape by re-running the projection logic against the live
// AGENT_ADAPTERS registry.
//
// Why test the projection shape and not the express route directly: the
// inline routes in packages/server/src/index.js are wired through
// createServer() which boots the full PTY reaper + WebSocket layer + RAG
// integration. A focused projection test catches the regressions that
// matter (missing displayName, wrong shape, breaking change to
// /api/agent-adapters consumers) without that overhead. The launcher-
// resolver suite already pins the downstream consumer contract.
//
// Run: node --test tests/api-agents-projection.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { AGENT_ADAPTERS } = require('../packages/server/src/agent-adapters');

// Verbatim copies of the projection logic from packages/server/src/index.js.
// If those routes change shape, update both — the assertions below pin the
// public contract that index.html / app.js / launcher-resolver depend on.

function projectAgentAdapters() {
  return Object.values(AGENT_ADAPTERS).map((a) => ({
    name: a.name,
    sessionType: a.sessionType,
    binary: a.spawn && a.spawn.binary,
    costBand: a.costBand,
    displayName: a.displayName || a.name,
  }));
}

function projectAgents() {
  return Object.values(AGENT_ADAPTERS).map((a) => ({
    name: a.name,
    sessionType: a.sessionType,
    displayName: a.displayName || a.name,
    spawn: {
      binary: (a.spawn && a.spawn.binary) || a.name,
      defaultArgs: (a.spawn && Array.isArray(a.spawn.defaultArgs))
        ? a.spawn.defaultArgs.slice()
        : [],
    },
    costBand: a.costBand,
  }));
}

test('/api/agent-adapters projection includes displayName', () => {
  const list = projectAgentAdapters();
  assert.ok(list.length >= 1, 'at least one adapter expected');
  for (const entry of list) {
    assert.equal(typeof entry.name, 'string', 'name is a string');
    assert.equal(typeof entry.sessionType, 'string', 'sessionType is a string');
    assert.equal(typeof entry.binary, 'string', 'binary is a string');
    assert.equal(typeof entry.displayName, 'string', 'displayName is a string');
    assert.ok(entry.displayName.length > 0, 'displayName is non-empty');
  }
});

test('/api/agent-adapters projection preserves Sprint 45 fields (backwards-compat)', () => {
  const list = projectAgentAdapters();
  for (const entry of list) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(entry, 'name'),
      'name field present',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(entry, 'sessionType'),
      'sessionType field present',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(entry, 'binary'),
      'binary field present (launcher-resolver depends on this)',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(entry, 'costBand'),
      'costBand field present',
    );
  }
});

test('/api/agents projection exposes spawn descriptor + displayName', () => {
  const list = projectAgents();
  assert.ok(list.length >= 1);
  for (const entry of list) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.sessionType, 'string');
    assert.equal(typeof entry.displayName, 'string');
    assert.ok(entry.displayName.length > 0);
    assert.ok(entry.spawn && typeof entry.spawn === 'object');
    assert.equal(typeof entry.spawn.binary, 'string');
    assert.ok(entry.spawn.binary.length > 0);
    assert.ok(Array.isArray(entry.spawn.defaultArgs));
    assert.equal(typeof entry.costBand, 'string');
  }
});

test('/api/agents defaultArgs is a defensive copy, not the adapter reference', () => {
  const list = projectAgents();
  for (const entry of list) {
    const adapter = Object.values(AGENT_ADAPTERS).find((a) => a.name === entry.name);
    if (adapter && Array.isArray(adapter.spawn.defaultArgs)) {
      assert.notStrictEqual(
        entry.spawn.defaultArgs,
        adapter.spawn.defaultArgs,
        `${entry.name}: defaultArgs must be a copy so client mutation can't reach the adapter`,
      );
    }
  }
});

test('every adapter appears in both projections with matching name + sessionType', () => {
  const adapters = projectAgentAdapters();
  const agents = projectAgents();
  assert.equal(adapters.length, agents.length, 'projections cover the same adapters');
  const aByName = new Map(adapters.map((a) => [a.name, a]));
  for (const g of agents) {
    const a = aByName.get(g.name);
    assert.ok(a, `${g.name}: present in /api/agent-adapters projection`);
    assert.equal(a.sessionType, g.sessionType, `${g.name}: sessionType matches`);
    assert.equal(a.displayName, g.displayName, `${g.name}: displayName matches`);
    assert.equal(a.binary, g.spawn.binary, `${g.name}: binary matches`);
  }
});

test('expected adapter set is registered (claude/codex/gemini/grok)', () => {
  const names = projectAgents().map((a) => a.name).sort();
  assert.deepEqual(names, ['claude', 'codex', 'gemini', 'grok']);
});

test('displayNames match the Sprint 50 T3 lane brief labels', () => {
  const byName = new Map(projectAgents().map((a) => [a.name, a]));
  assert.equal(byName.get('claude').displayName, 'Claude Code');
  assert.equal(byName.get('codex').displayName, 'Codex CLI');
  assert.equal(byName.get('gemini').displayName, 'Gemini CLI');
  assert.equal(byName.get('grok').displayName, 'Grok CLI');
});
