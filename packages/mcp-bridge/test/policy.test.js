'use strict';

// Tests for the Bridge access policy (assertReadOnly / requiresApproval /
// visiblePanels). Dependency-free (node:test).

const { test } = require('node:test');
const assert = require('node:assert');
const { assertReadOnly, requiresApproval, visiblePanels } = require('../src/policy');

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

// ── requiresApproval ────────────────────────────────────────────────────────

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
