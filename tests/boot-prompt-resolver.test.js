// Sprint 47 T2 — Tests for the per-agent boot-prompt resolver.
//
// Pins:
//   - VALID_AGENTS exports the four supported agents
//   - resolveBootPrompt() picks the right template file per agent name
//   - All Mustache-style {{var.path}} placeholders interpolate against the
//     provided vars object
//   - Missing variables throw with a diagnostic dotted-path message
//   - Unknown agent throws with the four valid options listed
//   - Each shipped template references its agent's instructional file
//     (CLAUDE.md / AGENTS.md / GEMINI.md) — guards against accidental
//     copy-paste drift between templates
//   - The hand-rolled interpolator handles repeated placeholders, nested
//     paths, and whitespace inside the braces
//
// Run: node --test tests/boot-prompt-resolver.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveBootPrompt,
  VALID_AGENTS,
  DEFAULT_TEMPLATE_DIR,
  _interpolate,
  _resolveDotted,
} = require('../packages/server/src/boot-prompt-resolver');

// ─────────────────────────────────────────────────────────────────────────
// Fixtures — a fully-populated vars object that satisfies every placeholder
// in every shipped template. Tests that exercise missing-variable behavior
// build subsets of this.
// ─────────────────────────────────────────────────────────────────────────

const FULL_VARS = {
  lane: {
    tag: 'T2',
    project: 'termdeck',
    topic: 'Sprint 47 boot-prompt resolver',
    briefing: 'T2-boot-prompt-templates.md',
  },
  sprint: {
    n: 47,
    name: 'mixed-4plus1',
    docPath: 'docs/sprint-47-mixed-4plus1',
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Module surface
// ─────────────────────────────────────────────────────────────────────────

test('VALID_AGENTS exports the four supported agents', () => {
  assert.deepEqual(VALID_AGENTS, ['claude', 'codex', 'gemini', 'grok']);
});

test('DEFAULT_TEMPLATE_DIR points at docs/multi-agent-substrate/boot-prompts', () => {
  assert.match(
    DEFAULT_TEMPLATE_DIR,
    /docs\/multi-agent-substrate\/boot-prompts$/
  );
  assert.ok(
    fs.existsSync(DEFAULT_TEMPLATE_DIR),
    `expected template dir to exist: ${DEFAULT_TEMPLATE_DIR}`
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Per-agent template selection — the right template loads for each agent
// ─────────────────────────────────────────────────────────────────────────

test('resolveBootPrompt(claude) loads boot-prompt-claude.md', () => {
  const out = resolveBootPrompt('claude', FULL_VARS);
  assert.match(out, /CLAUDE\.md/);
  assert.match(out, /\.claude\/CLAUDE\.md/); // global rules file path
});

test('resolveBootPrompt(codex) loads boot-prompt-codex.md (references AGENTS.md)', () => {
  const out = resolveBootPrompt('codex', FULL_VARS);
  assert.match(out, /AGENTS\.md/);
  assert.match(out, /Codex CLI/);
  // Negative: must NOT reference Claude's instructional file as the primary
  assert.doesNotMatch(out, /Read.*\/CLAUDE\.md \(project router\)/);
});

test('resolveBootPrompt(gemini) loads boot-prompt-gemini.md (references GEMINI.md)', () => {
  const out = resolveBootPrompt('gemini', FULL_VARS);
  assert.match(out, /GEMINI\.md/);
  assert.match(out, /Gemini CLI/);
  assert.doesNotMatch(out, /AGENTS\.md/);
});

test('resolveBootPrompt(grok) loads boot-prompt-grok.md (references AGENTS.md)', () => {
  const out = resolveBootPrompt('grok', FULL_VARS);
  assert.match(out, /AGENTS\.md/);
  assert.match(out, /Grok CLI/);
});

// ─────────────────────────────────────────────────────────────────────────
// Placeholder interpolation — full vars produces no remaining {{...}} literals
// ─────────────────────────────────────────────────────────────────────────

test('all four templates fully interpolate with FULL_VARS (no {{...}} remaining)', () => {
  for (const agent of VALID_AGENTS) {
    const out = resolveBootPrompt(agent, FULL_VARS);
    assert.doesNotMatch(
      out,
      /\{\{[^}]+\}\}/,
      `${agent} template left an un-interpolated placeholder`
    );
    // Sanity: every var value should appear at least once in the output for
    // the templates that reference it.
    assert.match(out, /T2/, `${agent}: lane.tag should interpolate`);
    assert.match(out, /Sprint 47/, `${agent}: sprint.n should interpolate`);
    assert.match(out, /mixed-4plus1/, `${agent}: sprint.name should interpolate`);
    assert.match(out, /docs\/sprint-47-mixed-4plus1/, `${agent}: sprint.docPath`);
    assert.match(out, /T2-boot-prompt-templates\.md/, `${agent}: lane.briefing`);
    assert.match(out, /termdeck/, `${agent}: lane.project`);
    assert.match(out, /Sprint 47 boot-prompt resolver/, `${agent}: lane.topic`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Error handling — unknown agent + missing variables
// ─────────────────────────────────────────────────────────────────────────

test('unknown agent throws with the four valid options listed', () => {
  assert.throws(
    () => resolveBootPrompt('gpt5', FULL_VARS),
    (err) => {
      assert.match(err.message, /Unknown agent: gpt5/);
      assert.match(err.message, /claude/);
      assert.match(err.message, /codex/);
      assert.match(err.message, /gemini/);
      assert.match(err.message, /grok/);
      return true;
    }
  );
});

test('missing top-level variable throws with dotted path', () => {
  // No `lane` key at all → first encountered placeholder under lane.* should
  // throw with that dotted path.
  assert.throws(
    () => resolveBootPrompt('claude', { sprint: FULL_VARS.sprint }),
    /Missing variable: lane\./
  );
});

test('missing nested variable throws with dotted path', () => {
  const partial = {
    lane: { tag: 'T1', project: 'termdeck', topic: 'foo' /* briefing missing */ },
    sprint: FULL_VARS.sprint,
  };
  assert.throws(
    () => resolveBootPrompt('claude', partial),
    /Missing variable: lane\.briefing/
  );
});

test('null variable value is treated as missing', () => {
  const withNull = {
    lane: { ...FULL_VARS.lane, tag: null },
    sprint: FULL_VARS.sprint,
  };
  assert.throws(
    () => resolveBootPrompt('claude', withNull),
    /Missing variable: lane\.tag/
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Hand-rolled interpolator — placeholder edge cases
// ─────────────────────────────────────────────────────────────────────────

test('_interpolate handles repeated placeholders', () => {
  const out = _interpolate(
    'lane={{lane.tag}} again={{lane.tag}} and={{lane.tag}}',
    { lane: { tag: 'T3' } }
  );
  assert.equal(out, 'lane=T3 again=T3 and=T3');
});

test('_interpolate handles whitespace inside braces', () => {
  const out = _interpolate('hi {{ lane.tag }} bye', { lane: { tag: 'T1' } });
  assert.equal(out, 'hi T1 bye');
});

test('_interpolate coerces numeric/non-string values to strings', () => {
  const out = _interpolate('Sprint {{sprint.n}}', { sprint: { n: 47 } });
  assert.equal(out, 'Sprint 47');
});

test('_resolveDotted returns undefined for missing path (not throw)', () => {
  assert.equal(_resolveDotted({}, 'a.b.c'), undefined);
  assert.equal(_resolveDotted({ a: { b: 1 } }, 'a.b.c'), undefined);
  assert.equal(_resolveDotted({ a: { b: 1 } }, 'a.b'), 1);
});

// ─────────────────────────────────────────────────────────────────────────
// Custom templateDir — tests inject a tmp dir to confirm the option is honored
// (also documents the pattern Sprint 47 T3 will use to inject test fixtures).
// ─────────────────────────────────────────────────────────────────────────

test('templateDir option overrides the default location', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-prompt-test-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'boot-prompt-claude.md'),
      'CUSTOM {{lane.tag}} / Sprint {{sprint.n}}'
    );
    const out = resolveBootPrompt('claude', FULL_VARS, { templateDir: tmp });
    assert.equal(out, 'CUSTOM T2 / Sprint 47');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
