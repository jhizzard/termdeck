// Sprint 46 T4 — Client-side launcher resolver contract test.
//
// Pins the routing decisions of packages/client/public/launcher-resolver.js
// (the function the dashboard's launchTerminal() calls to translate a typed
// command + selected project + agent-adapter registry into the spawn
// parameters POSTed to /api/sessions). Pre-Sprint-46 there was zero test
// coverage for this resolver — the Sprint 45 T4 refactor that introduced
// registry-driven adapter matching shipped with only server-side adapter
// contract tests. This file closes that gap.
//
// Run: node --test tests/launcher-resolver.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolve } = require('../packages/client/public/launcher-resolver');

// Fixed adapter snapshot mirroring Sprint 45's GET /api/agent-adapters
// response. Test stays stable as long as the registry shape stays stable.
const ADAPTERS = [
  { name: 'claude', sessionType: 'claude-code', binary: 'claude', costBand: 'pay-per-token' },
  { name: 'codex', sessionType: 'codex', binary: 'codex', costBand: 'pay-per-token' },
  { name: 'gemini', sessionType: 'gemini', binary: 'gemini', costBand: 'pay-per-token' },
  { name: 'grok', sessionType: 'grok', binary: 'grok', costBand: 'subscription' },
];

const PROJECTS = {
  termdeck: { path: '/Users/x/termdeck' },
  mnestra: { path: '/Users/x/mnestra' },
};

// ── Quick-launch buttons (topbar mini-buttons + empty-state tiles) ──

test('quick-launch shell: zsh resolves to type=shell', () => {
  const r = resolve('zsh', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'shell');
  assert.equal(r.resolvedCommand, 'zsh');
});

test('quick-launch claude: claude resolves to claude-code', () => {
  const r = resolve('claude', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'claude-code');
  assert.equal(r.resolvedCommand, 'claude');
  assert.equal(r.resolvedCwd, undefined);
  assert.equal(r.resolvedProject, undefined);
});

test('quick-launch python: python3 -m http.server 8080 resolves to python-server (Sprint 46 T4 fix)', () => {
  const r = resolve('python3 -m http.server 8080', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'python-server');
  assert.equal(r.resolvedCommand, 'python3 -m http.server 8080');
});

// ── Free-form launcher: each agent adapter ──

test('free-form claude: routes via /^claude\\b/i', () => {
  assert.equal(resolve('claude', undefined, ADAPTERS, PROJECTS).resolvedType, 'claude-code');
  assert.equal(resolve('Claude', undefined, ADAPTERS, PROJECTS).resolvedType, 'claude-code');
});

test('free-form codex: routes to codex sessionType', () => {
  const r = resolve('codex --resume', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'codex');
  assert.equal(r.resolvedCommand, 'codex --resume');
});

test('free-form gemini: routes to gemini sessionType', () => {
  const r = resolve('gemini -p "say hi"', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'gemini');
  assert.equal(r.resolvedCommand, 'gemini -p "say hi"');
});

test('free-form grok: routes to grok sessionType', () => {
  const r = resolve('grok', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'grok');
});

// ── `cc` shorthand (claude alias) ──

test('cc shorthand: normalizes to claude', () => {
  const r = resolve('cc', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'claude-code');
  assert.equal(r.resolvedCommand, 'claude');
});

test('cc code <project>: shorthand still resolves project', () => {
  const r = resolve('cc code mnestra', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'claude-code');
  assert.equal(r.resolvedProject, 'mnestra');
  assert.equal(r.resolvedCwd, undefined);
});

test('cc code <path>: shorthand still resolves cwd', () => {
  const r = resolve('cc code ~/scheduling', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'claude-code');
  assert.equal(r.resolvedCwd, '~/scheduling');
  assert.equal(r.resolvedProject, undefined);
});

// ── Claude arg parsing: project name vs filesystem path ──

test('claude code <known-project>: routes to resolvedProject', () => {
  const r = resolve('claude code termdeck', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedProject, 'termdeck');
  assert.equal(r.resolvedCwd, undefined);
  assert.equal(r.resolvedCommand, 'claude');
});

test('claude code <unknown-arg>: routes to resolvedCwd', () => {
  const r = resolve('claude code ~/some-path', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedCwd, '~/some-path');
  assert.equal(r.resolvedProject, undefined);
});

test('claude <known-project> (no `code` keyword): also resolves project', () => {
  const r = resolve('claude mnestra', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedProject, 'mnestra');
});

// ── Word-boundary semantics ──
//
// `^${binary}\b` is intentionally loose: it accepts hyphenated wrapper
// names like `claude-experimental` so that drop-in CLI replacements still
// route through the right adapter, but it rejects "stuck" suffixes like
// `claudette` where there is no word boundary. The two tests below pin
// each branch so a future tightening (e.g. `^${binary}(?:$|\\s)`) is an
// explicit, reviewed decision rather than a silent regression.

test('claudette does NOT match claude (no word boundary between e and t)', () => {
  const r = resolve('claudette', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'shell');
});

test('hyphenated wrapper names DO match (codex-mock → codex; intentional)', () => {
  const r = resolve('codex-mock', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'codex');
});

// ── Bare commands fall to shell ──

test('vim falls to shell', () => {
  const r = resolve('vim file.txt', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'shell');
  assert.equal(r.resolvedCommand, 'vim file.txt');
});

test('ls falls to shell', () => {
  assert.equal(resolve('ls -la', undefined, ADAPTERS, PROJECTS).resolvedType, 'shell');
});

test('npm run dev falls to shell', () => {
  assert.equal(resolve('npm run dev', undefined, ADAPTERS, PROJECTS).resolvedType, 'shell');
});

// ── python-server detection (extended Sprint 46 T4) ──

test('python-server: runserver / uvicorn / flask / gunicorn / http.server all detected', () => {
  for (const cmd of [
    'python manage.py runserver',
    'python -m uvicorn app:foo',
    'python3 -m flask run',
    'python -m gunicorn app:wsgi',
    'python3 -m http.server 8080',
    'python -m http.server',
  ]) {
    const r = resolve(cmd, undefined, ADAPTERS, PROJECTS);
    assert.equal(r.resolvedType, 'python-server', `expected python-server for ${cmd}`);
  }
});

test('python with non-server module: stays shell', () => {
  const r = resolve('python -c "print(1)"', undefined, ADAPTERS, PROJECTS);
  assert.equal(r.resolvedType, 'shell');
});

// ── Project dropdown selection passes through ──

test('project arg passes through unchanged when no command-level override', () => {
  const r = resolve('zsh', 'termdeck', ADAPTERS, PROJECTS);
  assert.equal(r.resolvedProject, 'termdeck');
});

test('claude code <known-project> overrides explicit project arg', () => {
  // The launcher's claude shorthand wins over the dropdown when both
  // are present — matches the pre-extraction inline behavior.
  const r = resolve('claude code mnestra', 'termdeck', ADAPTERS, PROJECTS);
  assert.equal(r.resolvedProject, 'mnestra');
});

// ── Defensive: missing/empty inputs ──

test('empty agentAdapters list falls through gracefully', () => {
  const r = resolve('claude', undefined, [], PROJECTS);
  assert.equal(r.resolvedType, 'shell');
  assert.equal(r.resolvedCommand, 'claude');
});

test('null agentAdapters falls through gracefully', () => {
  const r = resolve('claude', undefined, null, PROJECTS);
  assert.equal(r.resolvedType, 'shell');
});

test('null projects map handled in claude shorthand', () => {
  const r = resolve('claude code ~/foo', undefined, ADAPTERS, null);
  assert.equal(r.resolvedCwd, '~/foo');
  assert.equal(r.resolvedProject, undefined);
});

test('undefined projects map handled in claude shorthand', () => {
  const r = resolve('claude code ~/foo', undefined, ADAPTERS, undefined);
  assert.equal(r.resolvedCwd, '~/foo');
});
