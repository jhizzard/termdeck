#!/usr/bin/env node
'use strict';

// scripts/proof/cold-vs-warm.js — the cold-vs-warm recall→reinjection proof.
//
// Runs a FROZEN set of representative probes twice each — COLD (no memory
// reinjection) and WARM (memory_recall reinjected) — holding everything else
// constant, and reports the delta: rows surfaced, tokens reinjected, source_type
// mix, provenance, and whether the answer gained a memory-resident fact it
// lacked cold. Emits a Markdown report a human can read and a JSON record a tool
// (or an auditor) can consume.
//
// DEFAULTS ARE OFFLINE + SAFE: `--recall=fixture --answerer=stub`. A bare run
// touches no live store, no model, no credentials — and its report is stamped
// "PLUMBING DEMO, not evidence". The real proof is a deliberate flag flip:
//   node scripts/proof/cold-vs-warm.js --recall=http --answerer="cmd:claude -p"
// which ORCH runs at close-out (workers are file-only). An out-of-distribution
// model reproducing the WARM wins (e.g. --answerer="cmd:codex exec") is the
// anti-rig check the whole sprint hinges on.
//
// Usage:
//   node scripts/proof/cold-vs-warm.js [options]
//     --recall=<spec>       fixture | fixture:<dir> | http | http:<url>   (default: fixture)
//     --answerer=<spec>     stub | cmd:<command> | anthropic              (default: stub)
//     --mode=<mode>         reinjection | boost                           (default: reinjection)
//     --probes=<path>       probe set JSON            (default: scripts/proof/fixtures/probes.json)
//     --out=<dir>           report output dir         (default: scripts/proof/reports)
//     --system=<path>       system-preamble file      (default: built-in neutral preamble)
//     --session-id=<id>     caller session id for provenance   (default: proof-harness-<runId>)
//     --source-agent=<id>   caller source agent               (default: proof-harness)
//     --run-id=<id>         override run id (for reproducible sample output)
//     --generated-at=<iso>  override timestamp (for reproducible sample output)
//     --world-knowledge=<path>  JSON array of facts the stub "already knows" (stub only)
//     --verify-frozen       exit non-zero if the probe set doesn't match probes.lock
//     --write-lock          (re)write probes.lock to the current checksum, then exit
//     --json-only | --md-only
//     --quiet
//     -h, --help

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { makeRecallAdapter } = require('./lib/recall-adapter');
const { makeAnswerer } = require('./lib/answerer-adapter');
const { aggregate } = require('./lib/metrics');
const { runReinjectionProbe, runBoostProbe } = require('./lib/runner');
const { renderMarkdown, renderJson } = require('./lib/report');

const PROOF_DIR = __dirname;
const DEFAULT_PROBES = path.join(PROOF_DIR, 'fixtures', 'probes.json');
const LOCK_FILE = path.join(PROOF_DIR, 'fixtures', 'probes.lock');
const DEFAULT_OUT = path.join(PROOF_DIR, 'reports');

const DEFAULT_SYSTEM =
  'You are assisting a developer working on the TermDeck project. Answer the task ' +
  'concisely and accurately. If you do not have specific information to answer, say so ' +
  'plainly — do not guess or invent details.';

function log(...args) { console.log('[proof]', ...args); }
function die(msg) { console.error('[proof]', msg); process.exit(1); }

function parseArgs(argv) {
  const opts = {
    recall: 'fixture', answerer: 'stub', mode: 'reinjection',
    probes: DEFAULT_PROBES, out: DEFAULT_OUT, system: null,
    sessionId: null, sourceAgent: 'proof-harness',
    runId: null, generatedAt: null, worldKnowledge: null,
    verifyFrozen: false, writeLock: false, jsonOnly: false, mdOnly: false, quiet: false,
  };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
    if (arg === '--verify-frozen') { opts.verifyFrozen = true; continue; }
    if (arg === '--write-lock') { opts.writeLock = true; continue; }
    if (arg === '--json-only') { opts.jsonOnly = true; continue; }
    if (arg === '--md-only') { opts.mdOnly = true; continue; }
    if (arg === '--quiet') { opts.quiet = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) die(`unknown argument: ${arg} (try --help)`);
    const [, k, v] = m;
    const map = {
      recall: 'recall', answerer: 'answerer', mode: 'mode', probes: 'probes', out: 'out',
      system: 'system', 'session-id': 'sessionId', 'source-agent': 'sourceAgent',
      'run-id': 'runId', 'generated-at': 'generatedAt', 'world-knowledge': 'worldKnowledge',
    };
    if (!map[k]) die(`unknown option: --${k} (try --help)`);
    opts[map[k]] = v;
  }
  return opts;
}

// Canonical JSON (recursively sorted keys) so a probe-set checksum is stable
// regardless of key order or whitespace. This is how "frozen set" is enforced.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksumOf(probes) {
  return crypto.createHash('sha256').update(canonical(probes)).digest('hex').slice(0, 16);
}

function loadProbes(file) {
  if (!fs.existsSync(file)) die(`probe set not found: ${file}`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { die(`probe set is not valid JSON: ${file}: ${err.message}`); }
  const probes = Array.isArray(parsed) ? parsed : parsed.probes;
  if (!Array.isArray(probes) || probes.length === 0) die(`probe set has no probes: ${file}`);
  for (const p of probes) {
    if (!p.id || !p.query || !p.task || p.factKey == null) {
      die(`probe missing required field (id/query/task/factKey): ${JSON.stringify(p).slice(0, 120)}`);
    }
  }
  return probes;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  const probes = loadProbes(opts.probes);
  const checksum = checksumOf(probes);

  if (opts.writeLock) {
    fs.writeFileSync(LOCK_FILE, checksum + '\n');
    log(`wrote ${path.relative(process.cwd(), LOCK_FILE)} = ${checksum}`);
    return;
  }

  const lock = fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, 'utf8').trim() : null;
  const frozen = lock != null && lock === checksum;
  if (opts.verifyFrozen && !frozen) {
    die(`probe set checksum ${checksum} != lock ${lock || '(missing)'} — the frozen probe set changed. ` +
        `Review the change, then run --write-lock to accept it.`);
  }
  if (lock == null && !opts.quiet) log(`no probes.lock yet — checksum ${checksum} (run --write-lock to freeze)`);
  if (lock != null && !frozen && !opts.quiet) log(`⚠ probe set checksum ${checksum} != lock ${lock} — set changed since freeze`);

  const runId = opts.runId || `cvw-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const sessionId = opts.sessionId || `proof-harness-${runId}`;
  const system = opts.system ? fs.readFileSync(opts.system, 'utf8') : DEFAULT_SYSTEM;

  let worldKnowledge;
  if (opts.worldKnowledge) {
    try { worldKnowledge = JSON.parse(fs.readFileSync(opts.worldKnowledge, 'utf8')); }
    catch (err) { die(`--world-knowledge is not valid JSON: ${err.message}`); }
  }

  const recallAdapter = makeRecallAdapter(opts.recall);
  const answerer = makeAnswerer(opts.answerer, { worldKnowledge });
  if (recallAdapter.live && !opts.quiet) log(`⚠ LIVE recall adapter (${recallAdapter.name}) — this hits the real store. ORCH-only per lane discipline.`);

  if (!opts.quiet) {
    log(`run ${runId} · mode=${opts.mode} · recall=${recallAdapter.name} · answerer=${answerer.name} · ${probes.length} probes`);
    if (!answerer.evidence) log('answerer is the STUB → report will be stamped PLUMBING DEMO (not evidence)');
  }

  const results = [];
  for (const probe of probes) {
    try {
      const runner = opts.mode === 'boost' ? runBoostProbe : runReinjectionProbe;
      const r = await runner({ probe, recallAdapter, answerer, system, sessionId, sourceAgent: opts.sourceAgent });
      results.push(r);
      if (!opts.quiet) log(`  ${probe.id}: ${r.verdict} (rows=${r.rowsSurfaced}, tokens=${r.tokensReinjected})`);
    } catch (err) {
      // Per-probe fail-soft on a LIVE run: record the error as its own bucket so
      // the report still lands and the failure is VISIBLE (never silently a
      // no-delta). A fixture-path error (missing fixture) is a real bug and will
      // surface loudly here too.
      results.push({
        id: probe.id, query: probe.query, project: probe.project || null,
        rationale: probe.rationale || '', factKey: String(probe.factKey),
        rowsSurfaced: 0, tokensReinjected: 0, tokensReinjectedBlock: 0, reinjectionChars: 0,
        sourceTypeMix: {}, provenance: { attributed: false, origin: 'error' },
        reinjectionText: '', coldAnswer: '', warmAnswer: '',
        coldHasFact: false, warmHasFact: false, verdict: 'error', noDeltaReason: null,
        error: err.message, hits: [],
      });
      console.error('[proof]', `  ${probe.id}: ERROR ${err.message}`);
    }
  }

  const agg = aggregate(results);
  const run = {
    runId, generatedAt, mode: opts.mode,
    recallAdapter: recallAdapter.name, recallAdapterSpec: opts.recall,
    answerer: answerer.name, answererSpec: opts.answerer, answererIsEvidence: !!answerer.evidence,
    probeSetChecksum: checksum, probeSetFrozen: frozen,
    reproCommand: `node scripts/proof/cold-vs-warm.js --recall=${opts.recall} --answerer=${JSON.stringify(opts.answerer)} --mode=${opts.mode}`,
    results, aggregate: agg,
  };

  fs.mkdirSync(opts.out, { recursive: true });
  const base = path.join(opts.out, runId);
  if (!opts.jsonOnly) {
    fs.writeFileSync(`${base}.md`, renderMarkdown(run));
    if (!opts.quiet) log(`wrote ${path.relative(process.cwd(), base)}.md`);
  }
  if (!opts.mdOnly) {
    fs.writeFileSync(`${base}.json`, JSON.stringify(renderJson(run), null, 2) + '\n');
    if (!opts.quiet) log(`wrote ${path.relative(process.cwd(), base)}.json`);
  }

  log(agg.honestyNote);
  if (!answerer.evidence) log('NOTE: stub answerer → this is a plumbing demo, not evidence of the claim.');
}

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const banner = src.split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
  console.log(banner);
}

main().catch((err) => {
  console.error('[proof] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
