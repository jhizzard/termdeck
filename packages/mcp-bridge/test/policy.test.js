'use strict';

// Tests for the Bridge access policy (assertReadOnly / requiresApproval /
// visiblePanels — plus the Sprint 76 memory_propose carve-out + connector
// identity mapping). Dependency-free (node:test).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  assertReadOnly, requiresApproval, visiblePanels,
  PROPOSE_TOOLS, PROPOSE_ANNOTATIONS, WEB_SOURCE_AGENTS,
  loadProposeMap, mapClientToSourceAgent, normalizeWebSourceAgent,
} = require('../src/policy');

// The exact honest proposal annotation shape (and the ONLY shape that mounts).
const HONEST = { ...PROPOSE_ANNOTATIONS, title: 'Propose memory' };

// The six real Bridge tools (T3) — all read-only.
const REAL_TOOLS = [
  'memory_recall', 'memory_search', 'list_panels',
  'read_panel', 'panel_status', 'recent_activity',
];

// ── assertReadOnly ──────────────────────────────────────────────────────────

test('assertReadOnly accepts every real read-only Bridge tool', () => {
  for (const name of REAL_TOOLS) {
    assert.equal(assertReadOnly({ name }), true, `${name} should be allowed`);
  }
});

test('assertReadOnly throws on mutating tool names (name-token heuristic)', () => {
  const mutating = [
    'write_memory', 'delete_panel', 'send_input', 'exec_command',
    'run_shell', 'set_config', 'create_session', 'kill_panel',
    'update_row', 'inject_prompt', 'poke_panel',
  ];
  for (const name of mutating) {
    assert.throws(() => assertReadOnly({ name }), /read-only/i, `${name} must be rejected`);
  }
});

test('assertReadOnly rejects Mnestra/store WRITE tools even if they claim readOnlyHint:true (T4-CODEX)', () => {
  // The whole point: a write tool that LIES via readOnlyHint:true must still be
  // rejected by the unconditional name heuristic. Protects the
  // no-memory_remember / no-memory_forget guarantee.
  const writers = [
    'memory_remember', 'memory_forget', 'remember_memory', 'forget_memory',
    'store_memory', 'save_memory', 'memory_link', 'memory_unlink',
    'persist_memory', 'archive_memory', 'memory_add', 'purge_memory',
  ];
  for (const name of writers) {
    assert.throws(
      () => assertReadOnly({ name, annotations: { readOnlyHint: true } }),
      /read-only/i,
      `${name} (even claiming readOnlyHint:true) must be rejected`,
    );
  }
});

test('assertReadOnly still accepts the real memory READ tools', () => {
  for (const name of ['memory_recall', 'memory_search']) {
    assert.equal(assertReadOnly({ name, annotations: { readOnlyHint: true } }), true);
  }
});

test('assertReadOnly honors explicit capability hints over the name', () => {
  // A benign-looking name but declared writable/destructive must still throw.
  assert.throws(() => assertReadOnly({ name: 'memory_recall', annotations: { readOnlyHint: false } }), /read-only/i);
  assert.throws(() => assertReadOnly({ name: 'list_panels', annotations: { destructiveHint: true } }), /read-only/i);
  assert.throws(() => assertReadOnly({ name: 'panel_status', mutates: true }), /read-only/i);
  assert.throws(() => assertReadOnly({ name: 'panel_status', readOnly: false }), /read-only/i);
});

test('assertReadOnly accepts a read tool that sets readOnlyHint:true', () => {
  assert.equal(assertReadOnly({ name: 'read_panel', annotations: { readOnlyHint: true } }), true);
});

test('assertReadOnly rejects malformed toolDefs', () => {
  assert.throws(() => assertReadOnly(null), /TypeError|object/);
  assert.throws(() => assertReadOnly('memory_recall'), /TypeError|object/);
  assert.throws(() => assertReadOnly({}), /name/);
});

// ── the memory_propose carve-out (Sprint 76): a needle, not a hole ──────────

test('carve-out: memory_propose with the exact honest proposal shape mounts', () => {
  assert.equal(assertReadOnly({ name: 'memory_propose', annotations: HONEST }), true);
  // title is optional — the bare honest shape also mounts
  assert.equal(assertReadOnly({ name: 'memory_propose', annotations: { ...PROPOSE_ANNOTATIONS } }), true);
});

test('carve-out: the registry is exactly one name', () => {
  assert.deepEqual([...PROPOSE_TOOLS], ['memory_propose']);
});

test('carve-out: canonical write tools still throw — with honest-propose annotations AND with lying readOnlyHint:true', () => {
  for (const name of ['memory_remember', 'memory_forget', 'memory_store']) {
    assert.throws(() => assertReadOnly({ name, annotations: HONEST }), /read-only/i,
      `${name} with propose-shaped annotations must still be rejected (not in the registry)`);
    assert.throws(() => assertReadOnly({ name, annotations: { readOnlyHint: true } }), /read-only/i,
      `${name} lying readOnlyHint:true must still be rejected (name heuristic)`);
  }
});

test('carve-out: a memory_propose impostor with destructiveHint:true throws', () => {
  assert.throws(
    () => assertReadOnly({ name: 'memory_propose', annotations: { ...HONEST, destructiveHint: true } }),
    /honest/i,
  );
});

test('carve-out: a LYING memory_propose (readOnlyHint:true) throws — the channel must declare its write honestly', () => {
  assert.throws(
    () => assertReadOnly({ name: 'memory_propose', annotations: { ...HONEST, readOnlyHint: true } }),
    /honest/i,
  );
});

test('carve-out: any deviation from the exact shape throws (missing/extra/aliased)', () => {
  // no annotations at all
  assert.throws(() => assertReadOnly({ name: 'memory_propose' }), /honest/i);
  // missing one hint
  const missing = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  assert.throws(() => assertReadOnly({ name: 'memory_propose', annotations: missing }), /honest/i);
  // idempotentHint lie (a propose appends a new row per call)
  assert.throws(
    () => assertReadOnly({ name: 'memory_propose', annotations: { ...HONEST, idempotentHint: true } }),
    /honest/i,
  );
  // unknown extra annotation key
  assert.throws(
    () => assertReadOnly({ name: 'memory_propose', annotations: { ...HONEST, sneaky: 1 } }),
    /honest/i,
  );
  // top-level destructive/mutates/readOnly aliases
  assert.throws(() => assertReadOnly({ name: 'memory_propose', annotations: HONEST, destructive: true }), /honest/i);
  assert.throws(() => assertReadOnly({ name: 'memory_propose', annotations: HONEST, mutates: true }), /honest/i);
  assert.throws(() => assertReadOnly({ name: 'memory_propose', annotations: HONEST, readOnly: true }), /honest/i);
});

test('carve-out: panel_propose (name NOT in the registry) throws in every shape, including lying readOnlyHint:true', () => {
  assert.throws(() => assertReadOnly({ name: 'panel_propose', annotations: HONEST }), /read-only/i);
  assert.throws(() => assertReadOnly({ name: 'panel_propose', annotations: { readOnlyHint: true } }), /read-only/i,
    'the new propose verb token must catch a lying *_propose impostor');
  assert.throws(() => assertReadOnly({ name: 'memory_proposals', annotations: { readOnlyHint: true } }), /read-only/i);
});

// ── connector identity → source_agent (fail-closed) ─────────────────────────

test('WEB_SOURCE_AGENTS is exactly the four *-web values', () => {
  assert.deepEqual([...WEB_SOURCE_AGENTS].sort(), ['chatgpt-web', 'claude-web', 'gemini-web', 'grok-web']);
});

test('normalizeWebSourceAgent: trims + lowercases, exact-matches, rejects CLI values and near-misses', () => {
  assert.equal(normalizeWebSourceAgent(' GROK-WEB '), 'grok-web');
  assert.equal(normalizeWebSourceAgent('claude-web'), 'claude-web');
  assert.equal(normalizeWebSourceAgent('chatgpt-web2'), null); // near-miss typo
  assert.equal(normalizeWebSourceAgent('grok'), null); // CLI value can never be minted
  assert.equal(normalizeWebSourceAgent('claude'), null);
  assert.equal(normalizeWebSourceAgent(''), null);
  assert.equal(normalizeWebSourceAgent(null), null);
});

test('loadProposeMap: env CSV pairs load; invalid values are IGNORED (fail-closed to unmappable)', () => {
  const env = {
    TERMDECK_BRIDGE_PROPOSE_FILE: '/nonexistent/bridge-propose.json',
    TERMDECK_BRIDGE_PROPOSE_MAP: 'mcp_a=claude-web, mcp_b= GROK-WEB ,mcp_bad=chatgpt-web2,mcp_cli=grok,=claude-web,broken',
  };
  const map = loadProposeMap(env);
  assert.equal(map.get('mcp_a'), 'claude-web');
  assert.equal(map.get('mcp_b'), 'grok-web'); // operator padding/case normalized
  assert.equal(map.has('mcp_bad'), false, 'a typo value must not mint an identity');
  assert.equal(map.has('mcp_cli'), false, 'a CLI value must not mint an identity');
  assert.equal(map.size, 2);
});

test('loadProposeMap: file loads via TERMDECK_BRIDGE_PROPOSE_FILE; env wins on conflict; absent file is fine', () => {
  const fixture = path.join(__dirname, 'fixtures', 'bridge-propose.fixture.json');
  const env = {
    TERMDECK_BRIDGE_PROPOSE_FILE: fixture,
    TERMDECK_BRIDGE_PROPOSE_MAP: 'mcp_filemapped=gemini-web', // overrides the file's claude-web
  };
  const map = loadProposeMap(env);
  assert.equal(map.get('mcp_filemapped'), 'gemini-web', 'env override wins');
  assert.equal(map.get('mcp_padded'), 'grok-web', 'file value normalized');
  assert.equal(map.has('mcp_invalid'), false, 'invalid file value ignored');
  // absent file → env-only
  const none = loadProposeMap({ TERMDECK_BRIDGE_PROPOSE_FILE: '/nonexistent/x.json' });
  assert.equal(none.size, 0);
});

test('mapClientToSourceAgent: explicit map wins; conservative heuristic; ambiguity and unknowns fail to null', () => {
  const map = new Map([['mcp_x', 'grok-web']]);
  // explicit map beats the heuristic
  assert.equal(mapClientToSourceAgent({ clientId: 'mcp_x', clientName: 'Claude', map }), 'grok-web');
  // heuristic per family
  assert.equal(mapClientToSourceAgent({ clientId: 'a', clientName: 'Claude', map: new Map() }), 'claude-web');
  assert.equal(mapClientToSourceAgent({ clientId: 'a', clientName: 'ChatGPT Connector', map: new Map() }), 'chatgpt-web');
  assert.equal(mapClientToSourceAgent({ clientId: 'a', clientName: 'xAI Grok', map: new Map() }), 'grok-web');
  assert.equal(mapClientToSourceAgent({ clientId: 'a', clientName: 'Google Gemini', map: new Map() }), 'gemini-web');
  // ambiguous (two families) → null
  assert.equal(mapClientToSourceAgent({ clientId: 'a', clientName: 'Claude via Google', map: new Map() }), null);
  // no name, unknown name → null
  assert.equal(mapClientToSourceAgent({ clientId: 'a', clientName: '', map: new Map() }), null);
  assert.equal(mapClientToSourceAgent({ clientId: 'a', clientName: 'SomeRandomClient', map: new Map() }), null);
  // static-dev-bearer has no DCR record → no name → null unless explicitly mapped
  assert.equal(mapClientToSourceAgent({ clientId: 'static-dev-bearer', clientName: '', map: new Map() }), null);
  assert.equal(
    mapClientToSourceAgent({ clientId: 'static-dev-bearer', clientName: '', map: new Map([['static-dev-bearer', 'claude-web']]) }),
    'claude-web',
  );
});

// ── requiresApproval ────────────────────────────────────────────────────────

test('requiresApproval: memory_propose is EXPLICITLY approval-gated', () => {
  assert.equal(requiresApproval('memory_propose'), true);
});

test('requiresApproval: memory reads do not, terminal-state tools do', () => {
  assert.equal(requiresApproval('memory_recall'), false);
  assert.equal(requiresApproval('memory_search'), false);
  assert.equal(requiresApproval('list_panels'), true);
  assert.equal(requiresApproval('read_panel'), true);
  assert.equal(requiresApproval('panel_status'), true);
  assert.equal(requiresApproval('recent_activity'), true);
});

test('requiresApproval is fail-safe (unknown tool → approval required)', () => {
  assert.equal(requiresApproval('some_future_tool'), true);
  assert.equal(requiresApproval(''), true);
  assert.equal(requiresApproval(undefined), true);
});

// ── visiblePanels (default-deny project/panel allowlist) ────────────────────

const AL = (projects = [], panels = []) => ({
  allowlist: { projects: new Set(projects), panels: new Set(panels) },
});

const SESSIONS = [
  { id: 'sid-1', project: 'termdeck' },
  { sessionId: 'sid-2', cwd: '/Users/u/Documents/other-project' },
  { meta: { id: 'sid-3', project: 'mnestra' } },
  { id: 'sid-4', cwd: '/srv/work/termdeck' }, // project derived from cwd basename
];

test('visiblePanels is default-deny with no allowlist configured', () => {
  // No env vars, file pointed at a nonexistent path → empty allowlist → nothing.
  const out = visiblePanels(SESSIONS, { env: { TERMDECK_BRIDGE_ALLOWLIST_FILE: '/nonexistent/al.json' } });
  assert.deepEqual(out, []);
});

test('visiblePanels filters by project allowlist (incl. cwd-basename derivation)', () => {
  const out = visiblePanels(SESSIONS, AL(['termdeck']));
  const ids = out.map((s) => s.id || s.sessionId || (s.meta && s.meta.id));
  assert.deepEqual(ids.sort(), ['sid-1', 'sid-4'], 'both termdeck panels (explicit + cwd-derived) visible');
});

test('visiblePanels filters by explicit panel-id allowlist', () => {
  const out = visiblePanels(SESSIONS, AL([], ['sid-2']));
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'sid-2');
});

test('visiblePanels honors a "*" wildcard (opt-in to all)', () => {
  assert.equal(visiblePanels(SESSIONS, AL(['*'])).length, SESSIONS.length);
  assert.equal(visiblePanels(SESSIONS, AL([], ['*'])).length, SESSIONS.length);
});

test('visiblePanels tolerates non-array / empty input', () => {
  assert.deepEqual(visiblePanels(null, AL(['*'])), []);
  assert.deepEqual(visiblePanels([], AL(['*'])), []);
});

test('visiblePanels project + panel allow are unioned', () => {
  const out = visiblePanels(SESSIONS, AL(['mnestra'], ['sid-1']));
  const ids = out.map((s) => s.id || s.sessionId || (s.meta && s.meta.id)).sort();
  assert.deepEqual(ids, ['sid-1', 'sid-3']);
});
