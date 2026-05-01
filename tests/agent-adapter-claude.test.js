// Sprint 44 T3 — Snapshot tests for the Claude agent adapter.
//
// Pins the bit-for-bit-identical behavior contract that lets Sprint 44 ship
// the adapter registry without changing what `Session` does on Claude Code
// PTY output. Two surfaces are checked:
//
//   (1) The adapter contract itself — shape + regex identity + statusFor
//       output for the same inputs the legacy in-file switch handled.
//   (2) The session.js wiring after the refactor — `_detectType`,
//       `_updateStatus`, and `_detectErrors` produce the same observable
//       outputs (meta.type, meta.status, meta.statusDetail, the
//       onErrorDetected callback firing) as the pre-Sprint-44 code path.
//
// If any of these tests fail, the adapter has drifted from the legacy
// behavior and the migration is no longer transparent — DO NOT loosen the
// assertions to make them pass; fix the adapter or session.js instead.
//
// Run: node --test tests/agent-adapter-claude.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const claudeAdapter = require('../packages/server/src/agent-adapters/claude');
const { AGENT_ADAPTERS, getAdapterForSessionType, detectAdapter }
  = require('../packages/server/src/agent-adapters');
const { Session, PATTERNS } = require('../packages/server/src/session');

// ─────────────────────────────────────────────────────────────────────────
// Adapter contract — every field documented in memorialization § 4 must be
// present and have the right shape. Missing fields would silently degrade
// the registry path back to legacy detection.
// ─────────────────────────────────────────────────────────────────────────

test('Claude adapter exposes the full contract shape', () => {
  assert.equal(claudeAdapter.name, 'claude');
  assert.equal(claudeAdapter.sessionType, 'claude-code');
  assert.equal(typeof claudeAdapter.matches, 'function');
  assert.ok(claudeAdapter.spawn && typeof claudeAdapter.spawn === 'object');
  assert.equal(claudeAdapter.spawn.binary, 'claude');
  assert.ok(Array.isArray(claudeAdapter.spawn.defaultArgs));
  assert.ok(claudeAdapter.spawn.env && typeof claudeAdapter.spawn.env === 'object');
  assert.ok(claudeAdapter.patterns && typeof claudeAdapter.patterns === 'object');
  for (const key of ['prompt', 'thinking', 'editing', 'tool', 'idle', 'error']) {
    assert.ok(claudeAdapter.patterns[key] instanceof RegExp,
      `claude.patterns.${key} should be a RegExp`);
  }
  assert.equal(claudeAdapter.patternNames.error, 'errorLineStart',
    'patternNames.error pins the legacy diag label');
  assert.equal(typeof claudeAdapter.statusFor, 'function');
  assert.equal(typeof claudeAdapter.parseTranscript, 'function');
  assert.equal(typeof claudeAdapter.bootPromptTemplate, 'function');
  assert.ok(['free', 'pay-per-token', 'subscription'].includes(claudeAdapter.costBand));
});

test('AGENT_ADAPTERS registry exposes the Claude adapter under "claude"', () => {
  assert.equal(AGENT_ADAPTERS.claude, claudeAdapter);
  assert.equal(getAdapterForSessionType('claude-code'), claudeAdapter);
  assert.equal(getAdapterForSessionType('shell'), undefined);
  assert.equal(getAdapterForSessionType(null), undefined);
});

test('PATTERNS.claudeCode shim references the adapter regexes (no duplication)', () => {
  assert.equal(PATTERNS.claudeCode.prompt, claudeAdapter.patterns.prompt);
  assert.equal(PATTERNS.claudeCode.thinking, claudeAdapter.patterns.thinking);
  assert.equal(PATTERNS.claudeCode.editing, claudeAdapter.patterns.editing);
  assert.equal(PATTERNS.claudeCode.tool, claudeAdapter.patterns.tool);
  assert.equal(PATTERNS.claudeCode.idle, claudeAdapter.patterns.idle);
  assert.equal(PATTERNS.errorLineStart, claudeAdapter.patterns.error,
    'errorLineStart must be the same regex object the adapter uses for primary error detection');
});

// ─────────────────────────────────────────────────────────────────────────
// detectAdapter — used by session.js _detectType. Mirrors the original
// `PATTERNS.claudeCode.prompt.test(data) || /claude/i.test(command)` OR.
// ─────────────────────────────────────────────────────────────────────────

test('detectAdapter: matches by Claude prompt marker (❯)', () => {
  const adapter = detectAdapter('❯ ', '');
  assert.equal(adapter, claudeAdapter);
});

test('detectAdapter: matches by Claude prompt marker (>)', () => {
  const adapter = detectAdapter('> something', '');
  assert.equal(adapter, claudeAdapter);
});

test('detectAdapter: matches by command-string when no prompt yet', () => {
  const adapter = detectAdapter('starting up...', 'claude --resume');
  assert.equal(adapter, claudeAdapter);
});

test('detectAdapter: case-insensitive command match', () => {
  const adapter = detectAdapter('boot output', 'CLAUDE -p hello');
  assert.equal(adapter, claudeAdapter);
});

test('detectAdapter: returns undefined when neither data nor command match', () => {
  const adapter = detectAdapter('plain shell output', 'ls -la');
  assert.equal(adapter, undefined);
});

test('detectAdapter: tolerates undefined command without throwing', () => {
  const adapter = detectAdapter('hi', undefined);
  assert.equal(adapter, undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// statusFor — direct unit tests against the adapter, asserting the same
// status / statusDetail strings the old in-file switch produced.
// ─────────────────────────────────────────────────────────────────────────

test('statusFor: thinking phrase → "Claude is reasoning..."', () => {
  assert.deepEqual(claudeAdapter.statusFor('Thinking about the engram-bridge'), {
    status: 'thinking',
    statusDetail: 'Claude is reasoning...',
  });
});

test('statusFor: lowercase "thinking" matches too', () => {
  assert.deepEqual(claudeAdapter.statusFor('still thinking through this'), {
    status: 'thinking',
    statusDetail: 'Claude is reasoning...',
  });
});

test('statusFor: Edit verb → editing status with file path detail', () => {
  assert.deepEqual(claudeAdapter.statusFor('Edit packages/server/src/session.js'), {
    status: 'editing',
    statusDetail: 'Edit packages/server/src/session.js',
  });
});

test('statusFor: Update verb is recognized', () => {
  assert.deepEqual(claudeAdapter.statusFor('Update CHANGELOG.md'), {
    status: 'editing',
    statusDetail: 'Update CHANGELOG.md',
  });
});

test('statusFor: tool marker (⏺) → active "Using tools"', () => {
  assert.deepEqual(claudeAdapter.statusFor('⏺ Read'), {
    status: 'active',
    statusDetail: 'Using tools',
  });
});

test('statusFor: idle prompt (> alone) → idle "Waiting for input"', () => {
  assert.deepEqual(claudeAdapter.statusFor('> '), {
    status: 'idle',
    statusDetail: 'Waiting for input',
  });
});

test('statusFor: returns null when no claude pattern matches', () => {
  assert.equal(claudeAdapter.statusFor('plain shell text with no markers'), null);
});

test('statusFor: precedence — thinking wins over editing when both are present', () => {
  // Mirrors the legacy switch's `else if` cascade: thinking → editing → tool → idle.
  const out = claudeAdapter.statusFor('Thinking\nEdit foo.js');
  assert.equal(out.status, 'thinking');
});

// ─────────────────────────────────────────────────────────────────────────
// session.js wiring — same observable behavior post-refactor.
// ─────────────────────────────────────────────────────────────────────────

test('Session._detectType: ❯ prompt sets type=claude-code via registry path', () => {
  const s = new Session({ id: 'wire-1', type: 'shell' });
  s.analyzeOutput('❯ ');
  assert.equal(s.meta.type, 'claude-code');
});

test('Session._detectType: command-string Claude detection still works', () => {
  const s = new Session({ id: 'wire-2', type: 'shell', command: 'claude --resume' });
  s.analyzeOutput('starting up...');
  assert.equal(s.meta.type, 'claude-code');
});

test('Session._updateStatus: thinking pattern updates status + detail', () => {
  const s = new Session({ id: 'wire-3', type: 'claude-code' });
  s.analyzeOutput('Thinking about the bridge');
  assert.equal(s.meta.status, 'thinking');
  assert.equal(s.meta.statusDetail, 'Claude is reasoning...');
});

test('Session._updateStatus: editing pattern carries the verb + path through', () => {
  const s = new Session({ id: 'wire-4', type: 'claude-code' });
  s.analyzeOutput('Edit packages/server/src/session.js');
  assert.equal(s.meta.status, 'editing');
  assert.equal(s.meta.statusDetail, 'Edit packages/server/src/session.js');
});

test('Session._updateStatus: no claude pattern → status unchanged from "starting"', () => {
  const s = new Session({ id: 'wire-5', type: 'claude-code' });
  // Status starts as 'starting'; an output with no claude pattern should not
  // mutate it (this is the contract the legacy switch had — no fallthrough).
  s.analyzeOutput('plain output that mentions nothing claude-specific');
  assert.equal(s.meta.status, 'starting');
});

test('Session._detectErrors: claude-code uses errorLineStart variant (no mid-line "Error" false positive)', () => {
  const s = new Session({ id: 'wire-6', type: 'claude-code' });
  // Mid-line "Error" in tool output (e.g. a grep result) must NOT flip
  // status to 'errored' for claude-code sessions — that's why the adapter
  // exposes `patterns.error = errorLineStart` (line-anchored).
  s.analyzeOutput('  grep result: this line mentions Error in passing');
  assert.notEqual(s.meta.status, 'errored');
});

test('Session._detectErrors: claude-code line-anchored error DOES fire', () => {
  const s = new Session({ id: 'wire-7', type: 'claude-code' });
  s.analyzeOutput('Error: something actually broke at startup');
  assert.equal(s.meta.status, 'errored');
});

test('Session._detectErrors: non-claude session still uses generic PATTERNS.error', () => {
  const s = new Session({ id: 'wire-8', type: 'shell' });
  s.analyzeOutput('error: could not find symbol foo in bar.c');
  assert.equal(s.meta.status, 'errored');
});

// ─────────────────────────────────────────────────────────────────────────
// parseTranscript — Claude JSONL format, same cut-offs as the legacy
// memory-session-end.js helper this lifts from.
// ─────────────────────────────────────────────────────────────────────────

test('parseTranscript: extracts user + assistant string content', () => {
  const raw = [
    JSON.stringify({ message: { role: 'user', content: 'hello there' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'hi back' } }),
  ].join('\n');
  const out = claudeAdapter.parseTranscript(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: 'user', content: 'hello there' });
  assert.deepEqual(out[1], { role: 'assistant', content: 'hi back' });
});

test('parseTranscript: extracts assistant array-of-text-block content', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        { type: 'tool_use', name: 'Bash' },
        { type: 'text', text: 'second' },
      ],
    },
  });
  const out = claudeAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'first second');
});

test('parseTranscript: skips non-user/assistant roles (system, tool, etc.)', () => {
  const raw = [
    JSON.stringify({ message: { role: 'system', content: 'init' } }),
    JSON.stringify({ message: { role: 'user', content: 'q' } }),
    JSON.stringify({ message: { role: 'tool', content: 'output' } }),
  ].join('\n');
  const out = claudeAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

test('parseTranscript: tolerates malformed JSON lines (skips them, keeps going)', () => {
  const raw = [
    '{not valid json',
    JSON.stringify({ message: { role: 'user', content: 'survives' } }),
  ].join('\n');
  const out = claudeAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'survives');
});

test('parseTranscript: truncates each message to 400 chars', () => {
  const long = 'x'.repeat(500);
  const raw = JSON.stringify({ message: { role: 'user', content: long } });
  const out = claudeAdapter.parseTranscript(raw);
  assert.equal(out[0].content.length, 400);
});

test('parseTranscript: empty / non-string input returns []', () => {
  assert.deepEqual(claudeAdapter.parseTranscript(''), []);
  assert.deepEqual(claudeAdapter.parseTranscript(null), []);
  assert.deepEqual(claudeAdapter.parseTranscript(undefined), []);
});

// ─────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — placeholder contract; Sprint 46 refines.
// ─────────────────────────────────────────────────────────────────────────

test('bootPromptTemplate: produces a non-empty multi-line prompt with the lane id and sprint number', () => {
  const out = claudeAdapter.bootPromptTemplate(
    { id: 'T3', briefingPath: 'docs/sprint-44/T3-foo.md' },
    { number: 44, name: 'multi-agent-foundation' }
  );
  assert.ok(out.length > 0);
  assert.ok(out.includes('T3'));
  assert.ok(out.includes('44'));
  assert.ok(out.includes('memory_recall'));
  assert.ok(out.includes('STATUS.md'));
});
