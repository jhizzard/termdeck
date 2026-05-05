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

// Sprint 44 T3 retained `PATTERNS.claudeCode.*` and `PATTERNS.errorLineStart`
// as a one-release shim into the Claude adapter; Sprint 45 T4 removed it.
// This test now asserts the shim is GONE — i.e. PATTERNS no longer leaks
// claude-specific keys, and the only path to those regexes is through
// `claudeAdapter.patterns.*`. If a future change re-introduces a shim,
// this assertion fires.
test('Sprint 45 T4: PATTERNS no longer exposes claudeCode or errorLineStart shim entries', () => {
  assert.equal(PATTERNS.claudeCode, undefined,
    'PATTERNS.claudeCode shim should be removed in Sprint 45 T4 — read claudeAdapter.patterns directly');
  assert.equal(PATTERNS.errorLineStart, undefined,
    'PATTERNS.errorLineStart shim should be removed in Sprint 45 T4 — read claudeAdapter.patterns.error directly');
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
// Sprint 57 T1 / F-T2-3 — `errorLineStart` pattern tightening.
//
// The pre-Sprint-57 pattern matched line-start prose like
// "Error handling docs" (the F-T2-3 finding from Sprint 55 T2 + T4 audit:
// 196 fires / 22 dismissed (11%) on the daily-driver project, mostly from
// boot-prompt content + markdown headings tripping the bare `Error\b`
// keyword arm). Tightening requires prose-shape keywords to be followed
// by `:` + content; structural shapes (Traceback, npm ERR!,
// `error[Ennn]:`, `failed with exit code <digit>`) still match without
// the colon because the structure already disambiguates real errors.
//
// These fixtures pin both directions — the false-positive class that must
// NO LONGER fire, and the true-positive class that must STILL fire.
// ─────────────────────────────────────────────────────────────────────────

const ERROR_LINE_FALSE_POSITIVES = [
  ['markdown heading-style label',         'Error handling docs'],
  ['docs prose section',                   'Error handling pattern'],
  ['lowercase prose',                      'error tracking is in src/'],
  ['boot-prompt-style line w/ word Error', 'Error path tested by tests/x.test.js'],
  ['exception keyword without colon',      'Exception thrown at line 42 was rethrown'],
  ['fatal keyword without colon',          'Fatal flaw in logic was discussed'],
  ['ENOENT mentioned without colon',       'ENOENT was the ultimate cause yesterday'],
  ['command-not-found prose',              'command not found case is rare'],
  ['No such file prose',                   'No such file or directory shapes vary'],
  ['Permission denied prose',              'Permission denied phrasing differs by shell'],
  ['segmentation fault prose',             'segmentation fault rates dropped after fix'],
  ['failed with exit code (no digit)',     'failed with exit code last time we tried'],
  ['ErrorBoundary component name',         'ErrorBoundary component name'],
];

const ERROR_LINE_TRUE_POSITIVES = [
  ['Error: prose colon shape',                 'Error: connection refused'],
  ['lowercase error: shape',                   'error: command failed with code 1'],
  ['ERROR: uppercase shape',                   'ERROR: out of memory'],
  ['Exception: shape',                         'Exception: caught at frame 0'],
  ['Fatal: git-style',                         'Fatal: not a git repository'],
  ['ENOENT: errno colon shape',                'ENOENT: no such file or directory'],
  ['EACCES: errno colon shape',                'EACCES: permission denied'],
  ['ECONNREFUSED: errno colon shape',          'ECONNREFUSED: connection refused on :5432'],
  ['Go-style panic',                           'panic: runtime error: invalid memory address'],
  ['Traceback header',                         'Traceback (most recent call last):'],
  ['npm ERR! tag',                             'npm ERR! code ERESOLVE'],
  ['Rust borrow-checker error code',           'error[E0382]: borrow of moved value'],
  ['failed with exit code N (CI marker)',      'failed with exit code 1'],
  ['leading whitespace + Error: still fires',  '    Error: indented but real'],
];

test('Sprint 57 T1: tightened ERROR pattern rejects line-start prose without colon (F-T2-3)', () => {
  for (const [name, fixture] of ERROR_LINE_FALSE_POSITIVES) {
    assert.equal(
      claudeAdapter.patterns.error.test(fixture),
      false,
      `expected NO match for ${name}: ${JSON.stringify(fixture)}`,
    );
  }
});

test('Sprint 57 T1: tightened ERROR pattern still fires on real error shapes', () => {
  for (const [name, fixture] of ERROR_LINE_TRUE_POSITIVES) {
    assert.equal(
      claudeAdapter.patterns.error.test(fixture),
      true,
      `expected MATCH for ${name}: ${JSON.stringify(fixture)}`,
    );
  }
});

test('Sprint 57 T1: Session._detectErrors no longer flips claude-code to errored on "Error handling docs"', () => {
  // End-to-end wiring assertion that mirrors the Sprint 55 T2 + T4
  // observation: a Claude Code panel echoing prose with "Error" at line
  // start (markdown heading, lane-brief paste, doc snippet) must NOT trip
  // the analyzer. The pre-Sprint-57 pattern fired here; the new pattern
  // does not. Confirms the false-positive class is closed at the wiring
  // level, not just the regex level.
  const s = new Session({ id: 'wire-57-1', type: 'claude-code' });
  s.analyzeOutput('Error handling docs are at packages/server/README.md');
  assert.notEqual(s.meta.status, 'errored');
});

test('Sprint 57 T1: Session._detectErrors still flips claude-code on real "Error: ..." line', () => {
  // Companion assertion: the wire-7 success case (Error: + content) MUST
  // continue to fire. This test exists alongside wire-7 to make the
  // before/after delta legible: tightening the false-positive class must
  // not regress the true-positive class.
  const s = new Session({ id: 'wire-57-2', type: 'claude-code' });
  s.analyzeOutput('Error: connection refused at db.connect()');
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
