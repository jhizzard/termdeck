// Regression tests for resolveProjectName / _projectFor in
// packages/server/src/rag.js.
//
// Sprint 34 (project-tag fix). The chopin-nashville mis-tag that bloated
// memory_items came from an out-of-repo writer (~/.claude/hooks/memory-session-end.js),
// not from TermDeck's writer chain. These tests pin the TermDeck-side
// behavior so a future regression in resolveProjectName — first-match-wins,
// dropped path-sep boundary, sloppy fallback — would fail loud here.
//
// Run: node --test tests/project-tag-resolution.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { RAGIntegration, resolveProjectName } = require('../packages/server/src/rag.js');

// The exact path Josh's TermDeck checkout lives at. The hook's
// /ChopinNashville/i pattern fires on this cwd; resolveProjectName must NOT.
const TERMDECK_CWD = '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck';

const TERMDECK_CONFIG = {
  projects: {
    termdeck: { path: TERMDECK_CWD },
    podium: { path: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia/podium' },
    'ai-council': { path: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/AICouncil' },
    engram: { path: '/Users/joshuaizzard/Documents/Graciella/engram' },
  },
};

test('resolveProjectName: longest-prefix wins (leaf beats ancestor)', () => {
  const config = {
    projects: {
      outer: { path: '/a/b' },
      inner: { path: '/a/b/c' },
    },
  };
  assert.equal(resolveProjectName('/a/b/c/d', config), 'inner');
});

test('resolveProjectName: subdirectory of registered project resolves to that project', () => {
  // The TermDeck server frequently runs from packages/server, packages/cli, etc.
  // All of these must resolve to `termdeck`, not basename of the subdir.
  assert.equal(resolveProjectName(`${TERMDECK_CWD}/packages/server`, TERMDECK_CONFIG), 'termdeck');
  assert.equal(resolveProjectName(`${TERMDECK_CWD}/packages/cli/src`, TERMDECK_CONFIG), 'termdeck');
});

test('resolveProjectName: TermDeck cwd does NOT resolve to chopin-nashville', () => {
  // The exact regression. The chopin-nashville name does not appear in
  // TERMDECK_CONFIG at all — it can only be produced if the resolver
  // walks ancestors and emits a path segment as the project name.
  const result = resolveProjectName(TERMDECK_CWD, TERMDECK_CONFIG);
  assert.equal(result, 'termdeck');
  assert.notEqual(result, 'chopin-nashville');
  assert.notEqual(result, 'ChopinNashville');
  assert.notEqual(result, 'SideHustles');
  assert.notEqual(result, 'TermDeck');
});

test('resolveProjectName: sibling path with shared prefix does NOT cross-match', () => {
  // path.sep boundary guard: /a/b must not match /a/bb. If startsWith were
  // used without the sep, /a/bb would land on the /a/b project. This pins
  // the boundary check.
  const config = {
    projects: {
      foo: { path: '/a/b' },
    },
  };
  assert.equal(resolveProjectName('/a/bb', config), 'bb');
  assert.notEqual(resolveProjectName('/a/bb', config), 'foo');
});

test('resolveProjectName: missing config falls back to basename', () => {
  assert.equal(resolveProjectName('/some/random/path/myproject', null), 'myproject');
  assert.equal(resolveProjectName('/some/random/path/myproject', {}), 'myproject');
  assert.equal(resolveProjectName('/some/random/path/myproject', { projects: {} }), 'myproject');
});

test('resolveProjectName: empty cwd returns null', () => {
  assert.equal(resolveProjectName(null, TERMDECK_CONFIG), null);
  assert.equal(resolveProjectName(undefined, TERMDECK_CONFIG), null);
  assert.equal(resolveProjectName('', TERMDECK_CONFIG), null);
});

test('resolveProjectName: tilde-prefixed paths in config resolve correctly', () => {
  const config = {
    projects: {
      termdeck: { path: '~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck' },
    },
  };
  assert.equal(resolveProjectName(TERMDECK_CWD, config), 'termdeck');
});

test('resolveProjectName: tilde-prefixed cwd resolves correctly', () => {
  // session.meta.cwd may carry a literal ~ if a CLI shorthand seeds it.
  const result = resolveProjectName('~/Documents/Graciella/engram', TERMDECK_CONFIG);
  assert.equal(result, 'engram');
});

test('resolveProjectName: ChopinInBohemia ancestor does NOT capture podium subdir as wrong project', () => {
  // The harness hook collapses both ChopinNashville AND ChopinInBohemia to
  // chopin-nashville. resolveProjectName should keep them distinct: a podium
  // cwd resolves to `podium`, not anything else.
  const podium = '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/2026/ChopinInBohemia/podium';
  assert.equal(resolveProjectName(podium, TERMDECK_CONFIG), 'podium');
});

test('_projectFor: explicit session.meta.project beats cwd resolution', () => {
  const rag = new RAGIntegration({ rag: { enabled: false } }, null);
  rag.config = TERMDECK_CONFIG;
  const session = { id: 'test', meta: { project: 'override-name', cwd: TERMDECK_CWD } };
  // Even though cwd resolves to `termdeck`, the explicit project tag wins.
  assert.equal(rag._projectFor(session), 'override-name');
});

test('_projectFor: empty session.meta.project falls through to cwd resolution', () => {
  const rag = new RAGIntegration({ rag: { enabled: false } }, null);
  rag.config = TERMDECK_CONFIG;
  const session = { id: 'test', meta: { project: null, cwd: TERMDECK_CWD } };
  assert.equal(rag._projectFor(session), 'termdeck');
});

test('_resolveProjectAttribution: source field surfaces resolution path for audit', () => {
  const rag = new RAGIntegration({ rag: { enabled: false } }, null);
  rag.config = TERMDECK_CONFIG;

  // explicit
  const sExplicit = { id: 't1', meta: { project: 'engram', cwd: TERMDECK_CWD } };
  assert.deepEqual(rag._resolveProjectAttribution(sExplicit), { tag: 'engram', source: 'explicit' });

  // cwd matches a config.projects entry
  const sCwd = { id: 't2', meta: { project: null, cwd: TERMDECK_CWD } };
  assert.deepEqual(rag._resolveProjectAttribution(sCwd), { tag: 'termdeck', source: 'cwd' });

  // cwd unmapped → basename fallback
  const sFallback = { id: 't3', meta: { project: null, cwd: '/tmp/random/myrepo' } };
  assert.deepEqual(rag._resolveProjectAttribution(sFallback), { tag: 'myrepo', source: 'fallback' });

  // no cwd, no project
  const sNone = { id: 't4', meta: { project: null, cwd: null } };
  assert.deepEqual(rag._resolveProjectAttribution(sNone), { tag: null, source: 'none' });
});
