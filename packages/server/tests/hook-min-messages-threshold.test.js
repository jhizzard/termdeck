// Sprint 64 T2 (carve-out 2.2) — bundled hook MIN_TRANSCRIPT_MESSAGES gate.
//
// Sprint 63 EXIT-CAPTURE-VERIFICATION.md Finding #3 documented Brad's grok
// canary panel silent-skipped at 4 messages / 6,713 bytes (well over the 5 KB
// `MIN_TRANSCRIPT_BYTES` floor) because the hard-coded `messages.length < 5`
// gate fired first. Codex single-turn audit posts have the same shape:
// content-rich, message-count-poor.
//
// Sprint 64 lowers the default floor to 1 and adds `TERMDECK_HOOK_MIN_MESSAGES`
// env var for operator override (mirrors the existing `MIN_TRANSCRIPT_BYTES`
// pattern at line 140 of the bundled hook). The 5 KB byte gate at lines 140 +
// 795 remains the primary noise filter; short-but-content-poor sessions still
// get dropped.
//
// Fences exercise the hook via `buildSummary` (exported when `require()`d, not
// when run as a script). Module-cache invalidation lets each test swap env
// values cleanly.
//
// Run: node --test packages/server/tests/hook-min-messages-threshold.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = require.resolve('../../stack-installer/assets/hooks/memory-session-end.js');

function loadHookFresh(env = {}) {
  const prior = {};
  for (const [k, v] of Object.entries(env)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  delete require.cache[HOOK_PATH];
  const mod = require(HOOK_PATH);
  return {
    hook: mod,
    restore() {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete require.cache[HOOK_PATH];
    },
  };
}

function writeSingleMessageCodexJsonl(dir, byteTarget = 6_000) {
  // Build a single-turn codex JSONL transcript that's content-rich and over
  // the 5 KB byte floor. `parseCodexJsonl` extracts type=response_item
  // payload.type=message with role in {user, assistant} — single line, one
  // assistant message with large `output_text` content satisfies that.
  const file = path.join(dir, 'rollout.jsonl');
  const filler = 'audit OK — '.repeat(Math.max(50, Math.ceil(byteTarget / 11)));
  const line = JSON.stringify({
    timestamp: '2026-05-14T16:00:00Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'output_text', text: `Audited and approved. Evidence: ${filler}`.slice(0, byteTarget) },
      ],
    },
  });
  fs.writeFileSync(file, line + '\n');
  return file;
}

test('hook: default config (TERMDECK_HOOK_MIN_MESSAGES unset) accepts a single-turn >5KB transcript (Brad grok-canary recovery)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-hook-min-msg-'));
  let ctx;
  try {
    const transcript = writeSingleMessageCodexJsonl(tmpDir, 6_500);
    ctx = loadHookFresh({ TERMDECK_HOOK_MIN_MESSAGES: undefined });
    const result = ctx.hook.buildSummary(transcript, 'codex');
    assert.ok(result && typeof result === 'object',
      'expected non-null summary under the new default (N=1)');
    assert.equal(result.messagesCount, 1, 'expected single-message transcript to land');
    assert.ok(typeof result.summary === 'string' && result.summary.length > 0,
      'expected summary to include the audit content');
  } finally {
    if (ctx) ctx.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('hook: TERMDECK_HOOK_MIN_MESSAGES=5 restores the legacy gate (a single-turn transcript is now skipped)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-hook-min-msg-legacy-'));
  let ctx;
  try {
    const transcript = writeSingleMessageCodexJsonl(tmpDir, 6_500);
    ctx = loadHookFresh({ TERMDECK_HOOK_MIN_MESSAGES: '5' });
    const result = ctx.hook.buildSummary(transcript, 'codex');
    assert.equal(result, null,
      'expected null — legacy 5-message floor restored via env override');
  } finally {
    if (ctx) ctx.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('hook: zero-message transcript still rejected even at N=1 (parse returned []) so floor remains lower-bounded by content', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-hook-min-msg-zero-'));
  let ctx;
  try {
    // Malformed/empty transcript — parser returns [] → length 0 < 1 → null.
    const transcript = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(transcript, '');
    ctx = loadHookFresh({ TERMDECK_HOOK_MIN_MESSAGES: undefined });
    const result = ctx.hook.buildSummary(transcript, 'codex');
    assert.equal(result, null,
      'expected null — empty transcript parses to 0 messages, still below the N=1 floor');
  } finally {
    if (ctx) ctx.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('hook: TERMDECK_HOOK_MIN_MESSAGES=0 admits zero-message transcripts (operator opt-out for diagnostic captures)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-hook-min-msg-zero-allow-'));
  let ctx;
  try {
    // Non-empty transcript with no parseable messages — emulates a stuck
    // panel that wrote only system-prompt deltas. parseCodexJsonl returns
    // []; the gate at length < 0 (false) lets it through to buildSummary,
    // which then constructs a summary with the literal "Session with 0
    // messages." text. This is what the env override is for — operators who
    // want every panel close to surface as a Mnestra row, even empty ones.
    const transcript = path.join(tmpDir, 'no-messages.jsonl');
    fs.writeFileSync(transcript, '{"type":"unrelated","payload":{}}\n');
    ctx = loadHookFresh({ TERMDECK_HOOK_MIN_MESSAGES: '0' });
    const result = ctx.hook.buildSummary(transcript, 'codex');
    assert.ok(result && typeof result === 'object',
      'expected non-null result with operator opt-out');
    assert.equal(result.messagesCount, 0,
      'messagesCount=0 confirms the gate let zero-message transcript through');
  } finally {
    if (ctx) ctx.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
