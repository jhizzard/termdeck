// Sprint 49 T4 — unit tests for the auto-wire-on-launch helpers added to
// packages/stack-installer/src/launcher.js. These tests exercise the dispatch
// logic in `_autowireMcp` directly so the behavior is covered without faking
// the package-resolution walk in `_loadTermdeckExports` or the `ensureMnestraBlock`
// helper itself (those have their own coverage in tests/mcp-autowire.test.js
// and the live integration smoke at sprint close).
//
// Run: node --test packages/stack-installer/tests/launcher-autowire.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const launcher = require('../src/launcher');

// ─── _autowireMcp dispatch ─────────────────────────────────────────────

test('_autowireMcp calls ensureMnestraBlock once per non-null-mcpConfig adapter', () => {
  const calls = [];
  const ensureFn = (adapter, opts) => {
    calls.push({ name: adapter.name, opts });
    return { wrote: true, path: '/fake', bytes: 100 };
  };
  const adapters = {
    claude: { name: 'claude', mcpConfig: null },
    codex: { name: 'codex', mcpConfig: { path: '~/.codex/config.toml', format: 'toml' } },
    gemini: { name: 'gemini', mcpConfig: { path: '~/.gemini/settings.json', format: 'json' } },
    grok: { name: 'grok', mcpConfig: { path: '~/.grok/user-settings.json', format: 'json' } },
  };
  const result = launcher._autowireMcp(adapters, ensureFn, { secrets: { SUPABASE_URL: 'x' } });
  assert.equal(calls.length, 3, 'ensureMnestraBlock invoked exactly 3 times (codex/gemini/grok)');
  assert.deepEqual(calls.map((c) => c.name).sort(), ['codex', 'gemini', 'grok']);
  // opts threads through to each call
  assert.equal(calls[0].opts.secrets.SUPABASE_URL, 'x');
  assert.deepEqual(result.wired.sort(), ['codex', 'gemini', 'grok']);
  // claude lands in `skipped` (its mcpConfig is null — Claude is user-managed)
  assert.ok(result.skipped.includes('claude'));
});

test('_autowireMcp never invokes the helper for the Claude adapter (mcpConfig: null)', () => {
  const calls = [];
  const ensureFn = (adapter) => { calls.push(adapter.name); return { wrote: true }; };
  const adapters = { claude: { name: 'claude', mcpConfig: null } };
  const result = launcher._autowireMcp(adapters, ensureFn);
  assert.equal(calls.length, 0, 'Claude must never be passed to ensureMnestraBlock');
  assert.deepEqual(result.skipped, ['claude']);
  assert.deepEqual(result.wired, []);
  assert.deepEqual(result.unchanged, []);
  assert.deepEqual(result.errored, []);
});

test('_autowireMcp aggregates wired/unchanged/skipped outcomes from helper return shapes', () => {
  const ensureFn = (adapter) => {
    if (adapter.name === 'codex') return { wrote: true, path: '/fake/codex', bytes: 50 };
    if (adapter.name === 'gemini') return { unchanged: true, path: '/fake/gemini' };
    return { skipped: true, reason: 'malformed-mcpConfig' };
  };
  const adapters = {
    codex: { name: 'codex', mcpConfig: { path: 'a', format: 'toml' } },
    gemini: { name: 'gemini', mcpConfig: { path: 'b', format: 'json' } },
    grok: { name: 'grok', mcpConfig: { path: 'c', format: 'json' } },
  };
  const result = launcher._autowireMcp(adapters, ensureFn);
  assert.deepEqual(result.wired, ['codex']);
  assert.deepEqual(result.unchanged, ['gemini']);
  assert.deepEqual(result.skipped, ['grok']);
  // Idempotency proxy: if every adapter returns `unchanged` next call, all
  // shift from wired → unchanged.
  const unchangedFn = () => ({ unchanged: true, path: '/fake' });
  const second = launcher._autowireMcp(adapters, unchangedFn);
  assert.deepEqual(second.wired, []);
  assert.deepEqual(second.unchanged.sort(), ['codex', 'gemini', 'grok']);
});

test('_autowireMcp catches helper exceptions per-adapter so the launcher continues', () => {
  const ensureFn = (adapter) => {
    if (adapter.name === 'codex') throw new Error('disk full');
    return { wrote: true };
  };
  const adapters = {
    codex: { name: 'codex', mcpConfig: { path: 'a', format: 'toml' } },
    gemini: { name: 'gemini', mcpConfig: { path: 'b', format: 'json' } },
  };
  const result = launcher._autowireMcp(adapters, ensureFn);
  assert.equal(result.errored.length, 1);
  assert.equal(result.errored[0].name, 'codex');
  assert.match(result.errored[0].error, /disk full/);
  // Subsequent adapter still processed — error didn't kill the loop.
  assert.deepEqual(result.wired, ['gemini']);
});

test('_autowireMcp accepts both record-shape and array-shape adapter inputs', () => {
  const ensureFn = () => ({ wrote: true });
  const recordResult = launcher._autowireMcp(
    { codex: { name: 'codex', mcpConfig: { path: 'a' } } },
    ensureFn,
  );
  const arrayResult = launcher._autowireMcp(
    [{ name: 'codex', mcpConfig: { path: 'a' } }],
    ensureFn,
  );
  assert.deepEqual(recordResult.wired, ['codex']);
  assert.deepEqual(arrayResult.wired, ['codex']);
  // Tolerates falsy inputs.
  assert.deepEqual(launcher._autowireMcp(null, ensureFn).wired, []);
  assert.deepEqual(launcher._autowireMcp({}, ensureFn).wired, []);
  // Tolerates a non-function helper (returns an empty summary, no throw).
  assert.deepEqual(launcher._autowireMcp(recordResult, null).wired, []);
});

// ─── _autowireMcp + _loadTermdeckExports surface contract ──────────────

test('_autowireMcp and _loadTermdeckExports are exported as functions', () => {
  // Acceptance criterion #1 from T4 brief.
  assert.equal(typeof launcher._autowireMcp, 'function');
  assert.equal(typeof launcher._loadTermdeckExports, 'function');
});

test('_loadTermdeckExports returns null when the binary path resolves to an unrelated tree', () => {
  // Without a real @jhizzard/termdeck install rooted at the realpath of this
  // process's argv[0], the walk should give up cleanly rather than throwing.
  // We use the test runner binary as a path that definitely is NOT inside
  // an @jhizzard/termdeck tree.
  const result = launcher._loadTermdeckExports(process.execPath);
  assert.equal(result, null);
});

test('_loadTermdeckExports returns null for null/undefined/missing-file inputs', () => {
  assert.equal(launcher._loadTermdeckExports(null), null);
  assert.equal(launcher._loadTermdeckExports(undefined), null);
  // Missing-file path: realpathSync throws → caught → null.
  assert.equal(launcher._loadTermdeckExports('/definitely/not/a/real/path/termdeck'), null);
});
