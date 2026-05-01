// Sprint 45 T1 — Snapshot tests for the Codex agent adapter.
//
// Pins the contract shape, registry wiring, prompt/status pattern detection,
// and Codex JSONL transcript parsing for the Codex CLI panel path. Mirrors
// tests/agent-adapter-claude.test.js so the cross-adapter contract is uniform
// — Sprint 45 T4 will collapse the per-adapter parity checks into a single
// parametric suite (tests/agent-adapter-parity.test.js).
//
// If any of these tests fail, the adapter has drifted from what the launcher
// + analyzer + memory hook expect. Don't loosen assertions; fix the adapter.
//
// Run: node --test tests/agent-adapter-codex.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const codexAdapter = require('../packages/server/src/agent-adapters/codex');
const claudeAdapter = require('../packages/server/src/agent-adapters/claude');
const { AGENT_ADAPTERS, getAdapterForSessionType, detectAdapter }
  = require('../packages/server/src/agent-adapters');
const { Session } = require('../packages/server/src/session');

// ─────────────────────────────────────────────────────────────────────────
// Adapter contract
// ─────────────────────────────────────────────────────────────────────────

test('Codex adapter exposes the full contract shape', () => {
  assert.equal(codexAdapter.name, 'codex');
  assert.equal(codexAdapter.sessionType, 'codex');
  assert.equal(typeof codexAdapter.matches, 'function');
  assert.ok(codexAdapter.spawn && typeof codexAdapter.spawn === 'object');
  assert.equal(codexAdapter.spawn.binary, 'codex');
  assert.ok(Array.isArray(codexAdapter.spawn.defaultArgs));
  assert.ok(codexAdapter.spawn.env && typeof codexAdapter.spawn.env === 'object');
  assert.ok('OPENAI_API_KEY' in codexAdapter.spawn.env,
    'spawn.env documents the OPENAI_API_KEY dependency');
  assert.ok(codexAdapter.patterns && typeof codexAdapter.patterns === 'object');
  for (const key of ['prompt', 'thinking', 'editing', 'tool', 'idle', 'error']) {
    assert.ok(codexAdapter.patterns[key] instanceof RegExp,
      `codex.patterns.${key} should be a RegExp`);
  }
  assert.equal(codexAdapter.patternNames.error, 'codexErrorLineStart',
    'patternNames.error pins the codex-specific diag label');
  assert.equal(typeof codexAdapter.statusFor, 'function');
  assert.equal(typeof codexAdapter.parseTranscript, 'function');
  assert.equal(typeof codexAdapter.bootPromptTemplate, 'function');
  assert.equal(codexAdapter.costBand, 'pay-per-token');
});

test('AGENT_ADAPTERS registry exposes the Codex adapter under "codex"', () => {
  assert.equal(AGENT_ADAPTERS.codex, codexAdapter);
  assert.equal(getAdapterForSessionType('codex'), codexAdapter);
  // Claude is still registered and routed independently.
  assert.equal(AGENT_ADAPTERS.claude, claudeAdapter);
  assert.equal(getAdapterForSessionType('claude-code'), claudeAdapter);
});

test('Codex contract field set is identical to Claude (cross-adapter parity)', () => {
  // Sprint 45 T4 will collapse this into a parametric parity suite. Until
  // then, an explicit equality check between the two adapters' field sets
  // catches contract-shape drift early.
  const claudeKeys = Object.keys(claudeAdapter).sort();
  const codexKeys = Object.keys(codexAdapter).sort();
  assert.deepEqual(codexKeys, claudeKeys,
    `codex and claude adapter field sets should match — ${codexKeys.join(',')} vs ${claudeKeys.join(',')}`);
});

// ─────────────────────────────────────────────────────────────────────────
// detectAdapter — by command-string and by Codex prompt marker.
// ─────────────────────────────────────────────────────────────────────────

test('detectAdapter: matches by command-string "codex"', () => {
  const adapter = detectAdapter('starting up...', 'codex');
  assert.equal(adapter, codexAdapter);
});

test('detectAdapter: matches by command-string "codex --resume"', () => {
  const adapter = detectAdapter('booting', 'codex --resume');
  assert.equal(adapter, codexAdapter);
});

test('detectAdapter: case-insensitive Codex command match', () => {
  const adapter = detectAdapter('boot', 'CODEX -p hello');
  assert.equal(adapter, codexAdapter);
});

test('detectAdapter: matches by Codex prompt marker (codex>)', () => {
  const adapter = detectAdapter('codex> ', '');
  assert.equal(adapter, codexAdapter);
});

test('detectAdapter: matches by bare "codex" speaker line', () => {
  const adapter = detectAdapter('codex\n', '');
  assert.equal(adapter, codexAdapter);
});

test('detectAdapter: matches by codex-exec divider line', () => {
  const adapter = detectAdapter('--------\n', '');
  assert.equal(adapter, codexAdapter);
});

test('detectAdapter: claude command still resolves to Claude (registry order)', () => {
  // Claude is registered before codex; a `claude` command must NOT short-circuit
  // to codex even though codex.matches uses a /codex/i shape.
  const adapter = detectAdapter('booting up', 'claude --resume');
  assert.equal(adapter, claudeAdapter);
});

test('detectAdapter: Claude prompt marker (❯) does NOT resolve to codex', () => {
  // Mirrors the Claude test: ❯ is a Claude-specific prompt; codex must not
  // claim it just because codex's prompt regex doesn't exclude it.
  const adapter = detectAdapter('❯ ', '');
  assert.equal(adapter, claudeAdapter);
});

// ─────────────────────────────────────────────────────────────────────────
// statusFor — direct unit tests against the Codex cascade.
// ─────────────────────────────────────────────────────────────────────────

test('statusFor: thinking phrase → "Codex is reasoning..."', () => {
  assert.deepEqual(codexAdapter.statusFor('Thinking about the patch'), {
    status: 'thinking',
    statusDetail: 'Codex is reasoning...',
  });
});

test('statusFor: Reasoning is recognized as thinking', () => {
  assert.deepEqual(codexAdapter.statusFor('Reasoning over the diff'), {
    status: 'thinking',
    statusDetail: 'Codex is reasoning...',
  });
});

test('statusFor: Working is recognized as thinking', () => {
  assert.deepEqual(codexAdapter.statusFor('Working on tool loop'), {
    status: 'thinking',
    statusDetail: 'Codex is reasoning...',
  });
});

test('statusFor: Apply patch → editing with file path detail', () => {
  assert.deepEqual(codexAdapter.statusFor('Apply patch packages/server/src/index.js'), {
    status: 'editing',
    statusDetail: 'Apply patch packages/server/src/index.js',
  });
});

test('statusFor: Edit verb is recognized', () => {
  assert.deepEqual(codexAdapter.statusFor('Edit packages/server/src/session.js'), {
    status: 'editing',
    statusDetail: 'Edit packages/server/src/session.js',
  });
});

test('statusFor: tool marker ($ shell prefix) → active "Using tools"', () => {
  assert.deepEqual(codexAdapter.statusFor('$ ls -la'), {
    status: 'active',
    statusDetail: 'Using tools',
  });
});

test('statusFor: tool marker (→ arrow) → active "Using tools"', () => {
  assert.deepEqual(codexAdapter.statusFor('→ Read'), {
    status: 'active',
    statusDetail: 'Using tools',
  });
});

test('statusFor: exec keyword → active "Using tools"', () => {
  assert.deepEqual(codexAdapter.statusFor('exec_command call'), {
    status: 'active',
    statusDetail: 'Using tools',
  });
});

test('statusFor: idle (bare codex speaker line) → idle "Waiting for input"', () => {
  assert.deepEqual(codexAdapter.statusFor('codex\n'), {
    status: 'idle',
    statusDetail: 'Waiting for input',
  });
});

test('statusFor: returns null when no codex pattern matches', () => {
  assert.equal(codexAdapter.statusFor('plain shell text with no markers'), null);
});

test('statusFor: precedence — thinking wins over editing when both are present', () => {
  const out = codexAdapter.statusFor('Thinking\nApply patch foo.js');
  assert.equal(out.status, 'thinking');
});

test('statusFor: precedence — editing wins over tool', () => {
  const out = codexAdapter.statusFor('Apply patch foo.js\n$ ls');
  assert.equal(out.status, 'editing');
});

// ─────────────────────────────────────────────────────────────────────────
// session.js wiring — observable behavior with the Codex adapter routed
// through the same `_detectType` / `_updateStatus` / `_detectErrors` paths
// the Claude adapter uses.
// ─────────────────────────────────────────────────────────────────────────

test('Session._detectType: codex prompt sets type=codex via registry path', () => {
  const s = new Session({ id: 'codex-wire-1', type: 'shell' });
  s.analyzeOutput('codex> ');
  assert.equal(s.meta.type, 'codex');
});

test('Session._detectType: command-string codex detection still works', () => {
  const s = new Session({ id: 'codex-wire-2', type: 'shell', command: 'codex --resume' });
  s.analyzeOutput('starting up...');
  assert.equal(s.meta.type, 'codex');
});

test('Session._updateStatus: codex thinking pattern updates status + detail', () => {
  const s = new Session({ id: 'codex-wire-3', type: 'codex' });
  s.analyzeOutput('Thinking about the bridge');
  assert.equal(s.meta.status, 'thinking');
  assert.equal(s.meta.statusDetail, 'Codex is reasoning...');
});

test('Session._updateStatus: codex Apply patch carries through to editing detail', () => {
  const s = new Session({ id: 'codex-wire-4', type: 'codex' });
  s.analyzeOutput('Apply patch packages/server/src/agent-adapters/codex.js');
  assert.equal(s.meta.status, 'editing');
  assert.equal(s.meta.statusDetail, 'Apply patch packages/server/src/agent-adapters/codex.js');
});

test('Session._updateStatus: no codex pattern → status unchanged from "starting"', () => {
  const s = new Session({ id: 'codex-wire-5', type: 'codex' });
  s.analyzeOutput('plain output that mentions nothing codex-specific');
  assert.equal(s.meta.status, 'starting');
});

test('Session._detectErrors: codex line-anchored error fires', () => {
  const s = new Session({ id: 'codex-wire-6', type: 'codex' });
  s.analyzeOutput('Error: rate limit exceeded for model gpt-5.5');
  assert.equal(s.meta.status, 'errored');
});

test('Session._detectErrors: codex tool-output mid-line "Error" does NOT flip status', () => {
  // Codex's exec_command_end output frequently echoes test logs / grep results
  // that mention "Error" mid-line. The line-anchored adapter pattern must
  // skip these the same way Claude's errorLineStart skips them.
  const s = new Session({ id: 'codex-wire-7', type: 'codex' });
  s.analyzeOutput('  grep result: this line mentions Error in passing');
  assert.notEqual(s.meta.status, 'errored');
});

test('Session._detectErrors: codex 429 rate-limit shape fires', () => {
  const s = new Session({ id: 'codex-wire-8', type: 'codex' });
  s.analyzeOutput('429 Too Many Requests — please retry');
  assert.equal(s.meta.status, 'errored');
});

// ─────────────────────────────────────────────────────────────────────────
// parseTranscript — Codex JSONL { timestamp, type, payload } shape.
// ─────────────────────────────────────────────────────────────────────────

test('parseTranscript: extracts user input_text + assistant output_text', () => {
  const raw = [
    JSON.stringify({
      timestamp: '2026-05-01T18:36:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello there' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-01T18:36:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi back' }],
      },
    }),
  ].join('\n');
  const out = codexAdapter.parseTranscript(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: 'user', content: 'hello there' });
  assert.deepEqual(out[1], { role: 'assistant', content: 'hi back' });
});

test('parseTranscript: joins multi-block content with spaces', () => {
  const raw = JSON.stringify({
    timestamp: '2026-05-01T18:36:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'first' },
        { type: 'output_text', text: 'second' },
      ],
    },
  });
  const out = codexAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'first second');
});

test('parseTranscript: skips developer role (sandbox/permissions prelude)', () => {
  const raw = [
    JSON.stringify({
      timestamp: '2026-05-01T18:36:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<permissions instructions>...' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-05-01T18:36:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'real prompt' }],
      },
    }),
  ].join('\n');
  const out = codexAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'real prompt');
});

test('parseTranscript: skips event_msg duplicates', () => {
  const raw = [
    JSON.stringify({
      timestamp: '2026-05-01T18:36:00.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'duplicate of response_item' },
    }),
    JSON.stringify({
      timestamp: '2026-05-01T18:36:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'canonical' }],
      },
    }),
  ].join('\n');
  const out = codexAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'canonical');
});

test('parseTranscript: skips response_item types other than message (reasoning, function_call)', () => {
  const raw = [
    JSON.stringify({
      timestamp: '2026-05-01T18:36:00.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAA...' },
    }),
    JSON.stringify({
      timestamp: '2026-05-01T18:36:01.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{}' },
    }),
    JSON.stringify({
      timestamp: '2026-05-01T18:36:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'kept' }],
      },
    }),
  ].join('\n');
  const out = codexAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'kept');
});

test('parseTranscript: tolerates malformed JSON lines (skips them, keeps going)', () => {
  const raw = [
    '{not valid json',
    JSON.stringify({
      timestamp: '2026-05-01T18:36:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'survives' }],
      },
    }),
  ].join('\n');
  const out = codexAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'survives');
});

test('parseTranscript: truncates each message to 400 chars', () => {
  const long = 'x'.repeat(500);
  const raw = JSON.stringify({
    timestamp: '2026-05-01T18:36:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: long }],
    },
  });
  const out = codexAdapter.parseTranscript(raw);
  assert.equal(out[0].content.length, 400);
});

test('parseTranscript: empty / non-string input returns []', () => {
  assert.deepEqual(codexAdapter.parseTranscript(''), []);
  assert.deepEqual(codexAdapter.parseTranscript(null), []);
  assert.deepEqual(codexAdapter.parseTranscript(undefined), []);
});

test('parseTranscript: real Codex rollout shape — session_meta + turn_context + messages', () => {
  // Pinned to the actual on-disk shape from
  // ~/.codex/sessions/2026/04/28/rollout-*.jsonl, sampled 2026-05-01.
  // session_meta and turn_context lines must NOT be parsed as messages —
  // they don't carry user/assistant content.
  const raw = [
    JSON.stringify({
      timestamp: '2026-04-28T20:55:55.822Z',
      type: 'session_meta',
      payload: { id: '019dd5dd-cfc9-7e01-8ed2-14cd4764c1c5', cli_version: '0.125.0' },
    }),
    JSON.stringify({
      timestamp: '2026-04-28T20:55:55.824Z',
      type: 'turn_context',
      payload: { turn_id: 'abc', cwd: '/tmp', current_date: '2026-04-28' },
    }),
    JSON.stringify({
      timestamp: '2026-04-28T20:55:55.824Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'real user prompt' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-28T20:56:07.724Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'real assistant reply' }],
      },
    }),
  ].join('\n');
  const out = codexAdapter.parseTranscript(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'real user prompt');
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[1].content, 'real assistant reply');
});

// ─────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — Codex variant points at AGENTS.md, not CLAUDE.md.
// ─────────────────────────────────────────────────────────────────────────

test('bootPromptTemplate: produces a non-empty multi-line prompt with the lane id and sprint number', () => {
  const out = codexAdapter.bootPromptTemplate(
    { id: 'T1', briefingPath: 'docs/sprint-45/T1-codex-adapter.md' },
    { number: 45, name: 'multi-agent-adapters' }
  );
  assert.ok(out.length > 0);
  assert.ok(out.includes('T1'));
  assert.ok(out.includes('45'));
  assert.ok(out.includes('memory_recall'));
  assert.ok(out.includes('STATUS.md'));
});

test('bootPromptTemplate: points at AGENTS.md (not CLAUDE.md) for Codex', () => {
  const out = codexAdapter.bootPromptTemplate(
    { id: 'T1' },
    { number: 45, name: 'foo' }
  );
  assert.ok(out.includes('AGENTS.md'),
    'Codex boot template must reference AGENTS.md (Codex instructional file)');
});
