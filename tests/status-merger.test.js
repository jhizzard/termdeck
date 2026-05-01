// Sprint 47 T4 — Cross-agent STATUS.md merger contract test.
//
// Pins mergeStatusLine() against the four input shapes the merger is
// expected to normalize: canonical Claude (pass-through), Codex emoji
// prefix, Gemini bullet idiom, and Grok free-form prose. Real Sprint 46
// STATUS.md lines are lifted as Claude-shape fixtures so the canonical
// branch survives any future tweak to body punctuation.
//
// Run: node --test tests/status-merger.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeStatusLine } = require('../packages/server/src/status-merger');

// Deterministic timestamp seam — every non-pass-through path uses opts.now
// so test output is snapshot-stable regardless of when the suite runs.
const FIXED_NOW = new Date(2026, 4, 1, 16, 11); // 2026-05-01 16:11 local
const TS = '2026-05-01 16:11 ET';

// ── 1. Canonical Claude pass-through ──

test('canonical: real Sprint 46 T1 FIX-PROPOSED line passes through unchanged', () => {
  const real =
    '- T1: FIX-PROPOSED — Surface 6 node-hover tooltip: `mouseenter` on circles now calls a new `showNodeTooltip(event, node)` (graph.js:760) — em-dashes inside the body do not break splitting — 2026-05-01 15:34 ET';
  assert.equal(mergeStatusLine(real), real);
});

test('canonical: real Sprint 46 T3 FIX-PROPOSED line passes through unchanged', () => {
  const real =
    '- T3: FIX-PROPOSED — Client-side renderer fixes: `renderRecentTranscripts` reads `sess.chunks` directly (DESC→reverse, slice top-6 for preview); `renderSearchResults` reads `result.timestamp || result.created_at` with `Date.getTime()` validity check. Server stays untouched. — 2026-05-01 15:27 ET';
  assert.equal(mergeStatusLine(real), real);
});

test('canonical: line missing leading "- " gets it prepended', () => {
  const without = 'T2: DONE — flashback-history audit complete — 2026-05-01 15:38 ET';
  const expected =
    '- T2: DONE — flashback-history audit complete — 2026-05-01 15:38 ET';
  assert.equal(mergeStatusLine(without), expected);
});

test('canonical: "*" bullet variant normalizes to "- "', () => {
  const star = '* T4: FINDING — boot complete — 2026-05-01 16:11 ET';
  const expected = '- T4: FINDING — boot complete — 2026-05-01 16:11 ET';
  assert.equal(mergeStatusLine(star), expected);
});

test('canonical: missing timestamp gets one synthesized from opts.now', () => {
  const noTs = '- T2: FINDING — flashback funnel matches SQLite exactly';
  const expected =
    '- T2: FINDING — flashback funnel matches SQLite exactly — 2026-05-01 16:11 ET';
  assert.equal(mergeStatusLine(noTs, { now: FIXED_NOW }), expected);
});

// ── 2. Codex emoji-prefixed idiom ──

test('codex emoji: 🔍 Found: → FINDING with synthesized timestamp', () => {
  const raw = '🔍 Found: registry exposes 4 adapters but only 3 binaries on PATH';
  const out = mergeStatusLine(raw, { laneTag: 'T1', now: FIXED_NOW });
  assert.equal(
    out,
    `- T1: FINDING — registry exposes 4 adapters but only 3 binaries on PATH — ${TS}`,
  );
});

test('codex emoji: ✅ Fixed: → DONE', () => {
  const raw = '✅ Fixed: regex anchor now uses /^${escapeRegExp(binary)}\\b/';
  const out = mergeStatusLine(raw, { laneTag: 'T3', now: FIXED_NOW });
  assert.equal(
    out,
    `- T3: DONE — regex anchor now uses /^${'$'}{escapeRegExp(binary)}\\b/ — ${TS}`,
  );
});

test('codex emoji: 🛠 Proposed: → FIX-PROPOSED', () => {
  const raw = '🛠 Proposed: extract launcher-resolver into its own module';
  const out = mergeStatusLine(raw, { laneTag: 'T4', now: FIXED_NOW });
  assert.equal(
    out,
    `- T4: FIX-PROPOSED — extract launcher-resolver into its own module — ${TS}`,
  );
});

test('codex emoji: 🛠️ (with VS-16 variation selector) also maps to FIX-PROPOSED', () => {
  const raw = '🛠️ Proposed: same emoji, with VS-16 — must also route correctly';
  const out = mergeStatusLine(raw, { laneTag: 'T1', now: FIXED_NOW });
  assert.match(out, /^- T1: FIX-PROPOSED — same emoji, with VS-16/);
});

// ── 3. Gemini bullet idiom ──

test('gemini bullet: "- found that …" → FINDING', () => {
  const raw = '- found that getLaneAgent defaults to claude when no field present';
  const out = mergeStatusLine(raw, { laneTag: 'T1', now: FIXED_NOW });
  assert.equal(
    out,
    `- T1: FINDING — getLaneAgent defaults to claude when no field present — ${TS}`,
  );
});

test('gemini bullet: "- proposing fix: …" → FIX-PROPOSED', () => {
  const raw = '- proposing fix: hand-rolled YAML subset parser, no js-yaml dep';
  const out = mergeStatusLine(raw, { laneTag: 'T1', now: FIXED_NOW });
  assert.equal(
    out,
    `- T1: FIX-PROPOSED — hand-rolled YAML subset parser, no js-yaml dep — ${TS}`,
  );
});

test('gemini bullet: "- done: …" → DONE', () => {
  const raw = '- done: 12 tests pass, all four templates interpolate cleanly';
  const out = mergeStatusLine(raw, { laneTag: 'T2', now: FIXED_NOW });
  assert.equal(
    out,
    `- T2: DONE — 12 tests pass, all four templates interpolate cleanly — ${TS}`,
  );
});

// ── 4. Grok free-form prose idiom ──

test('grok prose: "I noticed …" → FINDING', () => {
  const raw = 'I noticed the bracketed-paste pattern works fine for the Codex TUI';
  const out = mergeStatusLine(raw, { laneTag: 'T3', now: FIXED_NOW });
  assert.equal(
    out,
    `- T3: FINDING — the bracketed-paste pattern works fine for the Codex TUI — ${TS}`,
  );
});

test('grok prose: "I\'ll fix this by …" → FIX-PROPOSED', () => {
  const raw = "I'll fix this by adding chunked-stdin fallback when paste fails";
  const out = mergeStatusLine(raw, { laneTag: 'T3', now: FIXED_NOW });
  assert.equal(
    out,
    `- T3: FIX-PROPOSED — adding chunked-stdin fallback when paste fails — ${TS}`,
  );
});

test('grok prose: "Done: …" → DONE', () => {
  const raw = 'Done: mixed-agent dispatch wired through sprint-inject.js';
  const out = mergeStatusLine(raw, { laneTag: 'T3', now: FIXED_NOW });
  assert.equal(
    out,
    `- T3: DONE — mixed-agent dispatch wired through sprint-inject.js — ${TS}`,
  );
});

test('grok prose: garbage that matches no keyword falls through to null', () => {
  assert.equal(mergeStatusLine('the cat sat on the mat', { laneTag: 'T3' }), null);
  assert.equal(mergeStatusLine('hello world', { laneTag: 'T3' }), null);
});

// ── 5. Edge cases ──

test('edge: empty / whitespace-only line returns null', () => {
  assert.equal(mergeStatusLine(''), null);
  assert.equal(mergeStatusLine('   '), null);
  assert.equal(mergeStatusLine('\n'), null);
});

test('edge: markdown section header returns null', () => {
  assert.equal(mergeStatusLine('### T1 — Frontmatter parser + lane.agent validation'), null);
  assert.equal(mergeStatusLine('## Lane status'), null);
  assert.equal(mergeStatusLine('# Sprint 47'), null);
});

test('edge: meta-bracket lines (italic stub, blockquote) return null', () => {
  assert.equal(mergeStatusLine('_(no entries yet)_'), null);
  assert.equal(mergeStatusLine('> orchestrator note'), null);
});

test('edge: non-string input returns null without throwing', () => {
  assert.equal(mergeStatusLine(null), null);
  assert.equal(mergeStatusLine(undefined), null);
  assert.equal(mergeStatusLine(42), null);
  assert.equal(mergeStatusLine({}), null);
});

// ── 6. Deterministic timestamp injection ──

test('deterministic: opts.now pins the appended timestamp exactly', () => {
  const out = mergeStatusLine('🔍 Found: a thing', {
    laneTag: 'T2',
    now: new Date(2026, 5, 14, 9, 5), // 2026-06-14 09:05
  });
  assert.equal(out, '- T2: FINDING — a thing — 2026-06-14 09:05 ET');
});

test('deterministic: lane tag falls back to T? when neither input nor opts supply one', () => {
  const out = mergeStatusLine('🔍 Found: orphan finding', { now: FIXED_NOW });
  assert.equal(out, `- T?: FINDING — orphan finding — ${TS}`);
});

test('summary: very long input gets trimmed to ~120 chars with ellipsis', () => {
  const long = 'I noticed ' + 'a'.repeat(200);
  const out = mergeStatusLine(long, { laneTag: 'T1', now: FIXED_NOW });
  // Summary portion lives between the second " — " and " — 2026-…"
  const m = /^- T1: FINDING — (.+) — 2026/.exec(out);
  assert.ok(m, `expected canonical shape, got: ${out}`);
  assert.ok(m[1].length <= 120, `summary too long: ${m[1].length}`);
  assert.ok(m[1].endsWith('…'), 'expected trailing ellipsis on truncation');
});
