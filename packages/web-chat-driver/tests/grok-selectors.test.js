// Browser-free unit tests for grok selector self-heal — Sprint 72 T3.
// Exercises the PURE pieces (parseAriaSnapshot + selfHeal) against saved
// grok.com ARIA-snapshot fixtures. No Playwright / no live browser needed.
//   run: node --test packages/web-chat-driver/test/grok-selectors.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseAriaSnapshot,
  selfHeal,
  GROK_SELECTORS,
  SELF_HEAL_HINTS,
} = require('../src/grok/selectors');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const IDLE = fx('grok-aria-idle.txt');
const GENERATING = fx('grok-aria-generating.txt');

test('parseAriaSnapshot extracts role+name pairs from a real snapshot', () => {
  const nodes = parseAriaSnapshot(IDLE);
  assert.ok(nodes.length >= 6, 'expected several nodes');
  assert.ok(nodes.some((n) => n.role === 'textbox' && /ask grok/i.test(n.name)), 'composer textbox');
  assert.ok(nodes.some((n) => n.role === 'button' && n.name === 'Send'), 'send button');
  assert.ok(nodes.some((n) => n.role === 'log' && n.name === ''), 'unnamed log container');
});

test('parseAriaSnapshot tolerates empty / non-snapshot / null input', () => {
  assert.deepEqual(parseAriaSnapshot(''), []);
  assert.deepEqual(parseAriaSnapshot(null), []);
  assert.deepEqual(parseAriaSnapshot('just some prose\nnot a tree'), []);
});

test('selfHeal recovers composer / send / copy from the idle tree', () => {
  const composer = selfHeal(IDLE, 'composer');
  assert.equal(composer.role, 'textbox');
  assert.match(composer.name, /ask grok/i);

  const send = selfHeal(IDLE, 'send');
  assert.equal(send.role, 'button');
  assert.match(send.name, /send/i);

  const copy = selfHeal(IDLE, 'copyAffordance');
  assert.equal(copy.role, 'button');
  assert.match(copy.name, /copy|regenerate/i);
});

test('selfHeal returns null for stop when idle (no stop button present)', () => {
  assert.equal(selfHeal(IDLE, 'stop'), null);
});

test('selfHeal recovers the stop button from the generating tree', () => {
  const stop = selfHeal(GENERATING, 'stop');
  assert.ok(stop, 'expected a stop match');
  assert.equal(stop.role, 'button');
  assert.match(stop.name, /stop/i);
});

test('selfHeal matches an unnamed structural container (responseContainer)', () => {
  const rc = selfHeal(IDLE, 'responseContainer');
  assert.ok(rc, 'expected a container match');
  assert.ok(['log', 'main', 'region', 'feed'].includes(rc.role));
});

test('selfHeal accepts a pre-parsed node list as well as raw text', () => {
  const nodes = parseAriaSnapshot(IDLE);
  const send = selfHeal(nodes, 'send');
  assert.equal(send.role, 'button');
  assert.match(send.name, /send/i);
});

test('every catalog target has a self-heal hint (no orphan targets)', () => {
  for (const key of Object.keys(GROK_SELECTORS)) {
    assert.ok(SELF_HEAL_HINTS[key], `missing self-heal hint for "${key}"`);
  }
});

test('catalog strategies are well-formed (known kinds only)', () => {
  const kinds = new Set(['testid', 'role', 'label', 'placeholder', 'css']);
  for (const [key, list] of Object.entries(GROK_SELECTORS)) {
    assert.ok(Array.isArray(list) && list.length > 0, `${key} has strategies`);
    for (const s of list) {
      assert.ok(kinds.has(s.kind), `${key}: unknown kind ${s.kind}`);
      if (s.kind === 'role') assert.ok(typeof s.role === 'string', `${key}: role needs a role name`);
    }
  }
});
