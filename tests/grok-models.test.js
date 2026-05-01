// Sprint 45 T3 — Grok model-selection heuristic tests.
//
// Pins the chooseModel(taskHint) table from SPRINT-45-PREP-NOTES.md
// § "Concern 2: Model selection heuristic". The wrong default would silently
// 10x the bill on routine tasks (Heavy reasoning at $2/$6 per 1M tokens vs
// Fast variants at $0.2/$0.5). If any of these tests fail, do NOT loosen
// the assertion — fix grok-models.js or update the SPRINT-45-PREP-NOTES.md
// table first, then re-pin here.
//
// Run: node --test tests/grok-models.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { MODELS, LEGACY_ALIASES, chooseModel, getModelInfo }
  = require('../packages/server/src/agent-adapters/grok-models');

// ─────────────────────────────────────────────────────────────────────────
// MODELS table — symbolic keys must resolve to the canonical model ids
// confirmed live on Joshua's machine 2026-05-01 via `grok models`.
// ─────────────────────────────────────────────────────────────────────────

test('MODELS table covers the 8 canonical tiers', () => {
  assert.equal(MODELS['fast-non-reasoning'], 'grok-4-1-fast-non-reasoning');
  assert.equal(MODELS['fast-reasoning'], 'grok-4-1-fast-reasoning');
  assert.equal(MODELS.code, 'grok-code-fast-1');
  assert.equal(MODELS['reasoning-deep'], 'grok-4.20-0309-reasoning');
  assert.equal(MODELS['reasoning-non-cot'], 'grok-4.20-0309-non-reasoning');
  assert.equal(MODELS['multi-agent'], 'grok-4.20-multi-agent-0309');
  assert.equal(MODELS.flagship, 'grok-4-0709');
  assert.equal(MODELS['budget-compact'], 'grok-3-mini');
});

// ─────────────────────────────────────────────────────────────────────────
// chooseModel — the core heuristic. Each branch pinned independently.
// ─────────────────────────────────────────────────────────────────────────

test('chooseModel: code → grok-code-fast-1', () => {
  assert.equal(chooseModel('code'), 'grok-code-fast-1');
});

test('chooseModel: multi-agent → grok-4.20-multi-agent-0309', () => {
  assert.equal(chooseModel('multi-agent'), 'grok-4.20-multi-agent-0309');
});

test('chooseModel: reasoning-deep → grok-4.20-0309-reasoning (Heavy)', () => {
  assert.equal(chooseModel('reasoning-deep'), 'grok-4.20-0309-reasoning');
});

test('chooseModel: reasoning-quick alias → grok-4-1-fast-reasoning', () => {
  assert.equal(chooseModel('reasoning-quick'), 'grok-4-1-fast-reasoning');
});

test('chooseModel: fast-reasoning → grok-4-1-fast-reasoning', () => {
  assert.equal(chooseModel('fast-reasoning'), 'grok-4-1-fast-reasoning');
});

test('chooseModel: reasoning-non-cot → grok-4.20-0309-non-reasoning', () => {
  assert.equal(chooseModel('reasoning-non-cot'), 'grok-4.20-0309-non-reasoning');
});

test('chooseModel: flagship → grok-4-0709', () => {
  assert.equal(chooseModel('flagship'), 'grok-4-0709');
});

test('chooseModel: budget-compact → grok-3-mini', () => {
  assert.equal(chooseModel('budget-compact'), 'grok-3-mini');
});

// ─────────────────────────────────────────────────────────────────────────
// Default — the headline correctness property. Bill blow-up prevention.
// Anything that isn't an explicit Heavy / multi-agent / flagship hint must
// route to the cheap-fast model.
// ─────────────────────────────────────────────────────────────────────────

test('chooseModel: undefined → cheap-fast default', () => {
  assert.equal(chooseModel(undefined), 'grok-4-1-fast-non-reasoning');
});

test('chooseModel: null → cheap-fast default', () => {
  assert.equal(chooseModel(null), 'grok-4-1-fast-non-reasoning');
});

test('chooseModel: empty string → cheap-fast default', () => {
  assert.equal(chooseModel(''), 'grok-4-1-fast-non-reasoning');
});

test('chooseModel: no argument → cheap-fast default', () => {
  assert.equal(chooseModel(), 'grok-4-1-fast-non-reasoning');
});

test('chooseModel: explicit fast-non-reasoning hint → cheap-fast', () => {
  assert.equal(chooseModel('fast-non-reasoning'), 'grok-4-1-fast-non-reasoning');
});

// ─────────────────────────────────────────────────────────────────────────
// Unknown / typo'd hints fall back to cheap-fast — bill safety. Heavy tier
// must never be reached by accident.
// ─────────────────────────────────────────────────────────────────────────

test('chooseModel: typo "reaonsing-deep" → cheap-fast (NOT Heavy)', () => {
  // Typo'd hint must NOT silently route to Heavy. Cheap-fast is the safe
  // fallback; real Heavy access requires a correctly-spelled hint.
  assert.equal(chooseModel('reaonsing-deep'), 'grok-4-1-fast-non-reasoning');
});

test('chooseModel: arbitrary string → cheap-fast (default)', () => {
  assert.equal(chooseModel('???'), 'grok-4-1-fast-non-reasoning');
  assert.equal(chooseModel('xyz'), 'grok-4-1-fast-non-reasoning');
});

// ─────────────────────────────────────────────────────────────────────────
// Legacy aliases — accepted for back-compat with earlier `grok models`
// outputs (pre-2026-05-01) where Joshua had different ids in his notes.
// ─────────────────────────────────────────────────────────────────────────

test('LEGACY_ALIASES: grok-beta → grok-4.20-0309-reasoning', () => {
  assert.equal(LEGACY_ALIASES['grok-beta'], 'grok-4.20-0309-reasoning');
  assert.equal(chooseModel('grok-beta'), 'grok-4.20-0309-reasoning');
});

test('LEGACY_ALIASES: grok-4.20-multi-agent (no date suffix) → multi-agent-0309', () => {
  assert.equal(chooseModel('grok-4.20-multi-agent'), 'grok-4.20-multi-agent-0309');
});

test('LEGACY_ALIASES: grok-3 → flagship', () => {
  assert.equal(chooseModel('grok-3'), 'grok-4-0709');
});

// ─────────────────────────────────────────────────────────────────────────
// getModelInfo — price-band classifier for Sprint 46 cost annotations.
// ─────────────────────────────────────────────────────────────────────────

test('getModelInfo: cheap tier ($0.2/$0.5) for fast-non-reasoning', () => {
  const info = getModelInfo('grok-4-1-fast-non-reasoning');
  assert.equal(info.tier, 'cheap');
  assert.equal(info.priceIn, 0.2);
  assert.equal(info.priceOut, 0.5);
});

test('getModelInfo: code tier has $1.5 output (premium)', () => {
  const info = getModelInfo('grok-code-fast-1');
  assert.equal(info.tier, 'cheap');
  assert.equal(info.priceIn, 0.2);
  assert.equal(info.priceOut, 1.5);
});

test('getModelInfo: heavy tier ($2/$6)', () => {
  assert.equal(getModelInfo('grok-4.20-0309-reasoning').tier, 'heavy');
  assert.equal(getModelInfo('grok-4.20-multi-agent-0309').tier, 'heavy');
  assert.equal(getModelInfo('grok-4.20-0309-reasoning').priceIn, 2);
  assert.equal(getModelInfo('grok-4.20-0309-reasoning').priceOut, 6);
});

test('getModelInfo: flagship ($3/$15)', () => {
  const info = getModelInfo('grok-4-0709');
  assert.equal(info.tier, 'flagship');
  assert.equal(info.priceIn, 3);
  assert.equal(info.priceOut, 15);
});

test('getModelInfo: unknown model → unknown tier (no throw)', () => {
  const info = getModelInfo('grok-fictional-99');
  assert.equal(info.tier, 'unknown');
  assert.equal(info.priceIn, null);
});
