// Sprint 51.7 T2 — parseTranscriptMetadata unit suite.
//
// The bundled hook now populates memory_sessions.started_at /
// duration_minutes / facts_extracted from per-message timestamps and
// memory_remember tool_use counts. v1 (Sprint 51.6 T3) shipped the
// "minimum viable row" with these fields NULL/0; v2 closes the gap.
//
// Tests cover the brief-required cases (empty, single, multi-message
// span, malformed-line skip, three memory_remember, one memory_remember
// + one Bash) plus the T4-CODEX 11:09 ET pre-audit catch: the parser
// must count `mcp__memory__memory_remember` (legacy MCP server name) as
// well as `mcp__mnestra__memory_remember` and bare `memory_remember`.
// A final fixture-roundtrip test asserts that the trimmed real transcript
// at fixtures/transcript-sample.jsonl produces the expected metadata.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const hookPath = path.join(
  repoRoot,
  'packages', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js'
);
const { parseTranscriptMetadata, FACT_TOOL_NAMES, extractContentBlocks } = require(hookPath);

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'transcript-sample.jsonl');

function ts(iso) { return new Date(iso).toISOString(); }
function line(obj) { return JSON.stringify(obj); }

// ── Empty / degenerate inputs ───────────────────────────────────────────────

test('empty string → all-null metadata', () => {
  assert.deepEqual(parseTranscriptMetadata(''), {
    startedAt: null,
    endedAt: null,
    durationMinutes: null,
    factsExtracted: 0,
  });
});

test('null/undefined input → all-null metadata (defensive)', () => {
  assert.deepEqual(parseTranscriptMetadata(null), {
    startedAt: null,
    endedAt: null,
    durationMinutes: null,
    factsExtracted: 0,
  });
  assert.deepEqual(parseTranscriptMetadata(undefined), {
    startedAt: null,
    endedAt: null,
    durationMinutes: null,
    factsExtracted: 0,
  });
});

test('lines with no timestamps → null timestamps, factsExtracted from tool_use only', () => {
  const raw = [
    line({ message: { role: 'user', content: 'hi' } }),
    line({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'memory_remember', id: 't1' }] } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.startedAt, null);
  assert.equal(meta.endedAt, null);
  assert.equal(meta.durationMinutes, null);
  assert.equal(meta.factsExtracted, 1);
});

// ── Brief acceptance cases ──────────────────────────────────────────────────

test('single message → startedAt === endedAt, durationMinutes === 0', () => {
  const raw = line({
    timestamp: '2026-05-04T10:00:00.000Z',
    message: { role: 'user', content: 'hi' },
  });
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.startedAt, ts('2026-05-04T10:00:00.000Z'));
  assert.equal(meta.endedAt, ts('2026-05-04T10:00:00.000Z'));
  assert.equal(meta.durationMinutes, 0);
  assert.equal(meta.factsExtracted, 0);
});

test('multi-message 30-min span → durationMinutes === 30', () => {
  const raw = [
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'user', content: 'start' } }),
    line({ timestamp: '2026-05-04T10:15:00.000Z', message: { role: 'assistant', content: 'middle' } }),
    line({ timestamp: '2026-05-04T10:30:00.000Z', message: { role: 'user', content: 'end' } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.startedAt, ts('2026-05-04T10:00:00.000Z'));
  assert.equal(meta.endedAt, ts('2026-05-04T10:30:00.000Z'));
  assert.equal(meta.durationMinutes, 30);
});

test('out-of-order timestamps → earliest/latest still correct', () => {
  // Defends against a transcript whose lines are not strictly chronological
  // (rare, but possible after sidechain merges or partial replay).
  const raw = [
    line({ timestamp: '2026-05-04T10:30:00.000Z', message: { role: 'assistant', content: 'last' } }),
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'user', content: 'first' } }),
    line({ timestamp: '2026-05-04T10:15:00.000Z', message: { role: 'assistant', content: 'middle' } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.startedAt, ts('2026-05-04T10:00:00.000Z'));
  assert.equal(meta.endedAt, ts('2026-05-04T10:30:00.000Z'));
  assert.equal(meta.durationMinutes, 30);
});

test('malformed JSON line in middle → skipped, valid lines still counted', () => {
  const raw = [
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'user', content: 'a' } }),
    '{ this is not valid json',
    line({ timestamp: '2026-05-04T10:30:00.000Z', message: { role: 'assistant', content: 'b' } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.startedAt, ts('2026-05-04T10:00:00.000Z'));
  assert.equal(meta.endedAt, ts('2026-05-04T10:30:00.000Z'));
  assert.equal(meta.durationMinutes, 30);
});

test('three memory_remember tool_use blocks (mixed names) → factsExtracted === 3', () => {
  const raw = [
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'memory_remember', id: 't1' }] } }),
    line({ timestamp: '2026-05-04T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__mnestra__memory_remember', id: 't2' }] } }),
    line({ timestamp: '2026-05-04T10:02:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__memory__memory_remember', id: 't3' }] } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.factsExtracted, 3);
});

test('one memory_remember + one Bash → factsExtracted === 1 (Bash not counted)', () => {
  const raw = [
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'memory_remember', id: 't1' }] } }),
    line({ timestamp: '2026-05-04T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: 't2', input: { command: 'ls' } }] } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.factsExtracted, 1);
});

// ── T4-CODEX 11:09 ET pre-audit: legacy MCP name must count ─────────────────

test('legacy `mcp__memory__memory_remember` name is counted (T4-CODEX pre-audit)', () => {
  // 36 hits across 50 sampled transcripts in ~/.claude/projects/, per
  // T4-CODEX [STATUS.md L121-166]. Pinning the legacy name keeps v2 from
  // undercounting facts_extracted on existing real-user transcripts.
  const raw = line({
    timestamp: '2026-05-04T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__memory__memory_remember', id: 't1' }] },
  });
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.factsExtracted, 1);
});

test('FACT_TOOL_NAMES export contains all three accepted names', () => {
  assert.ok(FACT_TOOL_NAMES instanceof Set, 'FACT_TOOL_NAMES is a Set');
  assert.ok(FACT_TOOL_NAMES.has('memory_remember'));
  assert.ok(FACT_TOOL_NAMES.has('mcp__mnestra__memory_remember'));
  assert.ok(FACT_TOOL_NAMES.has('mcp__memory__memory_remember'));
  assert.equal(FACT_TOOL_NAMES.size, 3);
});

test('an unrelated tool_use with `_remember` substring is NOT counted', () => {
  // Defensive: the heuristic is exact-match against FACT_TOOL_NAMES, NOT a
  // substring/regex on the tool name. Future tools named e.g. "remember_me"
  // or "team_member" must not accidentally inflate the count.
  const raw = [
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'remember_me', id: 't1' }] } }),
    line({ timestamp: '2026-05-04T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'team_member', id: 't2' }] } }),
    line({ timestamp: '2026-05-04T10:02:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'memory_recall', id: 't3' }] } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.factsExtracted, 0);
});

test('tool_result blocks (not tool_use) are not counted even if named memory_remember', () => {
  // The hook's facts_extracted semantic is "facts the assistant tried to
  // commit during this session" — that's the tool_use shape. tool_result
  // is the response coming back, never the trigger.
  const raw = line({
    timestamp: '2026-05-04T10:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'memory_remember' }] },
  });
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.factsExtracted, 0);
});

// ── String-content shape (no tool_use blocks possible) ──────────────────────

test('content as string (no array) → no false-positive facts (Remember: in text is ignored)', () => {
  // The conservative heuristic: do NOT string-match "Remember:" inside
  // assistant or user text. Only count explicit tool_use blocks. This
  // prevents the "Joshua quoted 'Remember:' in his prompt" false positive.
  const raw = [
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'user', content: 'Remember: this should not count.' } }),
    line({ timestamp: '2026-05-04T10:01:00.000Z', message: { role: 'assistant', content: 'I will Remember: this conversation.' } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.factsExtracted, 0);
});

// ── Timestamp fallback: msg.message.timestamp ───────────────────────────────

test('fallback to msg.message.timestamp when top-level missing', () => {
  // Some adapter shapes nest the timestamp under message.timestamp instead
  // of at the top of the JSONL record. Forward-compat for non-Claude
  // adapters; Claude itself uses top-level.
  const raw = [
    line({ message: { role: 'user', content: 'a', timestamp: '2026-05-04T10:00:00.000Z' } }),
    line({ message: { role: 'assistant', content: 'b', timestamp: '2026-05-04T10:30:00.000Z' } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.startedAt, ts('2026-05-04T10:00:00.000Z'));
  assert.equal(meta.endedAt, ts('2026-05-04T10:30:00.000Z'));
  assert.equal(meta.durationMinutes, 30);
});

test('invalid timestamp string → ignored, doesn’t poison earliest/latest', () => {
  // Date.parse returns NaN on garbage; the parser must guard.
  const raw = [
    line({ timestamp: 'not a real timestamp', message: { role: 'user', content: 'a' } }),
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'user', content: 'b' } }),
    line({ timestamp: '2026-05-04T10:30:00.000Z', message: { role: 'user', content: 'c' } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.startedAt, ts('2026-05-04T10:00:00.000Z'));
  assert.equal(meta.endedAt, ts('2026-05-04T10:30:00.000Z'));
});

// ── Real-fixture roundtrip ──────────────────────────────────────────────────

test('fixture roundtrip: trimmed real transcript produces expected metadata', () => {
  // fixtures/transcript-sample.jsonl is 8 lines derived from
  // ~/.claude/projects/...0628fdf2.../03b55630... real transcripts:
  //   - all `<scrubbed>` user/assistant text (no real content)
  //   - 3 tool_use lines: mcp__mnestra__memory_remember,
  //     mcp__memory__memory_remember (legacy), bare memory_remember
  //   - 1 tool_use Bash line (must NOT inflate factsExtracted)
  //   - 1 tool_result line (must NOT inflate factsExtracted)
  //   - first message at 10:00:00.000Z, last at 10:15:00.000Z
  // Expected metadata: span 15 min, 3 facts.
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.startedAt, ts('2026-05-04T10:00:00.000Z'));
  assert.equal(meta.endedAt, ts('2026-05-04T10:15:00.000Z'));
  assert.equal(meta.durationMinutes, 15);
  assert.equal(meta.factsExtracted, 3);
});

// ── Multi-adapter content shapes (T4-CODEX 11:13 ET catch) ─────────────────
//
// The hook ships parsers for Claude / Codex / Gemini / Grok. Each shapes
// its message content differently, and the metadata extractor has to count
// tool_use blocks for ALL of them or facts_extracted under-counts whenever
// a non-Claude session writes to memory_sessions. T4 caught that v1 of my
// parser only handled msg.message.content (Claude). These tests pin the
// flat (Grok) and Codex (response_item.payload.content) shapes too.

test('flat msg.content[] shape (Grok adapter) — tool_use is counted', () => {
  // Grok's transcript JSON envelope writes objects like
  //   { role: 'assistant', content: [...] }
  // (no nested `message` wrapper). T4-CODEX 11:13 ET probe: `factsExtracted=1`
  // when one row uses flat shape and one uses nested — v1 of my parser
  // returned `factsExtracted=1` because the flat row got ignored.
  const raw = [
    line({ timestamp: '2026-05-04T00:00:00.000Z', role: 'assistant', content: [{ type: 'tool_use', name: 'memory_remember', id: 't1' }] }),
    line({ timestamp: '2026-05-04T00:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'memory_remember', id: 't2' }] } }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.factsExtracted, 2);
});

test('Codex response_item shape — tool_use under msg.payload.content[] is counted', () => {
  // Codex JSONL writes one record per response_item. Tool_use blocks live
  // under msg.payload.content[] when msg.type === 'response_item'. The hook
  // already handles this in parseCodexJsonl for summary text; v2 of the
  // metadata extractor does the same for tool_use counting.
  const raw = [
    line({ timestamp: '2026-05-04T00:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__mnestra__memory_remember', id: 't1' }] } }),
    // Mixed: nested + flat + Codex in one transcript.
    line({ timestamp: '2026-05-04T00:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'memory_remember', id: 't2' }] } }),
    line({ timestamp: '2026-05-04T00:02:00.000Z', role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__memory__memory_remember', id: 't3' }] }),
  ].join('\n');
  const meta = parseTranscriptMetadata(raw);
  assert.equal(meta.factsExtracted, 3);
});

test('extractContentBlocks helper handles all four shape variants', () => {
  // Pin the helper directly so future adapter additions land obvious test
  // failures rather than silent under-counts.
  assert.deepEqual(
    extractContentBlocks({ message: { content: [{ type: 'text', text: 'a' }] } }),
    [{ type: 'text', text: 'a' }],
    'Claude nested shape'
  );
  assert.deepEqual(
    extractContentBlocks({ content: [{ type: 'tool_use', name: 'x' }] }),
    [{ type: 'tool_use', name: 'x' }],
    'flat shape (Grok)'
  );
  assert.deepEqual(
    extractContentBlocks({ type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: 'b' }] } }),
    [{ type: 'output_text', text: 'b' }],
    'Codex response_item shape'
  );
  assert.equal(extractContentBlocks(null), null, 'null safety');
  assert.equal(extractContentBlocks({ message: { content: 'string-not-array' } }), null, 'string content (no tool_use possible) is null');
  assert.equal(extractContentBlocks({}), null, 'empty object → null');
});

// ── Duration rounding semantics ─────────────────────────────────────────────

test('duration < 30s rounds to 0 minutes, ≥ 30s rounds up to 1', () => {
  // Math.round((latest - earliest) / 60000)
  const sub30 = parseTranscriptMetadata([
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'user', content: 'a' } }),
    line({ timestamp: '2026-05-04T10:00:29.999Z', message: { role: 'user', content: 'b' } }),
  ].join('\n'));
  assert.equal(sub30.durationMinutes, 0);

  const exact30 = parseTranscriptMetadata([
    line({ timestamp: '2026-05-04T10:00:00.000Z', message: { role: 'user', content: 'a' } }),
    line({ timestamp: '2026-05-04T10:00:30.000Z', message: { role: 'user', content: 'b' } }),
  ].join('\n'));
  assert.equal(exact30.durationMinutes, 1);
});
