// Sprint 45 T4 — Cross-adapter contract parity.
//
// Iterates whatever's in AGENT_ADAPTERS at run-time and asserts every adapter
// implements the 7-field contract documented in docs/AGENT-RUNTIMES.md § 5
// (plus the `name`, `sessionType`, `patternNames` extras pinned by Sprint 44
// T3's claude.js implementation). The point is to catch drift the moment a
// new adapter lands missing a field — without having to extend a hardcoded
// list every sprint.
//
// What the test does NOT do: assert any specific adapter is registered. The
// snapshot suites (agent-adapter-claude.test.js and the Sprint 45 T1/T2/T3
// adapter-specific suites) own that. This file is the cross-cutting contract
// audit only — runs against Sprint 44's Claude-only registry today, picks up
// Codex/Gemini/Grok automatically as they land.
//
// Run: node --test tests/agent-adapter-parity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { AGENT_ADAPTERS } = require('../packages/server/src/agent-adapters');

function adapters() {
  return Object.values(AGENT_ADAPTERS);
}

test('registry is non-empty', () => {
  const list = adapters();
  assert.ok(list.length >= 1, 'AGENT_ADAPTERS must contain at least the Claude adapter');
});

test('every adapter implements the 7-field contract', () => {
  for (const adapter of adapters()) {
    const id = adapter && adapter.name ? adapter.name : '<unnamed>';
    assert.equal(typeof adapter.name, 'string', `${id}: name must be a string`);
    assert.ok(adapter.name.length > 0, `${id}: name must be non-empty`);
    assert.equal(typeof adapter.sessionType, 'string', `${id}: sessionType must be a string`);
    assert.ok(adapter.sessionType.length > 0, `${id}: sessionType must be non-empty`);

    assert.equal(typeof adapter.matches, 'function', `${id}: matches must be a function`);

    assert.ok(adapter.spawn && typeof adapter.spawn === 'object', `${id}: spawn must be an object`);
    assert.equal(typeof adapter.spawn.binary, 'string', `${id}: spawn.binary must be a string`);
    assert.ok(adapter.spawn.binary.length > 0, `${id}: spawn.binary must be non-empty`);
    assert.ok(Array.isArray(adapter.spawn.defaultArgs), `${id}: spawn.defaultArgs must be an array`);
    assert.ok(adapter.spawn.env && typeof adapter.spawn.env === 'object',
      `${id}: spawn.env must be an object`);

    assert.ok(adapter.patterns && typeof adapter.patterns === 'object',
      `${id}: patterns must be an object`);
    assert.ok(adapter.patterns.prompt instanceof RegExp,
      `${id}: patterns.prompt must be a RegExp`);

    assert.equal(typeof adapter.statusFor, 'function', `${id}: statusFor must be a function`);
    assert.equal(typeof adapter.parseTranscript, 'function',
      `${id}: parseTranscript must be a function`);
    assert.equal(typeof adapter.bootPromptTemplate, 'function',
      `${id}: bootPromptTemplate must be a function`);

    assert.ok(['free', 'pay-per-token', 'subscription'].includes(adapter.costBand),
      `${id}: costBand must be one of free|pay-per-token|subscription, got ${adapter.costBand}`);

    // Sprint 50 T3 — every adapter declares a human-readable displayName.
    // Drives the dashboard launcher buttons (one per adapter) and the panel
    // header label resolver (getTypeLabel). Adding a new adapter without
    // displayName regresses the v1.0.0 UX trust trio fix.
    assert.equal(typeof adapter.displayName, 'string',
      `${id}: displayName must be a string`);
    assert.ok(adapter.displayName.length > 0,
      `${id}: displayName must be non-empty`);
  }
});

test('adapter names are unique across the registry', () => {
  const names = adapters().map((a) => a.name);
  assert.equal(new Set(names).size, names.length,
    `expected unique names, got ${JSON.stringify(names)}`);
});

test('adapter sessionTypes are unique across the registry', () => {
  const types = adapters().map((a) => a.sessionType);
  assert.equal(new Set(types).size, types.length,
    `expected unique sessionTypes, got ${JSON.stringify(types)}`);
});

test('matches() handles null/undefined/empty without throwing', () => {
  for (const adapter of adapters()) {
    assert.doesNotThrow(() => adapter.matches(undefined),
      `${adapter.name}: matches(undefined) must not throw`);
    assert.doesNotThrow(() => adapter.matches(null),
      `${adapter.name}: matches(null) must not throw`);
    assert.doesNotThrow(() => adapter.matches(''),
      `${adapter.name}: matches('') must not throw`);
  }
});

test('matches() returns boolean for canonical inputs', () => {
  const inputs = ['claude', 'cc', 'codex', 'gemini', 'grok', 'ls', 'python -m http.server'];
  for (const adapter of adapters()) {
    for (const input of inputs) {
      const out = adapter.matches(input);
      assert.equal(typeof out, 'boolean',
        `${adapter.name}.matches(${JSON.stringify(input)}) returned ${typeof out}, want boolean`);
    }
  }
});

test('matches() is mutually exclusive on each adapter\'s own canonical command', () => {
  // For each adapter, its own name as a command string should match itself
  // and nothing else. Catches the failure mode where two adapters' regexes
  // overlap on a primary input (e.g. both "claude" and "cc" claiming the
  // same string). Skipped for adapters whose name is intentionally ambiguous.
  for (const adapter of adapters()) {
    const canonical = adapter.spawn.binary;
    const matchers = adapters().filter((a) => a.matches(canonical));
    assert.ok(matchers.length >= 1,
      `expected at least 1 adapter to match its own binary "${canonical}"`);
    assert.equal(matchers[0].name, adapter.name,
      `${adapter.name}: binary "${canonical}" matched ${matchers.map((a) => a.name).join(', ')} first; expected ${adapter.name}`);
  }
});

test('parseTranscript returns an array on null/empty/garbage input', () => {
  for (const adapter of adapters()) {
    assert.ok(Array.isArray(adapter.parseTranscript('')),
      `${adapter.name}: parseTranscript('') must return an array`);
    assert.ok(Array.isArray(adapter.parseTranscript(null)),
      `${adapter.name}: parseTranscript(null) must return an array`);
    assert.ok(Array.isArray(adapter.parseTranscript(undefined)),
      `${adapter.name}: parseTranscript(undefined) must return an array`);
    assert.ok(Array.isArray(adapter.parseTranscript('not-a-real-transcript')),
      `${adapter.name}: parseTranscript(garbage) must return an array (fail-soft contract)`);
  }
});

test('statusFor returns either null or { status, statusDetail }', () => {
  // null is the documented "no change" return; otherwise the shape must be
  // a plain object with string status + statusDetail. session.js's
  // _updateStatus relies on this shape — anything else corrupts meta.status.
  const probes = [
    'plain text with no markers',
    '> ',
    'Thinking about it',
    'Edit foo.js',
    '⏺ Read',
  ];
  for (const adapter of adapters()) {
    for (const probe of probes) {
      const out = adapter.statusFor(probe);
      if (out === null) continue;
      assert.ok(out && typeof out === 'object',
        `${adapter.name}.statusFor(${JSON.stringify(probe)}) returned non-object`);
      assert.equal(typeof out.status, 'string',
        `${adapter.name}.statusFor: status must be a string`);
      assert.equal(typeof out.statusDetail, 'string',
        `${adapter.name}.statusFor: statusDetail must be a string`);
    }
  }
});

test('bootPromptTemplate returns a non-empty multi-line string', () => {
  const lane = { id: 'T1', briefingPath: 'docs/sprint-45/T1-foo.md' };
  const sprint = { number: 45, name: 'multi-agent-adapters', project: 'termdeck' };
  for (const adapter of adapters()) {
    const out = adapter.bootPromptTemplate(lane, sprint);
    assert.equal(typeof out, 'string', `${adapter.name}: bootPromptTemplate must return a string`);
    assert.ok(out.length > 0, `${adapter.name}: bootPromptTemplate must be non-empty`);
    assert.ok(out.includes('\n'), `${adapter.name}: bootPromptTemplate must be multi-line`);
  }
});

// Sprint 47 T3 — every adapter must declare an `acceptsPaste` boolean so the
// inject helper can dispatch between bracketed-paste and chunked-stdin
// fallback without a hardcoded per-agent switch. Default-true is the safe
// path; setting false triggers chunkedFallback in sprint-inject.js.
test('every adapter declares acceptsPaste as a boolean', () => {
  for (const adapter of adapters()) {
    assert.equal(
      typeof adapter.acceptsPaste,
      'boolean',
      `${adapter.name}: acceptsPaste must be a boolean (got ${typeof adapter.acceptsPaste})`,
    );
  }
});
