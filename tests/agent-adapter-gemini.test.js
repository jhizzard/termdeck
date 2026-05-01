// Sprint 45 T2 — Snapshot tests for the Gemini agent adapter.
//
// Pins the bit-for-bit-identical behavior contract for Gemini sessions
// after migrating PATTERNS.geminiCli + the `case 'gemini':` switch arm
// out of session.js into the registry. Three surfaces are checked:
//
//   (1) The adapter contract itself — shape + regex identity (lifted
//       verbatim from the legacy in-file PATTERNS.geminiCli) + statusFor
//       output for the same inputs the legacy switch handled.
//   (2) The session.js wiring after the refactor — `_detectType`,
//       `_updateStatus`, and `_detectErrors` produce the same observable
//       outputs (meta.type, meta.status, meta.statusDetail) as the
//       pre-Sprint-45 code path.
//   (3) Gemini's session.json transcript format → normalized Memory[]
//       shape that the memory-session-end hook consumes. This is the new
//       capability — Gemini sessions previously didn't write to Mnestra
//       because the hook assumed Claude JSONL.
//
// If any of these tests fail, the adapter has drifted from the legacy
// behavior and the migration is no longer transparent — DO NOT loosen the
// assertions to make them pass; fix the adapter or session.js instead.
//
// Run: node --test tests/agent-adapter-gemini.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const geminiAdapter = require('../packages/server/src/agent-adapters/gemini');
const { AGENT_ADAPTERS, getAdapterForSessionType, detectAdapter }
  = require('../packages/server/src/agent-adapters');
const { Session, PATTERNS } = require('../packages/server/src/session');

// ─────────────────────────────────────────────────────────────────────────
// Adapter contract — required fields per AGENT-RUNTIMES.md § 5. patterns
// for Gemini intentionally omits `editing` / `tool` / `error` (the legacy
// switch had no Gemini-specific branches for those, and `error` falling
// back to PATTERNS.error preserves the pre-Sprint-45 generic detection).
// ─────────────────────────────────────────────────────────────────────────

test('Gemini adapter exposes the required contract shape', () => {
  assert.equal(geminiAdapter.name, 'gemini');
  assert.equal(geminiAdapter.sessionType, 'gemini');
  assert.equal(typeof geminiAdapter.matches, 'function');
  assert.ok(geminiAdapter.spawn && typeof geminiAdapter.spawn === 'object');
  assert.equal(geminiAdapter.spawn.binary, 'gemini');
  assert.ok(Array.isArray(geminiAdapter.spawn.defaultArgs));
  assert.ok(geminiAdapter.spawn.env && typeof geminiAdapter.spawn.env === 'object');
  assert.ok(geminiAdapter.patterns && typeof geminiAdapter.patterns === 'object');
  for (const key of ['prompt', 'thinking']) {
    assert.ok(geminiAdapter.patterns[key] instanceof RegExp,
      `gemini.patterns.${key} should be a RegExp`);
  }
  // Intentional omissions — fallback to PATTERNS.error in session.js.
  assert.equal(geminiAdapter.patterns.error, undefined,
    'gemini.patterns.error should be undefined to preserve PATTERNS.error fallback');
  assert.equal(typeof geminiAdapter.statusFor, 'function');
  assert.equal(typeof geminiAdapter.parseTranscript, 'function');
  assert.equal(typeof geminiAdapter.bootPromptTemplate, 'function');
  assert.ok(['free', 'pay-per-token', 'subscription'].includes(geminiAdapter.costBand));
});

test('AGENT_ADAPTERS registry exposes the Gemini adapter under "gemini"', () => {
  assert.equal(AGENT_ADAPTERS.gemini, geminiAdapter);
  assert.equal(getAdapterForSessionType('gemini'), geminiAdapter);
});

test('PATTERNS.geminiCli shim references the adapter regexes (no duplication)', () => {
  assert.equal(PATTERNS.geminiCli.prompt, geminiAdapter.patterns.prompt);
  assert.equal(PATTERNS.geminiCli.thinking, geminiAdapter.patterns.thinking);
});

// ─────────────────────────────────────────────────────────────────────────
// detectAdapter — used by session.js _detectType. Mirrors the original
// `PATTERNS.geminiCli.prompt.test(data) || /gemini/i.test(command)` OR.
// ─────────────────────────────────────────────────────────────────────────

test('detectAdapter: matches by Gemini prompt marker (gemini>)', () => {
  const adapter = detectAdapter('gemini> ', '');
  assert.equal(adapter, geminiAdapter);
});

test('detectAdapter: matches by command-string when no prompt yet', () => {
  const adapter = detectAdapter('starting up...', 'gemini --resume latest');
  assert.equal(adapter, geminiAdapter);
});

test('detectAdapter: case-insensitive command match', () => {
  const adapter = detectAdapter('boot output', 'GEMINI -p hello');
  assert.equal(adapter, geminiAdapter);
});

// ─────────────────────────────────────────────────────────────────────────
// statusFor — direct unit tests against the adapter, asserting the same
// status / statusDetail strings the old in-file switch produced.
// ─────────────────────────────────────────────────────────────────────────

test('statusFor: "Generating" → "Gemini is generating..." thinking', () => {
  assert.deepEqual(geminiAdapter.statusFor('Generating response now'), {
    status: 'thinking',
    statusDetail: 'Gemini is generating...',
  });
});

test('statusFor: "Working" matches the same thinking pattern', () => {
  assert.deepEqual(geminiAdapter.statusFor('Working on it'), {
    status: 'thinking',
    statusDetail: 'Gemini is generating...',
  });
});

test('statusFor: gemini> prompt → idle "Waiting for input"', () => {
  assert.deepEqual(geminiAdapter.statusFor('gemini> '), {
    status: 'idle',
    statusDetail: 'Waiting for input',
  });
});

test('statusFor: returns null when no gemini pattern matches', () => {
  assert.equal(geminiAdapter.statusFor('plain shell text with no markers'), null);
});

test('statusFor: precedence — thinking wins over prompt when both are present', () => {
  // Mirrors the legacy switch: `if/else if` — thinking match short-circuits.
  const out = geminiAdapter.statusFor('gemini> Generating');
  assert.equal(out.status, 'thinking');
  assert.equal(out.statusDetail, 'Gemini is generating...');
});

// ─────────────────────────────────────────────────────────────────────────
// session.js wiring — same observable behavior post-refactor.
// ─────────────────────────────────────────────────────────────────────────

test('Session._detectType: gemini> prompt sets type=gemini via registry path', () => {
  const s = new Session({ id: 'wire-g1', type: 'shell' });
  s.analyzeOutput('gemini> ');
  assert.equal(s.meta.type, 'gemini');
});

test('Session._detectType: command-string Gemini detection still works', () => {
  const s = new Session({ id: 'wire-g2', type: 'shell', command: 'gemini -p hello' });
  s.analyzeOutput('starting up...');
  assert.equal(s.meta.type, 'gemini');
});

test('Session._updateStatus: Generating pattern updates status + detail', () => {
  const s = new Session({ id: 'wire-g3', type: 'gemini' });
  s.analyzeOutput('Generating a response');
  assert.equal(s.meta.status, 'thinking');
  assert.equal(s.meta.statusDetail, 'Gemini is generating...');
});

test('Session._updateStatus: gemini> prompt sets idle / Waiting for input', () => {
  const s = new Session({ id: 'wire-g4', type: 'gemini' });
  s.analyzeOutput('gemini> ');
  assert.equal(s.meta.status, 'idle');
  assert.equal(s.meta.statusDetail, 'Waiting for input');
});

test('Session._updateStatus: no gemini pattern → status unchanged from "starting"', () => {
  const s = new Session({ id: 'wire-g5', type: 'gemini' });
  s.analyzeOutput('plain output that mentions nothing gemini-specific');
  assert.equal(s.meta.status, 'starting');
});

test('Session._detectErrors: gemini session falls back to PATTERNS.error (no adapter override)', () => {
  // Gemini omits `patterns.error` → session.js _detectErrors path uses the
  // generic prose-shape PATTERNS.error, the same behavior gemini-typed
  // sessions had pre-Sprint-45.
  const s = new Session({ id: 'wire-g6', type: 'gemini' });
  s.analyzeOutput('error: something actually broke');
  assert.equal(s.meta.status, 'errored');
});

// ─────────────────────────────────────────────────────────────────────────
// parseTranscript — Gemini CLI session.json format (single JSON object,
// NOT JSONL). Captured live from `gemini -p "say hi"` on 2026-05-01.
// ─────────────────────────────────────────────────────────────────────────

test('parseTranscript: extracts user content from {text} array', () => {
  const raw = JSON.stringify({
    sessionId: 'sid',
    messages: [
      { id: 'a', timestamp: 't', type: 'user', content: [{ text: 'hello there' }] },
    ],
  });
  const out = geminiAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { role: 'user', content: 'hello there' });
});

test('parseTranscript: maps type=gemini → role=assistant with string content', () => {
  const raw = JSON.stringify({
    messages: [
      { id: 'b', type: 'gemini', content: 'hi back', tokens: { total: 10 } },
    ],
  });
  const out = geminiAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { role: 'assistant', content: 'hi back' });
});

test('parseTranscript: full session.json fixture (matches captured shape)', () => {
  // This is the exact shape Gemini CLI 0.34.0 wrote to
  // ~/.gemini/tmp/joshuaizzard/chats/session-*.json on 2026-05-01.
  const raw = JSON.stringify({
    sessionId: 'ae971ece-a035-4f37-953d-083b41dcbfcc',
    projectHash: '07218df2',
    startTime: '2026-05-01T18:38:38.699Z',
    lastUpdated: '2026-05-01T18:38:40.438Z',
    kind: 'main',
    messages: [
      {
        id: '7aa7a16a',
        timestamp: '2026-05-01T18:38:38.699Z',
        type: 'user',
        content: [{ text: 'say hi in 5 words' }],
      },
      {
        id: '3afee781',
        timestamp: '2026-05-01T18:38:40.438Z',
        type: 'gemini',
        content: 'Hello! How can I help?',
        thoughts: [],
        tokens: { input: 8168, output: 7, cached: 0, thoughts: 42, tool: 0, total: 8217 },
        model: 'gemini-3-flash-preview',
      },
    ],
  });
  const out = geminiAdapter.parseTranscript(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: 'user', content: 'say hi in 5 words' });
  assert.deepEqual(out[1], { role: 'assistant', content: 'Hello! How can I help?' });
});

test('parseTranscript: skips unknown roles (system, tool, etc.)', () => {
  const raw = JSON.stringify({
    messages: [
      { type: 'system', content: 'init' },
      { type: 'user', content: [{ text: 'q' }] },
      { type: 'tool', content: 'output' },
    ],
  });
  const out = geminiAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

test('parseTranscript: tolerates malformed JSON (returns [])', () => {
  assert.deepEqual(geminiAdapter.parseTranscript('{not valid json'), []);
});

test('parseTranscript: tolerates session JSON without messages array', () => {
  assert.deepEqual(geminiAdapter.parseTranscript(JSON.stringify({ sessionId: 'x' })), []);
});

test('parseTranscript: truncates each message to 400 chars', () => {
  const long = 'x'.repeat(500);
  const raw = JSON.stringify({
    messages: [{ type: 'user', content: [{ text: long }] }],
  });
  const out = geminiAdapter.parseTranscript(raw);
  assert.equal(out[0].content.length, 400);
});

test('parseTranscript: joins multi-part user content with single space', () => {
  // User content arrays can carry multiple {text} parts (unlikely from the
  // CLI today but supported by the schema). The Claude adapter joins with
  // ' '; we preserve that for cross-adapter shape parity.
  const raw = JSON.stringify({
    messages: [{ type: 'user', content: [{ text: 'first' }, { text: 'second' }] }],
  });
  const out = geminiAdapter.parseTranscript(raw);
  assert.equal(out[0].content, 'first second');
});

test('parseTranscript: empty / non-string input returns []', () => {
  assert.deepEqual(geminiAdapter.parseTranscript(''), []);
  assert.deepEqual(geminiAdapter.parseTranscript(null), []);
  assert.deepEqual(geminiAdapter.parseTranscript(undefined), []);
});

// ─────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — placeholder contract; Sprint 46 T2 refines.
// ─────────────────────────────────────────────────────────────────────────

test('bootPromptTemplate: references GEMINI.md (not CLAUDE.md) in the read step', () => {
  const out = geminiAdapter.bootPromptTemplate(
    { id: 'T2', briefingPath: 'docs/sprint-45/T2-foo.md' },
    { number: 45, name: 'multi-agent-adapters' }
  );
  assert.ok(out.length > 0);
  assert.ok(out.includes('T2'));
  assert.ok(out.includes('45'));
  assert.ok(out.includes('GEMINI.md'),
    'gemini boot prompt should point at GEMINI.md, not CLAUDE.md');
  assert.ok(out.includes('STATUS.md'));
});
