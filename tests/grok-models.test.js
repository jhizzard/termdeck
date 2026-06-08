// Grok model selection — ADDITIVE merge (Sprint 45 api.x.ai lineup + Sprint 70 Grok Build).
//
// Per Joshua's directive (2026-06-07): the reasoning models are RETAINED, Grok
// Build is added as an OPTION. These tests pin BOTH families: the api.x.ai
// reasoning/legacy lineup (reasoningEffort-capable, per-token tiers) AND the
// Grok Build models (reasoningEffort rejected → 400, subscription-billed).
//
// Run: node --test tests/grok-models.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODELS, DEFAULT_MODEL, LEGACY_ALIASES,
  chooseModel, getModelInfo, acceptsReasoningEffort, sanitizeModelOptions,
} = require('../packages/server/src/agent-adapters/grok-models.js');

// ── both families present (reasoning models NOT deleted) ──
test('MODELS retains the api.x.ai reasoning/legacy lineup', () => {
  assert.equal(MODELS['reasoning-deep'], 'grok-4.20-0309-reasoning');
  assert.equal(MODELS['fast-reasoning'], 'grok-4-1-fast-reasoning');
  assert.equal(MODELS['reasoning-non-cot'], 'grok-4.20-0309-non-reasoning');
  assert.equal(MODELS['multi-agent'], 'grok-4.20-multi-agent-0309');
  assert.equal(MODELS['flagship'], 'grok-4-0709');
  assert.equal(MODELS['fast-non-reasoning'], 'grok-4-1-fast-non-reasoning');
  assert.equal(MODELS['code'], 'grok-code-fast-1');
  assert.equal(MODELS['budget-compact'], 'grok-3-mini');
});

test('MODELS adds the Grok Build family as options', () => {
  assert.equal(MODELS['build'], 'grok-build');
  assert.equal(MODELS['composer-fast'], 'grok-composer-2.5-fast');
});

test('at least one grok-4.x id is retained AND grok-build is added', () => {
  const ids = Object.values(MODELS);
  assert.ok(ids.some((id) => /grok-4/.test(id)), 'a grok-4.x reasoning id must remain');
  assert.ok(ids.includes('grok-build'), 'grok-build must be added');
});

// ── default preserved (legacy cheap-fast, NOT grok-build) ──
test('DEFAULT_MODEL is the legacy cheap-fast api.x.ai model', () => {
  assert.equal(DEFAULT_MODEL, 'grok-4-1-fast-non-reasoning');
  assert.equal(chooseModel(), 'grok-4-1-fast-non-reasoning');
  assert.equal(chooseModel(undefined), 'grok-4-1-fast-non-reasoning');
  assert.equal(chooseModel(''), 'grok-4-1-fast-non-reasoning');
});

// ── chooseModel routes across both families ──
test('chooseModel routes api.x.ai hints', () => {
  assert.equal(chooseModel('reasoning-deep'), 'grok-4.20-0309-reasoning');
  assert.equal(chooseModel('fast-reasoning'), 'grok-4-1-fast-reasoning');
  assert.equal(chooseModel('code'), 'grok-code-fast-1');
  assert.equal(chooseModel('flagship'), 'grok-4-0709');
  assert.equal(chooseModel('multi-agent'), 'grok-4.20-multi-agent-0309');
});

test('chooseModel routes Grok Build hints (opt-in)', () => {
  assert.equal(chooseModel('build'), 'grok-build');
  assert.equal(chooseModel('grok-build'), 'grok-build');
  assert.equal(chooseModel('composer'), 'grok-composer-2.5-fast');
  assert.equal(chooseModel('compose'), 'grok-composer-2.5-fast');
});

test('chooseModel: unknown/typo hint falls back to default (no throw)', () => {
  assert.equal(chooseModel('totally-unknown-hint'), 'grok-4-1-fast-non-reasoning');
});

test('LEGACY_ALIASES resolve to real models', () => {
  assert.equal(LEGACY_ALIASES['grok-beta'], MODELS['reasoning-deep']);
  assert.equal(LEGACY_ALIASES['grok-3'], MODELS['flagship']);
});

// ── per-family reasoningEffort (the load-bearing guard) ──
test('reasoning models ACCEPT reasoningEffort; Grok Build REJECTS it', () => {
  assert.equal(acceptsReasoningEffort('grok-4.20-0309-reasoning'), true);
  assert.equal(acceptsReasoningEffort('grok-4-1-fast-reasoning'), true);
  assert.equal(acceptsReasoningEffort('grok-4-1-fast-non-reasoning'), true);
  assert.equal(acceptsReasoningEffort('grok-build'), false);
  assert.equal(acceptsReasoningEffort('grok-composer-2.5-fast'), false);
});

test('sanitizeModelOptions strips reasoningEffort ONLY for Grok Build', () => {
  const b = sanitizeModelOptions('grok-build', { reasoningEffort: 'high', temperature: 0.2 });
  assert.equal(b.reasoningEffort, undefined);
  assert.equal(b.temperature, 0.2);
  const b2 = sanitizeModelOptions('grok-composer-2.5-fast', { reasoning_effort: 'low' });
  assert.equal(b2.reasoning_effort, undefined);
  const r = sanitizeModelOptions('grok-4.20-0309-reasoning', { reasoningEffort: 'high' });
  assert.equal(r.reasoningEffort, 'high'); // reasoning model keeps it
});

test('sanitizeModelOptions never mutates the caller object', () => {
  const orig = { reasoningEffort: 'high' };
  sanitizeModelOptions('grok-build', orig);
  assert.equal(orig.reasoningEffort, 'high');
});

// ── getModelInfo: tiers + capability ──
test('getModelInfo: reasoning model = heavy tier + reasoningEffort true', () => {
  const i = getModelInfo('grok-4.20-0309-reasoning');
  assert.equal(i.tier, 'heavy');
  assert.equal(i.priceIn, 2);
  assert.equal(i.reasoningEffort, true);
  assert.equal(i.known, true);
});

test('getModelInfo: grok-build = subscription + reasoningEffort false', () => {
  const i = getModelInfo('grok-build');
  assert.equal(i.tier, 'subscription');
  assert.equal(i.priceIn, null);
  assert.equal(i.reasoningEffort, false);
  assert.equal(i.known, true);
});

test('getModelInfo: unknown id is a safe record (no throw)', () => {
  const i = getModelInfo('grok-9-imaginary');
  assert.equal(i.known, false);
  assert.equal(i.tier, 'unknown');
});
