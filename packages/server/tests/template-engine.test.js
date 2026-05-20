'use strict';

// Sprint 69 T1 — tests for the boot-prompt template engine.
//
// Covers the contract documented in
// packages/server/src/templates/template-engine.js and STATUS.md PROPOSE:
//
//   - loadTemplate(cliType, role, variables) → string (happy path, override
//     resolution, missing-variable error, unknown-cliType / unknown-role /
//     missing-file errors).
//   - requiredVariables(cliType, role) → string[] (matches the documented
//     variable counts per template).
//   - All 9 v1 templates exist on disk and each declares ≥1 variable.
//   - cc-worker (claude-code-worker) snapshot matches a committed fixture so
//     T4 can verify the rendered shape without re-running the engine.
//
// Run: `node --test packages/server/tests/template-engine.test.js`

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadTemplate,
  requiredVariables,
  TemplateNotFoundError,
  MissingVariableError,
  SUPPORTED_CLI_TYPES,
  SUPPORTED_ROLES,
  DEFAULT_TEMPLATE_DIR,
} = require('../src/templates/template-engine');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures + helpers
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const CC_WORKER_SNAPSHOT = path.join(FIXTURES_DIR, 'claude-code-worker.snapshot.txt');

// The full v1 matrix of templates that MUST exist on disk. Codex-orchestrator
// is deliberately absent (deferred per PLANNING §"v1 scope") — see
// `test-08-codex-orchestrator-deferred`.
const TEMPLATE_MATRIX = Object.freeze([
  ['claude-code', 'worker'],
  ['claude-code', 'auditor'],
  ['claude-code', 'orchestrator'],
  ['codex', 'worker'],
  ['codex', 'auditor'],
  ['gemini', 'worker'],
  ['gemini', 'auditor'],
  ['grok', 'worker'],
  ['grok', 'auditor'],
]);

// Snapshot variables for the cc-worker render. Kept stable across runs so
// the fixture comparison is meaningful. If a template body is intentionally
// changed, regenerate the fixture (smoke script in the engine source).
const SNAPSHOT_VARS = Object.freeze({
  lane_tag: 'T1',
  sprint_name: 'Sprint 69 (Orchestration Hardening)',
  project_name: 'termdeck',
  project_path: '/Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck',
  memory_query_lane: 'Sprint 69 template engine boot-prompt boilerplate',
  memory_query_broad: 'recent decisions 3+1+1 orchestration kitchen-lessons',
  sprint_dir: 'docs/sprint-69-orchestration-hardening',
  lane_brief: 'T1-template-engine.md',
  cross_lane_intel: 'Cross-lane: T2 (Codex) consumes your exported engine; T3 (Gemini) builds parked detection; T4 (Grok) audits independently.',
  test_command: 'npm test',
  baseline_suite_result: '391 pass / 0 fail',
});

// Set TERMDECK_TEMPLATES_OVERRIDE_DIR to `dir`, restoring the previous
// value (or unset) on cleanup. Returns a cleanup function so tests can
// pair with try/finally.
function withOverrideDir(dir) {
  const previous = process.env.TERMDECK_TEMPLATES_OVERRIDE_DIR;
  process.env.TERMDECK_TEMPLATES_OVERRIDE_DIR = dir;
  return function restore() {
    if (previous === undefined) {
      delete process.env.TERMDECK_TEMPLATES_OVERRIDE_DIR;
    } else {
      process.env.TERMDECK_TEMPLATES_OVERRIDE_DIR = previous;
    }
  };
}

// Build a fully-populated `variables` payload for a given (cli, role) so
// non-snapshot tests don't have to enumerate every required field by hand.
function fillRequired(cli, role, overrides = {}) {
  const required = requiredVariables(cli, role);
  const vars = {};
  for (const k of required) vars[k] = `<filled-${k}>`;
  return Object.assign(vars, overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — claude-code/worker
// ─────────────────────────────────────────────────────────────────────────────

test('loadTemplate(claude-code/worker) substitutes every snapshot variable', () => {
  const rendered = loadTemplate('claude-code', 'worker', SNAPSHOT_VARS);

  // Specific substrings rather than full-string equality — more robust to
  // intentional template tweaks (the snapshot test covers full equality).
  assert.match(rendered, /^You are T1 in Sprint 69 \(Orchestration Hardening\)/);
  assert.ok(
    rendered.includes('memory_recall(project="termdeck", query="Sprint 69 template engine boot-prompt boilerplate")'),
    'memory_recall line 1 should substitute project_name + memory_query_lane'
  );
  assert.ok(
    rendered.includes('Read docs/sprint-69-orchestration-hardening/T1-template-engine.md'),
    'lane_brief path should substitute correctly'
  );
  assert.ok(
    rendered.includes('### [T1] FINDING / PROPOSE / LANDED / DONE'),
    'discipline post template should embed lane_tag'
  );
  assert.ok(
    rendered.includes('`npm test` ≤ baseline 391 pass / 0 fail'),
    'test_command + baseline_suite_result should substitute on one line'
  );
  assert.equal(rendered.includes('{{'), false, 'no unsubstituted {{...}} tokens in happy path');
});

// ─────────────────────────────────────────────────────────────────────────────
// Override resolution — env-var dir wins over the in-package default
// ─────────────────────────────────────────────────────────────────────────────

test('TERMDECK_TEMPLATES_OVERRIDE_DIR file wins over the shipped default', () => {
  const tempdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdeng-override-'));
  const overrideTemplate = 'OVERRIDE for {{lane_tag}}\n';
  fs.writeFileSync(path.join(tempdir, 'claude-code-worker.txt'), overrideTemplate, 'utf8');

  const restore = withOverrideDir(tempdir);
  try {
    const rendered = loadTemplate('claude-code', 'worker', { lane_tag: 'T9' });
    assert.equal(rendered, 'OVERRIDE for T9\n');
  } finally {
    restore();
    fs.rmSync(tempdir, { recursive: true, force: true });
  }

  // Sanity: after restoring the env var the engine returns to default lookup.
  const def = loadTemplate('claude-code', 'worker', SNAPSHOT_VARS);
  assert.ok(def.startsWith('You are T1 in Sprint 69'), 'default template returns after env-var cleanup');
});

test('override resolution is per-file: a missing override falls back to the shipped default', () => {
  const tempdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdeng-fallthrough-'));
  // Drop ONLY the worker override; auditor should still pick up the default.
  fs.writeFileSync(path.join(tempdir, 'claude-code-worker.txt'), 'OVERRIDE\n', 'utf8');

  const restore = withOverrideDir(tempdir);
  try {
    const workerRendered = loadTemplate('claude-code', 'worker', { lane_tag: 'Tx' });
    assert.equal(workerRendered, 'OVERRIDE\n', 'worker pulls from override');

    const auditorVars = fillRequired('claude-code', 'auditor');
    const auditorRendered = loadTemplate('claude-code', 'auditor', auditorVars);
    assert.ok(
      auditorRendered.includes('Synchronize on LANDED'),
      'auditor falls through to default when no override on disk'
    );
  } finally {
    restore();
    fs.rmSync(tempdir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error paths — three distinct TemplateNotFoundError classes + MissingVariable
// ─────────────────────────────────────────────────────────────────────────────

test('Unknown cliType throws TemplateNotFoundError naming supported types (lookedUpPaths empty)', () => {
  let caught;
  try { loadTemplate('foobar-cli', 'worker', {}); } catch (e) { caught = e; }
  assert.ok(caught instanceof TemplateNotFoundError, 'wrong error class');
  assert.equal(caught.cliType, 'foobar-cli');
  assert.equal(caught.role, 'worker');
  assert.deepEqual(caught.lookedUpPaths, [], 'validation-error lookedUpPaths should be empty');
  assert.match(caught.message, /Unknown cliType="foobar-cli"/);
  for (const cli of SUPPORTED_CLI_TYPES) {
    assert.ok(caught.message.includes(cli), `error message should mention supported cliType ${cli}`);
  }
});

test('Unknown role throws TemplateNotFoundError naming supported roles (lookedUpPaths empty)', () => {
  let caught;
  try { loadTemplate('claude-code', 'janitor', {}); } catch (e) { caught = e; }
  assert.ok(caught instanceof TemplateNotFoundError, 'wrong error class');
  assert.equal(caught.role, 'janitor');
  assert.deepEqual(caught.lookedUpPaths, [], 'validation-error lookedUpPaths should be empty');
  assert.match(caught.message, /Unknown role="janitor"/);
  for (const role of SUPPORTED_ROLES) {
    assert.ok(caught.message.includes(role), `error message should mention supported role ${role}`);
  }
});

test('codex/orchestrator is deferred — throws TemplateNotFoundError with populated lookedUpPaths', () => {
  // PLANNING §"v1 scope" defers codex-orchestrator (Claude is the only
  // orchestrator-CLI today). The cli + role are both individually valid,
  // so this is the FILE-MISSING failure mode, not a validation failure —
  // lookedUpPaths must name both the override and default candidates so
  // the inject endpoint can report what was probed.
  let caught;
  try { loadTemplate('codex', 'orchestrator', {}); } catch (e) { caught = e; }
  assert.ok(caught instanceof TemplateNotFoundError, 'wrong error class');
  assert.equal(caught.lookedUpPaths.length, 2, 'file-missing lookedUpPaths should have [override, default]');
  assert.ok(
    caught.lookedUpPaths[1].endsWith(path.join('share', 'termdeck', 'templates', 'codex-orchestrator.txt')),
    'second lookedUpPath should be the in-package default'
  );
});

test('MissingVariableError names EVERY unsubstituted token, sorted, not just the first', () => {
  let caught;
  try {
    // Provide ONLY lane_tag; the other 10 should all be reported.
    loadTemplate('claude-code', 'worker', { lane_tag: 'T1' });
  } catch (e) { caught = e; }

  assert.ok(caught instanceof MissingVariableError, 'wrong error class');
  assert.equal(caught.cliType, 'claude-code');
  assert.equal(caught.role, 'worker');
  assert.ok(caught.missingVariables.length >= 10, `expected ≥10 missing variables, got ${caught.missingVariables.length}`);

  // Sorted (alphabetical), deduplicated — these are part of the documented
  // contract so callers can render a stable 400 response body.
  const sorted = [...caught.missingVariables].sort();
  assert.deepEqual(caught.missingVariables, sorted, 'missingVariables must be sorted alphabetically');

  // Several specific names that we know are missing in this fixture.
  for (const name of ['baseline_suite_result', 'cross_lane_intel', 'project_name', 'sprint_name', 'test_command']) {
    assert.ok(caught.missingVariables.includes(name), `expected '${name}' in missingVariables`);
  }
  // The one we DID provide must not appear.
  assert.ok(!caught.missingVariables.includes('lane_tag'), 'lane_tag was provided and must not be reported missing');
});

// ─────────────────────────────────────────────────────────────────────────────
// requiredVariables — pre-scan helper used by T2's inject endpoint
// ─────────────────────────────────────────────────────────────────────────────

test('requiredVariables(claude-code/worker) returns the documented variable set', () => {
  const vars = requiredVariables('claude-code', 'worker');
  const expected = [
    'baseline_suite_result',
    'cross_lane_intel',
    'lane_brief',
    'lane_tag',
    'memory_query_broad',
    'memory_query_lane',
    'project_name',
    'project_path',
    'sprint_dir',
    'sprint_name',
    'test_command',
  ];
  assert.deepEqual(vars, expected);
});

test('requiredVariables(claude-code/auditor) includes audit_tasks (worker variant does not)', () => {
  const auditorVars = requiredVariables('claude-code', 'auditor');
  const workerVars = requiredVariables('claude-code', 'worker');
  assert.ok(auditorVars.includes('audit_tasks'), 'auditor template must request audit_tasks');
  assert.equal(workerVars.includes('audit_tasks'), false, 'worker template must not request audit_tasks');
  assert.ok(
    auditorVars.length === workerVars.length + 1,
    `auditor variable count (${auditorVars.length}) should be worker + 1 (${workerVars.length + 1})`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Matrix coverage — all 9 v1 templates exist + declare ≥1 variable
// ─────────────────────────────────────────────────────────────────────────────

test('all 9 v1 templates exist on disk under packages/server/share/termdeck/templates/', () => {
  for (const [cli, role] of TEMPLATE_MATRIX) {
    const filename = `${cli}-${role}.txt`;
    const expected = path.join(DEFAULT_TEMPLATE_DIR, filename);
    assert.ok(fs.existsSync(expected), `missing template file: ${expected}`);
  }
});

test('each of the 9 v1 templates declares at least one {{variable}}', () => {
  for (const [cli, role] of TEMPLATE_MATRIX) {
    const vars = requiredVariables(cli, role);
    assert.ok(vars.length >= 1, `${cli}/${role} must declare ≥1 variable; got ${vars.length}`);
  }
});

test('Gemini and Grok templates SKIP memory_query_* variables (no Mnestra MCP by default)', () => {
  // The brief documents that Gemini and Grok don't have Mnestra MCP wired
  // by default; their templates must omit memory_recall() / memory_query_*
  // and rely on the self-contained lane brief.
  for (const cli of ['gemini', 'grok']) {
    for (const role of ['worker', 'auditor']) {
      const vars = requiredVariables(cli, role);
      assert.equal(vars.includes('memory_query_lane'), false, `${cli}/${role} must NOT require memory_query_lane`);
      assert.equal(vars.includes('memory_query_broad'), false, `${cli}/${role} must NOT require memory_query_broad`);
    }
  }
  // And the Claude/Codex worker variants MUST include them.
  for (const cli of ['claude-code', 'codex']) {
    const vars = requiredVariables(cli, 'worker');
    assert.ok(vars.includes('memory_query_lane'), `${cli}/worker must require memory_query_lane`);
    assert.ok(vars.includes('memory_query_broad'), `${cli}/worker must require memory_query_broad`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot — full-string equality against a committed fixture
// ─────────────────────────────────────────────────────────────────────────────

test('claude-code-worker render matches the committed snapshot fixture', () => {
  const expected = fs.readFileSync(CC_WORKER_SNAPSHOT, 'utf8');
  const rendered = loadTemplate('claude-code', 'worker', SNAPSHOT_VARS);
  assert.equal(
    rendered,
    expected,
    `Snapshot drift. If the template body change is intentional, regenerate the fixture at ${CC_WORKER_SNAPSHOT}.`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases — empty string vs undefined, extra vars, repeated tokens
// ─────────────────────────────────────────────────────────────────────────────

test('empty-string variable IS a valid substitution (not treated as missing)', () => {
  // The cross_lane_intel slot is sometimes legitimately empty (e.g. when
  // no other lane has shipped yet). The contract: '' substitutes; null and
  // undefined are treated as missing.
  const vars = fillRequired('claude-code', 'worker', { cross_lane_intel: '' });
  const rendered = loadTemplate('claude-code', 'worker', vars);
  assert.equal(rendered.includes('{{cross_lane_intel}}'), false, 'empty string must substitute');
});

test('null and undefined variable values are treated as missing and listed in MissingVariableError', () => {
  const baseVars = fillRequired('claude-code', 'worker');
  baseVars.lane_tag = null;
  baseVars.sprint_name = undefined;

  let caught;
  try { loadTemplate('claude-code', 'worker', baseVars); } catch (e) { caught = e; }
  assert.ok(caught instanceof MissingVariableError);
  assert.ok(caught.missingVariables.includes('lane_tag'), 'null must be reported as missing');
  assert.ok(caught.missingVariables.includes('sprint_name'), 'undefined must be reported as missing');
});

test('extra variables in input are ignored gracefully', () => {
  const vars = fillRequired('claude-code', 'worker', {
    unused_extra_1: 'should not appear',
    unused_extra_2: 'also should not appear',
  });
  const rendered = loadTemplate('claude-code', 'worker', vars);
  assert.equal(rendered.includes('should not appear'), false, 'extra vars must not bleed through');
  assert.equal(rendered.includes('{{'), false, 'render must be complete');
});

test('repeated {{variable}} tokens in a template substitute everywhere', () => {
  // The cc-worker template references {{lane_tag}} multiple times; verify
  // every occurrence is substituted (not just the first match).
  const vars = fillRequired('claude-code', 'worker', { lane_tag: 'T99-UNIQUE' });
  const rendered = loadTemplate('claude-code', 'worker', vars);
  const occurrences = rendered.match(/T99-UNIQUE/g) || [];
  assert.ok(occurrences.length >= 2, `expected lane_tag substituted at ≥2 positions; got ${occurrences.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Type safety — non-string cliType / role rejected at the boundary
// ─────────────────────────────────────────────────────────────────────────────

test('non-string cliType or role throws TemplateNotFoundError instead of returning garbage', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    let caught;
    try { loadTemplate(bad, 'worker', {}); } catch (e) { caught = e; }
    assert.ok(caught instanceof TemplateNotFoundError, `cliType=${typeof bad} should throw TemplateNotFoundError`);
  }
  for (const bad of [null, undefined, 42, {}, []]) {
    let caught;
    try { loadTemplate('claude-code', bad, {}); } catch (e) { caught = e; }
    assert.ok(caught instanceof TemplateNotFoundError, `role=${typeof bad} should throw TemplateNotFoundError`);
  }
});
