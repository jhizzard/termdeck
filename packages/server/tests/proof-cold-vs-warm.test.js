'use strict';

// Offline tests for the cold-vs-warm recall→reinjection proof harness
// (scripts/proof/). No live MCP, no live SQL, no model calls — the fixture
// recall adapter + stub answerer make the whole pipeline deterministic. These
// pin: (1) token accounting byte-faithful to engram/src/recall.ts, (2) the
// verdict/aggregate logic, (3) the honesty invariants that keep the proof from
// being riggable (run-all-report-all; no-delta and cold-wins are reported).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '..', 'scripts', 'proof', 'lib');
const FIX = path.join(__dirname, '..', '..', '..', 'scripts', 'proof', 'fixtures');

const tokens = require(path.join(LIB, 'tokens.js'));
const metrics = require(path.join(LIB, 'metrics.js'));
const { makeRecallAdapter, makeFixtureAdapter } = require(path.join(LIB, 'recall-adapter.js'));
const { makeAnswerer, makeStubAnswerer } = require(path.join(LIB, 'answerer-adapter.js'));
const { runReinjectionProbe, composePrompt } = require(path.join(LIB, 'runner.js'));
const report = require(path.join(LIB, 'report.js'));

const probesDoc = JSON.parse(fs.readFileSync(path.join(FIX, 'probes.json'), 'utf8'));
const PROBES = probesDoc.probes;
const HITS = JSON.parse(fs.readFileSync(path.join(FIX, 'recall-hits.json'), 'utf8'));
const SYSTEM = 'You are a test harness. Answer concisely.';

// ── tokens.js — byte-faithful to recall.ts ───────────────────────────────────

test('estimateTokens is ceil(len/4)', () => {
  assert.equal(tokens.estimateTokens(''), 0);
  assert.equal(tokens.estimateTokens('abcd'), 1);
  assert.equal(tokens.estimateTokens('abcde'), 2);   // ceil(5/4)
  assert.equal(tokens.estimateTokens('a'.repeat(8)), 2);
  assert.equal(tokens.estimateTokens('a'.repeat(9)), 3);
  assert.equal(tokens.estimateTokens(null), 0);
});

test('truncate mirrors recall.ts (300-cap, trimEnd + ellipsis)', () => {
  assert.equal(tokens.truncate('short'), 'short');
  const at = 'x'.repeat(300);
  assert.equal(tokens.truncate(at), at); // exactly at cap: unchanged
  const over = 'y'.repeat(305);
  const t = tokens.truncate(over);
  assert.ok(t.endsWith('...'));
  assert.equal(t.length, 303); // 300 chars + '...'
  // trailing whitespace at the cut is trimmed before the ellipsis
  assert.equal(tokens.truncate('a'.repeat(299) + '   bbb'), 'a'.repeat(299) + '...');
});

test('renderHitLine honors the project filter + importance tag', () => {
  const hit = { source_type: 'decision', project: 'termdeck', content: 'hello', metadata: { importance: 'critical' } };
  assert.equal(tokens.renderHitLine(hit, 'termdeck'), '- (decision/critical) hello');
  assert.equal(tokens.renderHitLine(hit, null), '- (decision/critical) [termdeck] hello');
  assert.equal(tokens.renderHitLine({ source_type: 'fact', project: 'g', content: 'x' }, null), '- (fact) [g] x');
});

test('renderReinjection: tokens_used sums per-line tokens and EXCLUDES the header', () => {
  const hits = [{ source_type: 'fact', project: 'p', content: 'alpha' }];
  const { text, tokens_used } = tokens.renderReinjection(hits, { project: 'p' });
  const line = '- (fact) alpha';
  assert.equal(tokens_used, tokens.estimateTokens(line));
  assert.ok(text.startsWith('1 memories (' + tokens_used + ' tokens, project: p):'));
  // header is present in text but NOT counted in tokens_used
  assert.ok(tokens.estimateTokens(text) > tokens_used);
});

test('committed recall fixtures are byte-faithful to the formatter (not fudged)', () => {
  // Re-render every fixture from its hits and assert text + tokens_used match.
  // This makes fixture tampering (or recall.ts drift) a test failure.
  for (const probe of PROBES) {
    const spec = HITS[probe.id];
    assert.ok(spec, `recall-hits.json missing ${probe.id}`);
    const project = spec.project === undefined ? (probe.project || null) : spec.project;
    const fixture = JSON.parse(fs.readFileSync(path.join(FIX, 'recall', `${probe.id}.json`), 'utf8'));
    const rebuilt = tokens.renderReinjection(spec.hits, { project });
    assert.equal(fixture.text, rebuilt.text, `text drift in ${probe.id}.json`);
    assert.equal(fixture.tokens_used, rebuilt.tokens_used, `tokens_used drift in ${probe.id}.json`);
    // and the harness measurement agrees with the fixture
    const m = tokens.measureReinjection(fixture);
    assert.equal(m.tokens_used, fixture.tokens_used);
    assert.equal(m.block_tokens, tokens.estimateTokens(fixture.text));
  }
});

// ── metrics.js — verdict + aggregate ─────────────────────────────────────────

test('factPresent: substring, normalization, any/all/regex, fail-closed', () => {
  assert.ok(metrics.factPresent('The answer is 3+1+1 today', '3+1+1'));
  assert.ok(metrics.factPresent('RECIPROCAL   rank\nFUSION', 'reciprocal rank fusion')); // case + whitespace
  assert.ok(!metrics.factPresent('nope', 'missing'));
  assert.ok(metrics.factPresent('has ceil and 4 here', { all: ['ceil', '4'] }));
  assert.ok(!metrics.factPresent('has ceil only', { all: ['ceil', '4'] }));
  assert.ok(metrics.factPresent('one of these', { any: ['zzz', 'these'] }));
  assert.ok(metrics.factPresent('a and b', ['a', 'b'])); // bare array == all
  assert.ok(metrics.factPresent('port 11434 open', { regex: '\\b11434\\b' }));
  // fail-closed
  assert.ok(!metrics.factPresent('anything', null));
  assert.ok(!metrics.factPresent('anything', ''));
  assert.ok(!metrics.factPresent('anything', { regex: '(' })); // bad pattern → false, no throw
});

test('sourceTypeMix / mergeMix / formatMix', () => {
  const mix = metrics.sourceTypeMix([{ source_type: 'decision' }, { source_type: 'decision' }, { source_type: 'fact' }]);
  assert.deepEqual(mix, { decision: 2, fact: 1 });
  assert.deepEqual(metrics.mergeMix({ a: 1 }, { a: 2, b: 1 }), { a: 3, b: 1 });
  assert.equal(metrics.formatMix({ decision: 2, fact: 1 }), 'decision 2, fact 1');
  assert.equal(metrics.formatMix({}), '(none)');
});

test('verdictFor covers all four combinations', () => {
  assert.equal(metrics.verdictFor(false, true), 'warm-wins');
  assert.equal(metrics.verdictFor(true, false), 'cold-wins');
  assert.equal(metrics.verdictFor(true, true), 'no-delta');
  assert.equal(metrics.verdictFor(false, false), 'no-delta');
});

test('extractProvenance flags attributed vs unattributed honestly', () => {
  assert.equal(metrics.extractProvenance({ log: {} }).attributed, false);
  assert.equal(metrics.extractProvenance({ log: { source_session_id: 's' } }).attributed, true);
  assert.equal(metrics.extractProvenance({ log: { source_agent: 'a' } }).attributed, true);
  assert.equal(metrics.extractProvenance({}).source_session_id, null);
});

test('computeProbeResult scores each verdict correctly', () => {
  const probe = { id: 'p', query: 'q', task: 't', factKey: 'FACT' };
  const recall = { hits: [{ id: 'x', source_type: 'fact', project: 'p', score: 0.2 }], tokens_used: 10, text: 'block with FACT', log: { source_session_id: 's', source_agent: 'a' } };
  const warmWin = metrics.computeProbeResult({ probe, recall, coldAnswer: { text: 'no idea' }, warmAnswer: { text: 'the FACT is here' } });
  assert.equal(warmWin.verdict, 'warm-wins');
  assert.equal(warmWin.rowsSurfaced, 1);
  assert.equal(warmWin.tokensReinjected, 10);
  assert.equal(warmWin.provenance.attributed, true);

  const bothHave = metrics.computeProbeResult({ probe, recall, coldAnswer: { text: 'FACT known' }, warmAnswer: { text: 'FACT again' } });
  assert.equal(bothHave.verdict, 'no-delta');
  assert.equal(bothHave.noDeltaReason, 'both-have');

  const bothLack = metrics.computeProbeResult({ probe, recall, coldAnswer: { text: 'x' }, warmAnswer: { text: 'y' } });
  assert.equal(bothLack.verdict, 'no-delta');
  assert.equal(bothLack.noDeltaReason, 'both-lack');

  const coldWin = metrics.computeProbeResult({ probe, recall, coldAnswer: { text: 'FACT' }, warmAnswer: { text: 'nothing' } });
  assert.equal(coldWin.verdict, 'cold-wins');
});

test('aggregate counts every bucket including errors', () => {
  const agg = metrics.aggregate([
    { verdict: 'warm-wins', rowsSurfaced: 1, tokensReinjected: 5, tokensReinjectedBlock: 6, sourceTypeMix: { fact: 1 }, provenance: { attributed: true } },
    { verdict: 'no-delta', noDeltaReason: 'both-have', rowsSurfaced: 1, tokensReinjected: 5, tokensReinjectedBlock: 6, sourceTypeMix: { decision: 1 }, provenance: { attributed: false } },
    { verdict: 'cold-wins', rowsSurfaced: 0, tokensReinjected: 0, tokensReinjectedBlock: 0, sourceTypeMix: {}, provenance: { attributed: false } },
    { verdict: 'error', error: 'boom' },
  ]);
  assert.equal(agg.probes, 4);
  assert.equal(agg.scored, 3);
  assert.equal(agg.errors, 1);
  assert.equal(agg.warmWins, 1);
  assert.equal(agg.noDelta, 1);
  assert.equal(agg.bothHave, 1);
  assert.equal(agg.coldWins, 1);
  assert.equal(agg.totalTokensReinjected, 10);
  assert.equal(agg.provenanceAttributed, 1);
  assert.match(agg.honestyNote, /every probe is reported/);
});

// ── adapters ─────────────────────────────────────────────────────────────────

test('fixture recall adapter returns the fixture and fails LOUD on a miss', async () => {
  const adapter = makeFixtureAdapter({});
  const out = await adapter.recall({ id: 'sprint-role-architecture' }, { variant: 'warm' });
  assert.equal(out.hits.length, 2);
  assert.match(out.text, /3\+1\+1/);
  assert.equal(out.log.source_agent, 'proof-harness');
  await assert.rejects(
    () => adapter.recall({ id: 'does-not-exist' }, { variant: 'warm' }),
    /recall fixture not found/,
  );
});

test('makeRecallAdapter spec parsing', () => {
  assert.equal(makeRecallAdapter('fixture').live, false);
  assert.equal(makeRecallAdapter('http').live, true);
  assert.equal(makeRecallAdapter('http://127.0.0.1:1/mnestra').live, true);
  assert.throws(() => makeRecallAdapter('bogus'), /unknown recall adapter/);
});

test('stub answerer is a context oracle (cold blind, warm sees the block)', async () => {
  const stub = makeStubAnswerer({});
  const cold = await stub.answer({ memoryBlock: '', arm: 'cold' });
  assert.doesNotMatch(cold.text, /3\+1\+1/);
  const warm = await stub.answer({ memoryBlock: 'contains 3+1+1 fact', arm: 'warm' });
  assert.match(warm.text, /3\+1\+1/);
  // worldKnowledge lets the stub "already know" a fact even cold
  const knowing = makeStubAnswerer({ worldKnowledge: ['the answer is 3+1+1'] });
  const coldK = await knowing.answer({ memoryBlock: '', arm: 'cold' });
  assert.match(coldK.text, /3\+1\+1/);
});

test('makeAnswerer spec parsing + evidence flags', () => {
  assert.equal(makeAnswerer('stub').evidence, false);
  const c = makeAnswerer('cmd:echo hi');
  assert.equal(c.evidence, true);
  assert.equal(c.live, true);
  assert.equal(makeAnswerer('anthropic').evidence, true);
  assert.throws(() => makeAnswerer('bogus'), /unknown answerer/);
});

test('composePrompt reinjects the block only when present', () => {
  assert.doesNotMatch(composePrompt('SYS', '', 'TASK'), /Recalled memory/);
  assert.match(composePrompt('SYS', 'BLOCK', 'TASK'), /Recalled memory[\s\S]*BLOCK[\s\S]*TASK/);
});

// ── honesty invariants (the anti-rig guarantees) ─────────────────────────────

async function runPipeline({ worldKnowledge } = {}) {
  const recallAdapter = makeFixtureAdapter({});
  const answerer = makeStubAnswerer({ worldKnowledge });
  const results = [];
  for (const probe of PROBES) {
    results.push(await runReinjectionProbe({
      probe, recallAdapter, answerer, system: SYSTEM,
      sessionId: 'proof-harness-test', sourceAgent: 'proof-harness',
    }));
  }
  return { results, aggregate: metrics.aggregate(results) };
}

test('RUN-ALL: every probe in the frozen set is executed and reported', async () => {
  const { results } = await runPipeline();
  assert.equal(results.length, PROBES.length);
  const ids = new Set(results.map((r) => r.id));
  for (const p of PROBES) assert.ok(ids.has(p.id), `missing probe ${p.id}`);
});

test('default stub (knows nothing) → every fixture-backed probe is a warm-win', async () => {
  const { aggregate: agg } = await runPipeline();
  assert.equal(agg.warmWins, PROBES.length);
  assert.equal(agg.coldWins, 0);
  assert.equal(agg.errors, 0);
});

test('REPORT-ALL: a no-delta probe is still counted and reported, not dropped', async () => {
  // Give the stub the RRF fact as world knowledge → the rrf-meaning probe's cold
  // arm now HAS the fact → honest no-delta (both-have). Prove it is NOT filtered.
  const { results, aggregate: agg } = await runPipeline({ worldKnowledge: ['RRF stands for Reciprocal Rank Fusion'] });
  const rrf = results.find((r) => r.id === 'rrf-meaning');
  assert.equal(rrf.verdict, 'no-delta');
  assert.equal(rrf.noDeltaReason, 'both-have');
  assert.equal(agg.noDelta, 1);
  assert.equal(agg.warmWins, PROBES.length - 1);
  // and it survives into the rendered report
  const run = makeRun(results, agg, false);
  const md = report.renderMarkdown(run);
  assert.match(md, /rrf-meaning/);
  assert.match(md, /no-delta/);
});

function makeRun(results, agg, evidence) {
  return {
    runId: 'test', generatedAt: '2026-07-05T00:00:00Z', mode: 'reinjection',
    recallAdapter: 'fixture', recallAdapterSpec: 'fixture',
    answerer: 'stub', answererSpec: 'stub', answererIsEvidence: evidence,
    probeSetChecksum: 'deadbeef', probeSetFrozen: true,
    results, aggregate: agg,
  };
}

test('report stamps a stub run as NON-EVIDENCE and always emits Threats', async () => {
  const { results, aggregate: agg } = await runPipeline();
  const md = report.renderMarkdown(makeRun(results, agg, false));
  assert.match(md, /PLUMBING DEMO, NOT EVIDENCE/);
  assert.match(md, /Honesty contract/);
  assert.match(md, /Threats to validity/);
  assert.match(md, /RRF value \(0\.01–0\.3 band\)/); // score labeled honestly
  for (const p of PROBES) assert.match(md, new RegExp(p.id.replace(/[-]/g, '\\-')));
  // an evidence run drops the stub banner
  const mdEvidence = report.renderMarkdown(makeRun(results, agg, true));
  assert.doesNotMatch(mdEvidence, /PLUMBING DEMO, NOT EVIDENCE/);
});

test('renderJson carries results + aggregate + threats', async () => {
  const { results, aggregate: agg } = await runPipeline();
  const json = report.renderJson(makeRun(results, agg, false));
  assert.equal(json.results.length, PROBES.length);
  assert.ok(json.aggregate);
  assert.ok(Array.isArray(json.threats) && json.threats.length > 0);
});
