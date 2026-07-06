// Sprint 81 T4 — doctrine/checks.js starter suite (frontmatter-present +
// one-principle-shape) + parseFrontmatter. BEHAVIOR tests (not file-existence)
// per INSTALLER-PITFALLS ledger #16, in the canonical packages/server/tests/
// glob (a repo-root tests/ dir silently never runs). The render→checks contract
// is exercised against real renderDoctrineMarkdown output, not hand-rolled docs.
//
// Run: node --test packages/server/tests/doctrine-checks.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const checks = require('../../../doctrine/checks');
const render = require('../../../doctrine/render');

function sampleRow(overrides = {}) {
  return Object.assign({
    id: '12345678-abcd-4ef0-8123-456789abcdef',
    title: 'Auditors must post CHECKPOINT every 15 minutes',
    doctrine_text: 'A Codex auditor panel that compacts mid-sprint loses in-context audit state; a CHECKPOINT every 15 minutes lets it self-orient from STATUS.md.',
    occurrence_count: 8,
    projects: ['termdeck', 'forecede'],
    origin: 'doctrine-scan',
    evidence: [{ date: '2026-05-21', gist: 'auditor compacted mid-sprint' }],
    trigger_hints: ['sprint-audit'],
    synthesized_at: '2026-07-01T00:00:00.000Z',
  }, overrides);
}

// ---------------------------------------------------------------------------
// The render -> checks contract: a freshly rendered doctrine doc must PASS the
// starter suite. This is the load-bearing invariant — render.js emits exactly
// the shape checks.js validates.
// ---------------------------------------------------------------------------

test('a renderDoctrineMarkdown doc passes the starter checks suite', () => {
  const md = render.renderDoctrineMarkdown(sampleRow());
  const out = checks.runChecks(md);
  assert.equal(out.ok, true, `rendered doc should pass all checks: ${out.results.filter((r) => !r.pass).map((r) => r.message).join('; ')}`);
  assert.deepEqual(out.results.map((r) => r.id), ['frontmatter-present', 'one-principle-shape']);
  assert.ok(out.results.every((r) => r.pass));
});

test('runChecks surfaces the deferred battery so coverage cannot lie by omission', () => {
  const out = checks.runChecks(render.renderDoctrineMarkdown(sampleRow()));
  // The full 13-check battery (ULTRAPLAN §6 L200); starter implements 2, defers the rest.
  assert.ok(Array.isArray(out.deferred));
  assert.equal(out.deferred.length, 13, `deferred battery is 13 checks (got ${out.deferred.length})`);
  for (const name of ['status-lint', 'checkpoint-cadence', 'anchor-check', 'publish-order', 'in-glob', 'tarball', 'htmlbody']) {
    assert.ok(out.deferred.includes(name), `deferred names ${name}`);
  }
  // rls-audit ×5.
  assert.equal(out.deferred.filter((n) => n.startsWith('rls-gate-')).length, 5, 'five RLS gates deferred');
});

// ---------------------------------------------------------------------------
// parseFrontmatter — the flat key:value block reader.
// ---------------------------------------------------------------------------

test('parseFrontmatter reads a well-formed block', () => {
  const md = render.renderDoctrineMarkdown(sampleRow());
  const fm = checks.parseFrontmatter(md);
  assert.equal(fm.ok, true);
  assert.equal(fm.data.status, 'proposed');
  assert.equal(fm.data.source, 'rumen-doctrine-scan');
  assert.ok(fm.data.id.startsWith('D-'), `id starts with D-: ${fm.data.id}`);
  assert.ok(fm.body.includes('## Principle'), 'body carries the sections');
});

test('parseFrontmatter fails cleanly on no fence / unclosed fence', () => {
  assert.equal(checks.parseFrontmatter('# no front-matter\n\nbody').ok, false);
  assert.equal(checks.parseFrontmatter('---\nid: D-x\ntitle: "t"\n\nbody with no close').ok, false);
  // CRLF-normalized opening fence still parses.
  assert.equal(checks.parseFrontmatter('---\r\nid: D-x\r\ntitle: "t"\r\nstatus: proposed\r\n---\r\n\r\nbody').ok, true);
});

// ---------------------------------------------------------------------------
// checkFrontmatterPresent.
// ---------------------------------------------------------------------------

test('frontmatter-present passes a full doc, fails on absent block or missing required key', () => {
  const ok = checks.checkFrontmatterPresent(render.renderDoctrineMarkdown(sampleRow()));
  assert.equal(ok.pass, true);
  assert.equal(ok.id, 'frontmatter-present');
  assert.equal(ok.severity, 'high');

  const noFm = checks.checkFrontmatterPresent('# title\n\n## Principle\n\nbody\n');
  assert.equal(noFm.pass, false);
  assert.match(noFm.message, /no valid front-matter/);

  const noStatus = checks.checkFrontmatterPresent('---\nid: D-x\ntitle: "t"\n---\n\n## Principle\n\nbody\n');
  assert.equal(noStatus.pass, false);
  assert.match(noStatus.message, /missing required key\(s\): status/);
});

// ---------------------------------------------------------------------------
// checkOnePrincipleShape — the "ONE principle, not several fused" check.
// ---------------------------------------------------------------------------

test('one-principle-shape: exactly one non-empty Principle section passes', () => {
  const r = checks.checkOnePrincipleShape(render.renderDoctrineMarkdown(sampleRow()));
  assert.equal(r.pass, true);
  assert.equal(r.id, 'one-principle-shape');
});

test('one-principle-shape fails on zero, multiple, or empty Principle sections', () => {
  const zero = checks.checkOnePrincipleShape('---\nid: D-x\ntitle: "t"\nstatus: proposed\n---\n\n## Why\n\nx\n');
  assert.equal(zero.pass, false);
  assert.match(zero.message, /no `## Principle` section/);

  const md = render.renderDoctrineMarkdown(sampleRow());
  const two = md.replace('## Why (evidence ledger)', '## Principle\n\nsecond principle\n\n## Why (evidence ledger)');
  const twoRes = checks.checkOnePrincipleShape(two);
  assert.equal(twoRes.pass, false);
  assert.match(twoRes.message, /2 "## Principle" sections/);

  const empty = checks.checkOnePrincipleShape('---\nid: D-x\ntitle: "t"\nstatus: proposed\n---\n\n## Principle\n\n## Why\n\nx\n');
  assert.equal(empty.pass, false);
  assert.match(empty.message, /empty/);
});

test('one-principle-shape does not match `## Principles` (plural) or inline text', () => {
  const plural = checks.checkOnePrincipleShape('---\nid: D-x\ntitle: "t"\nstatus: proposed\n---\n\n## Principles\n\nlist\n');
  assert.equal(plural.pass, false, 'plural heading is not a Principle section');
});

// ---------------------------------------------------------------------------
// Fail-soft — checks + runChecks never throw, even on junk input (they ride
// CI / authoring paths; a crash there is worse than a reported failure).
// ---------------------------------------------------------------------------

test('checks are fail-soft: no throw on null/undefined/non-string input', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.doesNotThrow(() => checks.runChecks(bad), `runChecks(${JSON.stringify(bad)}) must not throw`);
    const out = checks.runChecks(bad);
    assert.equal(out.ok, false, 'junk input fails (never silently passes)');
    assert.ok(Array.isArray(out.results));
  }
});
