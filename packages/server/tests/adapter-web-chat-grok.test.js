// Sprint 72 T2 — web-chat-grok adapter unit tests (no server, no driver).
//
// Fences the adapter CONTRACT in isolation:
//   - matches() never claims a session (can't hijack PTY detection);
//   - registry registration is inert for detectAdapter + leaves the CLI 'grok'
//     adapter's sessionType mapping intact;
//   - statusFor / parseTranscript / resolveTranscriptPath behave per contract,
//     including the agy-shaped Gemini envelope the bundled hook ingests.
//
// Run: node --test packages/server/tests/adapter-web-chat-grok.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');

const adapter = require('../src/agent-adapters/web-chat-grok');
const registry = require('../src/agent-adapters');
const { AGENT_ADAPTERS, detectAdapter, getAdapterForSessionType } = registry;

// ── identity + registry non-interference ──────────────────────────────────

test('adapter identity: sessionType web-chat, name web-chat-grok, sourceAgent grok (ORCH zero-touch), subscription', () => {
  assert.equal(adapter.sessionType, 'web-chat');
  assert.equal(adapter.name, 'web-chat-grok');
  assert.equal(adapter.sourceAgent, 'grok'); // ORCH Blocker-3 decision — not 'grok-web'
  assert.equal(adapter.costBand, 'subscription');
  assert.equal(typeof adapter.resolveTranscriptPath, 'function',
    'resolveTranscriptPath MUST be a function or onPanelClose/periodic-capture skip web-chat');
});

test('matches() is always false — web-chat is created only by explicit type, never auto-detected', () => {
  for (const cmd of ['grok', 'claude', 'codex --resume x', 'agy', 'web-chat', 'web-chat-grok', '', null, undefined, 42]) {
    assert.equal(adapter.matches(cmd), false, `matches(${JSON.stringify(cmd)}) must be false`);
  }
});

test('adapter carries NO prompt pattern (cannot win detectAdapter on PTY output)', () => {
  assert.ok(!adapter.patterns || !adapter.patterns.prompt,
    'a prompt pattern would let detectAdapter steal a real PTY panel');
});

test('registry: getAdapterForSessionType maps web-chat → web-chat-grok and leaves grok CLI intact', () => {
  assert.equal(getAdapterForSessionType('web-chat'), adapter);
  const grokCli = getAdapterForSessionType('grok');
  assert.ok(grokCli && grokCli.name === 'grok' && grokCli.sessionType === 'grok',
    "the CLI 'grok' adapter still owns sessionType 'grok' — web-chat-grok did not shadow it");
  assert.ok(Object.prototype.hasOwnProperty.call(AGENT_ADAPTERS, 'web-chat-grok'),
    'registered under the registry key web-chat-grok');
});

test('registry: detectAdapter never returns web-chat-grok (grok CLI output still resolves to grok)', () => {
  // A grok CLI footer line should resolve to the CLI grok adapter, not web-chat.
  const grokFooter = 'Grok 4.20 Reasoning';
  const hit = detectAdapter(grokFooter, undefined);
  assert.ok(hit && hit.sessionType !== 'web-chat',
    'grok CLI output must not be claimed by the web-chat adapter');
  // Output that matches nothing + no command ⇒ undefined (never web-chat-grok).
  const none = detectAdapter('just some plain prose with no agent signal', undefined);
  assert.ok(!none || none.sessionType !== 'web-chat');
});

// ── statusFor ──────────────────────────────────────────────────────────────

test('statusFor: completed response ⇒ idle; thinking shimmer ⇒ thinking; empty/non-string ⇒ null', () => {
  assert.deepEqual(adapter.statusFor('Here is the answer to your question.'),
    { status: 'idle', statusDetail: 'Ready' });
  assert.equal(adapter.statusFor('Planning next moves').status, 'thinking');
  assert.equal(adapter.statusFor('Answering…').status, 'thinking');
  assert.equal(adapter.statusFor(''), null);
  assert.equal(adapter.statusFor(null), null);
  assert.equal(adapter.statusFor(undefined), null);
});

test('statusFor never returns errored — a Grok answer DISCUSSING an error is not a panel error', () => {
  const st = adapter.statusFor('To fix that, handle the Error: ENOENT in your code.');
  assert.notEqual(st && st.status, 'errored');
});

// ── parseTranscript ──────────────────────────────────────────────────────────

test('parseTranscript: Gemini envelope {messages:[{type,content}]} → [{role,content}]', () => {
  const raw = JSON.stringify({ messages: [
    { type: 'user', content: 'hello grok' },
    { type: 'assistant', content: 'hi there' },
  ] });
  assert.deepEqual(adapter.parseTranscript(raw), [
    { role: 'user', content: 'hello grok' },
    { role: 'assistant', content: 'hi there' },
  ]);
});

test('parseTranscript: bare [{role,content}] array round-trips', () => {
  const raw = JSON.stringify([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  assert.deepEqual(adapter.parseTranscript(raw), [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ]);
});

test('parseTranscript: content truncated to 400 chars; garbage/empty → []', () => {
  const long = 'x'.repeat(900);
  const out = adapter.parseTranscript(JSON.stringify([{ role: 'assistant', content: long }]));
  assert.equal(out[0].content.length, 400);
  assert.deepEqual(adapter.parseTranscript('not json'), []);
  assert.deepEqual(adapter.parseTranscript(''), []);
  assert.deepEqual(adapter.parseTranscript(JSON.stringify({ messages: [{ type: 'system', content: 'x' }] })), [],
    'unknown roles dropped');
});

// ── resolveTranscriptPath (materialization) ──────────────────────────────────

test('resolveTranscriptPath: materializes the turn buffer into a tmpdir Gemini envelope the hook ingests', async () => {
  const session = {
    id: 'webchat-test-1',
    meta: { cwd: '/tmp/wc', createdAt: new Date().toISOString() },
    _webChatTranscript: { turns: [
      { role: 'user', content: 'explain the seam design' },
      { role: 'assistant', content: 'the server seam routes inject to the driver, not pty.write' },
    ] },
  };
  let tmpfile;
  try {
    tmpfile = await adapter.resolveTranscriptPath(session);
    assert.ok(typeof tmpfile === 'string' && tmpfile.startsWith(os.tmpdir()),
      'returns a tmpdir tempfile (no on-disk web-chat transcript exists)');
    assert.ok(fs.existsSync(tmpfile));
    const envelope = JSON.parse(fs.readFileSync(tmpfile, 'utf8'));
    assert.ok(Array.isArray(envelope.messages) && envelope.messages.length === 2,
      'Gemini-envelope {messages:[{type,content}]} shape');
    assert.equal(envelope.messages[0].type, 'user');
    assert.equal(envelope.messages[1].type, 'assistant');
    // The adapter parses its OWN envelope back (round-trip / hook parity).
    const reparsed = adapter.parseTranscript(JSON.stringify(envelope));
    assert.equal(reparsed.length, 2);
    assert.equal(reparsed[0].role, 'user');
  } finally {
    if (tmpfile) try { fs.unlinkSync(tmpfile); } catch (_) { /* fail-soft */ }
  }
});

test('resolveTranscriptPath: empty / absent buffer ⇒ null (clean no-op on close)', async () => {
  assert.equal(await adapter.resolveTranscriptPath({ id: 'x', meta: {}, _webChatTranscript: { turns: [] } }), null);
  assert.equal(await adapter.resolveTranscriptPath({ id: 'x', meta: {} }), null);
  assert.equal(await adapter.resolveTranscriptPath(null), null);
  assert.equal(await adapter.resolveTranscriptPath({ id: 'x', meta: {}, _webChatTranscript: { turns: [{ role: 'user', content: '' }] } }), null,
    'turns with no content ⇒ zero messages ⇒ null');
});
