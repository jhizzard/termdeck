// Sprint 70 T1 — Antigravity (`agy`) adapter snapshot tests.
//
// agy is the first adapter with NO on-disk transcript: the in-flight PTY stdout
// stream is the only source. So this suite pins (a) the contract shape, (b) the
// TUI-capture cleaning pipeline (ANSI strip, CR-overdraw collapse, chrome drop,
// redraw de-dup, role heuristic), (c) the dual-mode parseTranscript (raw TUI OR
// its own JSON envelope), and (d) resolveTranscriptPath materializing the
// in-flight buffer into a Gemini-shaped tempfile envelope.
//
// Run: node --test tests/agent-adapter-agy.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agy = require('../packages/server/src/agent-adapters/agy');

// ─────────────────────────────────────────────────────────────────────────
// Contract shape
// ─────────────────────────────────────────────────────────────────────────

test('declares the canonical contract fields', () => {
  assert.equal(agy.name, 'antigravity');
  assert.equal(agy.sessionType, 'antigravity');
  assert.equal(agy.sourceAgent, 'antigravity', 'explicit canonical source_agent');
  assert.equal(agy.displayName, 'Antigravity');
  assert.equal(agy.spawn.binary, 'agy');
  assert.equal(agy.spawn.shellWrap, false, 'must direct-spawn (adapter-spawn-shell-wrap fence)');
  assert.deepEqual(agy.spawn.defaultArgs, []);
  assert.ok(agy.patterns.prompt instanceof RegExp);
  assert.equal(agy.costBand, 'subscription');
  assert.equal(typeof agy.acceptsPaste, 'boolean');
  assert.equal(typeof agy.resolveTranscriptPath, 'function');
});

test('declares opt-in stdout capture (the only adapter that does)', () => {
  assert.ok(agy.capture && typeof agy.capture === 'object');
  assert.equal(agy.capture.mode, 'stdout');
  assert.ok(agy.capture.maxBytes > 0);
  assert.equal(agy.capture.unbuffer, true);
});

test('matches the agy binary and nothing else', () => {
  assert.equal(agy.matches('agy'), true);
  assert.equal(agy.matches('agy --print "hi"'), true);
  assert.equal(agy.matches('/Users/x/.local/bin/agy'), true);
  for (const other of ['claude', 'codex', 'gemini', 'grok', 'ls', 'agymnastics']) {
    assert.equal(agy.matches(other), false, `must not match "${other}"`);
  }
  // null/empty fail-soft
  for (const v of [null, undefined, '']) assert.equal(agy.matches(v), false);
});

test('statusFor returns the documented shapes', () => {
  assert.deepEqual(agy.statusFor('Generating a reply'),
    { status: 'thinking', statusDetail: 'Antigravity is generating...' });
  assert.deepEqual(agy.statusFor('> '),
    { status: 'idle', statusDetail: 'Waiting for input' });
  assert.deepEqual(agy.statusFor('Antigravity CLI 1.0.6'),
    { status: 'idle', statusDetail: 'Waiting for input' });
  assert.equal(agy.statusFor('plain prose with no markers'), null);
  assert.equal(agy.statusFor(123), null);
});

// ─────────────────────────────────────────────────────────────────────────
// parseTranscript — raw TUI capture path
// ─────────────────────────────────────────────────────────────────────────

test('strips ANSI/SGR/cursor escapes from captured content', () => {
  const raw = '\x1b[?1049h\x1b[2J\x1b[H\x1b[48;2;66;133;244m\x1b[38;2;0;0;0mhello world\x1b[m\r\n';
  const msgs = agy.parseTranscript(raw);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, 'hello world');
  assert.ok(!/\x1b/.test(msgs[0].content), 'no escape bytes survive');
});

test('collapses lone-CR spinner overdraws to the final frame', () => {
  // Braille spinner frames separated by lone CR (no LF), then the real line.
  const raw = '⠾ working\r⢷ working\r⢽ done now\r\n';
  const msgs = agy.parseTranscript(raw);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].content.includes('done now'), 'keeps the last overdraw frame');
  assert.ok(!msgs[0].content.includes('working'), 'drops the overwritten frames');
});

test('drops box-drawing / Braille chrome lines but keeps markdown rules', () => {
  const raw = [
    '────────',  // box rule → chrome, drop
    'real content line',
    '⣿⣿⣿',                                  // pure spinner → chrome, drop
    '--- markdown rule ---',                                // ASCII hyphens → KEEP
  ].join('\r\n');
  const msgs = agy.parseTranscript(raw);
  const contents = msgs.map((m) => m.content);
  assert.ok(contents.includes('real content line'));
  assert.ok(contents.some((c) => c.includes('markdown rule')), 'ASCII markdown rule is not chrome');
  assert.ok(!contents.some((c) => /^─+$/.test(c)), 'box rule dropped');
});

test('de-duplicates consecutive redraw frames', () => {
  const raw = 'The answer is 4.\r\nThe answer is 4.\r\nThe answer is 4.\r\n';
  const msgs = agy.parseTranscript(raw);
  assert.equal(msgs.length, 1, 'identical consecutive lines collapse to one');
  assert.equal(msgs[0].content, 'The answer is 4.');
});

test('attributes user role to prompt-box input, assistant to the rest', () => {
  const raw = [
    '> what is 2+2?',          // inline prompt → user
    'The answer is 4.',        // → assistant
    '>',                       // bare input box…
    'tell me a joke',          // …→ next line is user
  ].join('\r\n');
  const msgs = agy.parseTranscript(raw);
  const byContent = Object.fromEntries(msgs.map((m) => [m.content, m.role]));
  assert.equal(byContent['what is 2+2?'], 'user');
  assert.equal(byContent['The answer is 4.'], 'assistant');
  assert.equal(byContent['tell me a joke'], 'user');
});

test('truncates each record to 400 chars (parity with the other parsers)', () => {
  const long = 'x'.repeat(600);
  const msgs = agy.parseTranscript(long);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content.length, 400);
});

// ─────────────────────────────────────────────────────────────────────────
// parseTranscript — structured envelope path (dual-mode + round-trip)
// ─────────────────────────────────────────────────────────────────────────

test('parses its own Gemini-shaped envelope (hook round-trip safety)', () => {
  const envelope = JSON.stringify({
    messages: [
      { type: 'user', content: 'hi there' },
      { type: 'assistant', content: 'hello back' },
      { type: 'gemini', content: 'legacy-shape assistant' },
    ],
  });
  const msgs = agy.parseTranscript(envelope);
  assert.deepEqual(msgs, [
    { role: 'user', content: 'hi there' },
    { role: 'assistant', content: 'hello back' },
    { role: 'assistant', content: 'legacy-shape assistant' },
  ]);
});

test('parses a bare {role,content} array envelope', () => {
  const arr = JSON.stringify([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ text: 'a1' }, { text: 'a2' }] },
  ]);
  const msgs = agy.parseTranscript(arr);
  assert.deepEqual(msgs, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a1 a2' },
  ]);
});

test('returns an array for null/empty/garbage (fail-soft contract)', () => {
  for (const v of ['', null, undefined, '   ', 42, {}]) {
    assert.ok(Array.isArray(agy.parseTranscript(v)), `parseTranscript(${JSON.stringify(v)}) must be an array`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// resolveTranscriptPath — materialize the in-flight buffer
// ─────────────────────────────────────────────────────────────────────────

test('materializes the capture buffer into a tmpdir Gemini-envelope tempfile', async () => {
  const session = {
    id: 'agy-resolve-1',
    pid: 4242,
    meta: { type: 'antigravity', cwd: '/tmp/agy-proj' },
    _stdoutCapture: {
      chunks: ['> summarize the design\r\n', '\x1b[32mThe design uses a PTY tee.\x1b[m\r\n'],
      bytes: 50,
      maxBytes: 4 * 1024 * 1024,
    },
  };
  let tmpfile;
  try {
    tmpfile = await agy.resolveTranscriptPath(session);
    assert.ok(typeof tmpfile === 'string' && tmpfile.length > 0, 'returns a path');
    assert.ok(tmpfile.startsWith(os.tmpdir()), 'path is under os.tmpdir()');
    assert.ok(fs.existsSync(tmpfile), 'tempfile written');
    const envelope = JSON.parse(fs.readFileSync(tmpfile, 'utf8'));
    assert.ok(Array.isArray(envelope.messages), 'Gemini-envelope {messages:[...]} shape');
    const joined = envelope.messages.map((m) => `${m.type}:${m.content}`).join('|');
    assert.ok(joined.includes('summarize the design'), 'user prompt captured');
    assert.ok(joined.includes('The design uses a PTY tee.'), 'assistant content captured, ANSI-stripped');
    assert.ok(!/\x1b/.test(joined), 'no escapes in the envelope');
    // The envelope is what the hook ingests — round-trips through parseTranscript.
    const round = agy.parseTranscript(fs.readFileSync(tmpfile, 'utf8'));
    assert.ok(round.length >= 2);
  } finally {
    if (tmpfile) try { fs.unlinkSync(tmpfile); } catch (_) { /* fail-soft */ }
  }
});

test('returns null when the panel produced no output (no row, clean no-op)', async () => {
  assert.equal(await agy.resolveTranscriptPath({ id: 'x', meta: {} }), null, 'no _stdoutCapture');
  assert.equal(await agy.resolveTranscriptPath({
    id: 'x', meta: {}, _stdoutCapture: { chunks: [], bytes: 0, maxBytes: 10 },
  }), null, 'empty buffer');
  assert.equal(await agy.resolveTranscriptPath({
    id: 'x', meta: {}, _stdoutCapture: { chunks: ['───\r\n'], bytes: 8, maxBytes: 10 },
  }), null, 'buffer that cleans to zero messages (pure chrome)');
  assert.equal(await agy.resolveTranscriptPath(null), null, 'no session');
});

// ─────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — points at AGENTS.md
// ─────────────────────────────────────────────────────────────────────────

test('bootPromptTemplate scaffolds against AGENTS.md', () => {
  const out = agy.bootPromptTemplate(
    { id: 'T1', briefingPath: 'docs/sprint-70/T1-foo.md' },
    { number: 70, name: 'cli-runtime-migration', project: 'termdeck' },
  );
  assert.ok(out.includes('AGENTS.md'), 'reads AGENTS.md (Antigravity convention), not CLAUDE.md');
  assert.ok(out.includes('Sprint 70'));
  assert.ok(out.includes('\n'), 'multi-line');
});
