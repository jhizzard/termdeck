// Sprint 45 T3 — Snapshot tests for the Grok agent adapter.
//
// Pins the contract shape, status patterns, transcript parser, and boot
// prompt template for the Grok adapter. Mirrors the structure of the
// Sprint 44 Claude tests so the registry stays uniform across agents.
// If any assertion fails, do NOT loosen — fix the adapter to match the
// pinned behavior, or update SPRINT-45-PREP-NOTES.md and re-pin.
//
// Run: node --test tests/agent-adapter-grok.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const grokAdapter = require('../packages/server/src/agent-adapters/grok');
const { AGENT_ADAPTERS, getAdapterForSessionType, detectAdapter }
  = require('../packages/server/src/agent-adapters');
const { MODELS } = require('../packages/server/src/agent-adapters/grok-models');

// ─────────────────────────────────────────────────────────────────────────
// Adapter contract — all 7 fields documented in claude.js / AGENT-RUNTIMES.md
// must be present, non-null, and the right shape.
// ─────────────────────────────────────────────────────────────────────────

test('Grok adapter exposes the full contract shape', () => {
  assert.equal(grokAdapter.name, 'grok');
  assert.equal(grokAdapter.sessionType, 'grok');
  assert.equal(typeof grokAdapter.matches, 'function');
  assert.ok(grokAdapter.spawn && typeof grokAdapter.spawn === 'object');
  assert.equal(grokAdapter.spawn.binary, 'grok');
  assert.ok(Array.isArray(grokAdapter.spawn.defaultArgs));
  assert.ok(grokAdapter.spawn.env && typeof grokAdapter.spawn.env === 'object');
  assert.ok(grokAdapter.patterns && typeof grokAdapter.patterns === 'object');
  for (const key of ['prompt', 'thinking', 'editing', 'tool', 'idle', 'error']) {
    assert.ok(grokAdapter.patterns[key] instanceof RegExp,
      `grok.patterns.${key} should be a RegExp`);
  }
  assert.equal(grokAdapter.patternNames.error, 'grok-error',
    'patternNames.error label is the adapter id (used by flashback diag)');
  assert.equal(typeof grokAdapter.statusFor, 'function');
  assert.equal(typeof grokAdapter.parseTranscript, 'function');
  assert.equal(typeof grokAdapter.bootPromptTemplate, 'function');
  assert.equal(grokAdapter.costBand, 'subscription',
    'SuperGrok Heavy carries the rate limits — subscription tier is correct');
});

test('Grok adapter spawn.env defaults GROK_MODEL to cheap-fast', () => {
  // Bill-safety property: the default model in spawn.env must be cheap-fast.
  // Heavy-tier access requires per-lane override at launch time (Sprint 46).
  assert.equal(grokAdapter.spawn.env.GROK_MODEL, MODELS['fast-non-reasoning']);
  assert.equal(grokAdapter.spawn.env.GROK_MODEL, 'grok-4-1-fast-non-reasoning');
});

test('AGENT_ADAPTERS registry exposes Grok under "grok"', () => {
  assert.equal(AGENT_ADAPTERS.grok, grokAdapter);
  assert.equal(getAdapterForSessionType('grok'), grokAdapter);
  assert.equal(getAdapterForSessionType('claude-code'),
    AGENT_ADAPTERS.claude,
    'Sibling lookup still works — grok adapter does not shadow claude');
});

// ─────────────────────────────────────────────────────────────────────────
// matches() — command-string detection. Bare `grok`, `grok --resume`,
// `/usr/local/bin/grok`. Must NOT match `claude` or `gemini` even though
// substrings could overlap if the regex were too loose.
// ─────────────────────────────────────────────────────────────────────────

test('matches: bare "grok" command → true', () => {
  assert.equal(grokAdapter.matches('grok'), true);
});

test('matches: "grok --session latest" → true', () => {
  assert.equal(grokAdapter.matches('grok --session latest'), true);
});

test('matches: absolute path "/usr/local/bin/grok" → true', () => {
  assert.equal(grokAdapter.matches('/usr/local/bin/grok'), true);
});

test('matches: "claude" → false (no false positive)', () => {
  assert.equal(grokAdapter.matches('claude'), false);
});

test('matches: "gemini" → false', () => {
  assert.equal(grokAdapter.matches('gemini'), false);
});

test('matches: "codex" → false', () => {
  assert.equal(grokAdapter.matches('codex'), false);
});

test('matches: undefined/null/non-string → false (no throw)', () => {
  assert.equal(grokAdapter.matches(undefined), false);
  assert.equal(grokAdapter.matches(null), false);
  assert.equal(grokAdapter.matches(42), false);
});

test('matches: case-insensitive', () => {
  assert.equal(grokAdapter.matches('GROK'), true);
  assert.equal(grokAdapter.matches('Grok --help'), true);
});

// ─────────────────────────────────────────────────────────────────────────
// detectAdapter routes Grok output through the registry.
// ─────────────────────────────────────────────────────────────────────────

test('detectAdapter: matches Grok by command string', () => {
  const adapter = detectAdapter('boot output', 'grok');
  assert.equal(adapter, grokAdapter);
});

test('detectAdapter: matches Grok by TUI placeholder', () => {
  const adapter = detectAdapter('Message Grok…', '');
  assert.equal(adapter, grokAdapter);
});

// Sprint 47 orchestrator side-task: the TUI rotates empty-state placeholders
// ("What are we building?", "Bring me a problem", etc.). Original Sprint 45
// pattern only matched "Message Grok…" so panels stayed type=shell when the
// rotated placeholder was visible. PROMPT now also accepts the model-mode
// footer line which renders on every frame.
test('detectAdapter: matches Grok by model-mode footer (Reasoning)', () => {
  const adapter = detectAdapter('Grok 4.20 Reasoning 100% 2M @ files shift+enter new line tab modes', '');
  assert.equal(adapter, grokAdapter);
});

test('detectAdapter: matches Grok by model-mode footer (Heavy)', () => {
  const adapter = detectAdapter('Grok 4.20 Heavy', '');
  assert.equal(adapter, grokAdapter);
});

test('detectAdapter: matches Grok by model-mode footer (Code mode)', () => {
  const adapter = detectAdapter('Grok 4.20 Code', '');
  assert.equal(adapter, grokAdapter);
});

test('detectAdapter: matches Grok against rotated placeholder + footer combo', () => {
  // Real TUI output observed 2026-05-01: rotated placeholder "What are we
  // building?" with the model-mode footer below. Only the footer string
  // matches PROMPT — confirming the regex no longer depends on a single
  // stable placeholder.
  const buf = `\n\n      Grok\n\n  Agent  What are we building?\n\n  Grok 4.20 Reasoning 100% 2M @ files shift+enter new line tab modes\n`;
  const adapter = detectAdapter(buf, 'zsh');
  assert.equal(adapter, grokAdapter);
});

// ─────────────────────────────────────────────────────────────────────────
// statusFor — based on grok-dev@1.1.5 dist/ui/app.js shimmer-text strings
// observed at lane time. See grok.js header comment for the source map.
// ─────────────────────────────────────────────────────────────────────────

test('statusFor: "Planning next moves" → thinking', () => {
  assert.deepEqual(grokAdapter.statusFor('Planning next moves'), {
    status: 'thinking',
    statusDetail: 'Grok is reasoning...',
  });
});

test('statusFor: "Generating plan..." → thinking', () => {
  assert.deepEqual(grokAdapter.statusFor('Generating plan...'), {
    status: 'thinking',
    statusDetail: 'Grok is reasoning...',
  });
});

test('statusFor: Unicode ellipsis "Generating plan…" → thinking', () => {
  assert.deepEqual(grokAdapter.statusFor('Generating plan…'), {
    status: 'thinking',
    statusDetail: 'Grok is reasoning...',
  });
});

test('statusFor: "Answering…" (/btw overlay) → thinking', () => {
  assert.deepEqual(grokAdapter.statusFor('Answering…'), {
    status: 'thinking',
    statusDetail: 'Grok is reasoning...',
  });
});

test('statusFor: TUI inline-tool marker "→ Read" → editing', () => {
  // Grok TUI prefixes file-mutation tool calls with `Edit`/`Write`/`Read`
  // labels. EDITING wins over TOOL because EDITING is the more-specific
  // pattern (same precedence Claude uses for its editing/tool ordering).
  const out = grokAdapter.statusFor('  → Read packages/server/src/session.js');
  assert.equal(out.status, 'editing');
  assert.match(out.statusDetail, /Read /);
});

test('statusFor: headless "▸ bash" tool marker → active "Using tools"', () => {
  // dist/headless/output.js emits ▸ for tool calls in non-TUI mode. The
  // editing precedence only fires for the file-mutation verb subset; bash
  // is a generic tool → active status.
  const out = grokAdapter.statusFor('▸ bash');
  assert.equal(out.status, 'active');
  assert.equal(out.statusDetail, 'Using tools');
});

test('statusFor: "Running command..." → active "Using tools"', () => {
  const out = grokAdapter.statusFor('Running command...');
  assert.equal(out.status, 'active');
  assert.equal(out.statusDetail, 'Using tools');
});

test('statusFor: "Starting process..." → active "Using tools"', () => {
  const out = grokAdapter.statusFor('Starting process...');
  assert.equal(out.status, 'active');
  assert.equal(out.statusDetail, 'Using tools');
});

test('statusFor: idle placeholder → idle', () => {
  const out = grokAdapter.statusFor('\nMessage Grok…');
  assert.equal(out.status, 'idle');
  assert.equal(out.statusDetail, 'Waiting for input');
});

test('statusFor: returns null when no Grok pattern matches', () => {
  assert.equal(grokAdapter.statusFor('plain shell text with nothing grok-specific'), null);
});

test('statusFor: precedence — thinking wins over editing/tool', () => {
  const out = grokAdapter.statusFor('Planning next moves\n→ Read foo.js');
  assert.equal(out.status, 'thinking');
});

test('statusFor: non-string input returns null (no throw)', () => {
  assert.equal(grokAdapter.statusFor(undefined), null);
  assert.equal(grokAdapter.statusFor(null), null);
  assert.equal(grokAdapter.statusFor(123), null);
});

// ─────────────────────────────────────────────────────────────────────────
// Error pattern — Grok shares Claude's strategy: line-anchored to avoid
// false positives on tool output that mentions "error" mid-line.
// ─────────────────────────────────────────────────────────────────────────

test('patterns.error: line-anchored "Error:" fires', () => {
  assert.match('Error: something broke', grokAdapter.patterns.error);
});

test('patterns.error: BtwOverlay "Something went wrong" fires', () => {
  // Grok-specific: dist/ui/components/btw-overlay.js renders this literal
  // when the /btw answer fetch fails (state.status === "error").
  assert.match('Something went wrong.', grokAdapter.patterns.error);
});

test('patterns.error: mid-line "Error" in tool output does NOT fire', () => {
  // Same false-positive guard Claude uses — grep results, test logs, lsp
  // diagnostics often mention "Error" mid-line without the panel actually
  // being errored.
  assert.doesNotMatch('  found 3 results: Error in foo.js mentioned in passing',
    grokAdapter.patterns.error);
});

// ─────────────────────────────────────────────────────────────────────────
// parseTranscript — accepts JSON-array OR JSONL of message_json rows from
// ~/.grok/grok.db. Sprint 45 T4 wires the SQLite extraction into the memory
// hook; T3 supplies the parser that turns those rows into Memory[].
// ─────────────────────────────────────────────────────────────────────────

test('parseTranscript: JSON array of string-content messages', () => {
  const raw = JSON.stringify([
    { role: 'user', content: 'hello there' },
    { role: 'assistant', content: 'hi back' },
  ]);
  const out = grokAdapter.parseTranscript(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: 'user', content: 'hello there' });
  assert.deepEqual(out[1], { role: 'assistant', content: 'hi back' });
});

test('parseTranscript: assistant with array-of-text-block content', () => {
  // AI SDK provider shape: array of parts with type discriminator.
  const raw = JSON.stringify([{
    role: 'assistant',
    content: [
      { type: 'text', text: 'first' },
      { type: 'tool-call', toolCallId: 'tc1', toolName: 'Read', input: {} },
      { type: 'text', text: 'second' },
    ],
  }]);
  const out = grokAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'first second');
});

test('parseTranscript: skips non-user/assistant roles (tool, system)', () => {
  const raw = JSON.stringify([
    { role: 'system', content: 'init' },
    { role: 'user', content: 'q' },
    { role: 'tool', content: [{ type: 'tool-result', output: 'ok' }] },
    { role: 'assistant', content: 'a' },
  ]);
  const out = grokAdapter.parseTranscript(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'user');
  assert.equal(out[1].role, 'assistant');
});

test('parseTranscript: JSONL fallback (one message per line)', () => {
  const raw = [
    JSON.stringify({ role: 'user', content: 'q' }),
    JSON.stringify({ role: 'assistant', content: 'a' }),
  ].join('\n');
  const out = grokAdapter.parseTranscript(raw);
  assert.equal(out.length, 2);
});

test('parseTranscript: tolerates malformed JSONL lines', () => {
  const raw = [
    '{not valid',
    JSON.stringify({ role: 'user', content: 'survives' }),
  ].join('\n');
  const out = grokAdapter.parseTranscript(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'survives');
});

test('parseTranscript: truncates each message to 400 chars (Claude parity)', () => {
  const long = 'x'.repeat(500);
  const raw = JSON.stringify([{ role: 'user', content: long }]);
  const out = grokAdapter.parseTranscript(raw);
  assert.equal(out[0].content.length, 400);
});

test('parseTranscript: empty / non-string input returns []', () => {
  assert.deepEqual(grokAdapter.parseTranscript(''), []);
  assert.deepEqual(grokAdapter.parseTranscript(null), []);
  assert.deepEqual(grokAdapter.parseTranscript(undefined), []);
});

test('parseTranscript: empty array → []', () => {
  assert.deepEqual(grokAdapter.parseTranscript('[]'), []);
});

test('parseTranscript: drops messages with no extractable text', () => {
  // Pure tool-call array with no text parts → no Memory record.
  const raw = JSON.stringify([{
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'tc', toolName: 'Bash', input: {} }],
  }]);
  assert.deepEqual(grokAdapter.parseTranscript(raw), []);
});

// ─────────────────────────────────────────────────────────────────────────
// bootPromptTemplate — points the lane at AGENTS.md (Grok's instructional
// file convention, shared with Codex per docs/AGENT-RUNTIMES.md § 4).
// ─────────────────────────────────────────────────────────────────────────

test('bootPromptTemplate: includes lane id, sprint number, AGENTS.md', () => {
  const out = grokAdapter.bootPromptTemplate(
    { id: 'T3', briefingPath: 'docs/sprint-45-multi-agent-adapters/T3-grok-adapter.md',
      project: 'termdeck', topic: 'grok adapter' },
    { number: 45, name: 'multi-agent-adapters' }
  );
  assert.ok(out.includes('T3'));
  assert.ok(out.includes('45'));
  assert.ok(out.includes('AGENTS.md'),
    'Grok reads AGENTS.md (not CLAUDE.md) — boot prompt must point there');
  assert.ok(out.includes('memory_recall'));
  assert.ok(out.includes('STATUS.md'));
  assert.ok(out.includes('grok adapter'));
});

test('bootPromptTemplate: tolerates missing fields with sensible defaults', () => {
  const out = grokAdapter.bootPromptTemplate({}, {});
  assert.ok(out.length > 0);
  assert.ok(out.includes('T?'));
  assert.ok(out.includes('AGENTS.md'));
});
