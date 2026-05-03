// Sprint 51.5 T3 — install-time GRAPH_LLM_CLASSIFY prompt.
//
// graph-inference (the daily cron Edge Function) defaults every new edge to
// `relates_to` unless GRAPH_LLM_CLASSIFY=1 AND ANTHROPIC_API_KEY are set as
// Edge Function secrets. Pre-Sprint-51.5, no install path covered the toggle
// — the wizard set ANTHROPIC_API_KEY (already required) but never set
// GRAPH_LLM_CLASSIFY, leaving the LLM classifier off by default. Class F
// (default-vs-runtime asymmetry) per INSTALLER-PITFALLS.md.
//
// These fixtures pin the prompt's behavior under each input mode:
//   1. Y-path → secrets.GRAPH_LLM_CLASSIFY = '1', enabled: true.
//   2. N-path → secrets.GRAPH_LLM_CLASSIFY left undefined, enabled: false,
//      manual-flip command printed.
//   3. --yes → defaults Y without prompting, sets GRAPH_LLM_CLASSIFY = '1'.
//   4. --dry-run → defaults Y without prompting, sets GRAPH_LLM_CLASSIFY = '1'.
// And the downstream effect on setFunctionSecrets:
//   5. Y → GRAPH_LLM_CLASSIFY=1 included in the per-secret CLI loop.
//   6. N → GRAPH_LLM_CLASSIFY skipped by the per-secret CLI loop.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const initRumen = require(path.join(repoRoot, 'packages', 'cli', 'src', 'init-rumen.js'));
const promptGraphLlmClassify = initRumen._promptGraphLlmClassify;
const setFunctionSecrets = initRumen._setFunctionSecrets;

// Capture stdout/stderr while running `fn`. Lets tests assert the prompt's
// printed explainer + recorded answer mode without polluting test output.
async function captureOutput(fn) {
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const stdout = [];
  const stderr = [];
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  try {
    const result = await fn();
    return { stdout: stdout.join(''), stderr: stderr.join(''), result };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
}

// Spy that replaces prompts.confirm via require.cache. The prompts module
// is loaded once by init-rumen.js via SETUP_DIR; we patch its export with
// our spy and restore it after each test.
function patchConfirm(answer) {
  const setupIndexId = require.resolve(
    path.join(repoRoot, 'packages', 'server', 'src', 'setup', 'index.js')
  );
  const setupExport = require(setupIndexId);
  const promptsMod = setupExport.prompts;
  const orig = promptsMod.confirm;
  promptsMod.confirm = async () => answer;
  return () => { promptsMod.confirm = orig; };
}

// ── 1. Y-path ───────────────────────────────────────────────────────────────

test('Y-path sets secrets.GRAPH_LLM_CLASSIFY = "1" and reports enabled', async () => {
  const restore = patchConfirm(true);
  try {
    const secrets = { ANTHROPIC_API_KEY: 'sk-ant' };
    const cap = await captureOutput(async () =>
      promptGraphLlmClassify({ secrets, flags: { yes: false, dryRun: false } }));
    assert.equal(cap.result.enabled, true);
    assert.equal(cap.result.source, 'prompt');
    assert.equal(secrets.GRAPH_LLM_CLASSIFY, '1');
    assert.match(cap.stdout, /Graph edge classification/);
    assert.match(cap.stdout, /Will set GRAPH_LLM_CLASSIFY=1/);
  } finally {
    restore();
  }
});

// ── 2. N-path ───────────────────────────────────────────────────────────────

test('N-path leaves GRAPH_LLM_CLASSIFY unset and prints manual flip command', async () => {
  const restore = patchConfirm(false);
  try {
    const secrets = { ANTHROPIC_API_KEY: 'sk-ant' };
    const cap = await captureOutput(async () =>
      promptGraphLlmClassify({ secrets, flags: { yes: false, dryRun: false } }));
    assert.equal(cap.result.enabled, false);
    assert.equal(cap.result.source, 'prompt');
    assert.equal(secrets.GRAPH_LLM_CLASSIFY, undefined,
      'N-path leaves the in-memory map untouched (downstream loop skips the key)');
    assert.match(cap.stdout, /supabase secrets set GRAPH_LLM_CLASSIFY=1/,
      'manual-flip command surfaced in N-path output');
  } finally {
    restore();
  }
});

// ── 3. --yes path ───────────────────────────────────────────────────────────

test('--yes accepts default (Y) without prompting', async () => {
  // No prompts.confirm patch — if --yes calls into it, this test will hang.
  const secrets = { ANTHROPIC_API_KEY: 'sk-ant' };
  const cap = await captureOutput(async () =>
    promptGraphLlmClassify({ secrets, flags: { yes: true, dryRun: false } }));
  assert.equal(cap.result.enabled, true);
  assert.equal(cap.result.source, '--yes');
  assert.equal(secrets.GRAPH_LLM_CLASSIFY, '1');
  assert.match(cap.stdout, /--yes, defaulting Y/);
});

// ── 4. --dry-run path ───────────────────────────────────────────────────────

test('--dry-run accepts default (Y) without prompting and tags source as dry-run', async () => {
  const secrets = { ANTHROPIC_API_KEY: 'sk-ant' };
  const cap = await captureOutput(async () =>
    promptGraphLlmClassify({ secrets, flags: { yes: false, dryRun: true } }));
  assert.equal(cap.result.enabled, true);
  assert.equal(cap.result.source, 'dry-run');
  assert.equal(secrets.GRAPH_LLM_CLASSIFY, '1');
  assert.match(cap.stdout, /dry-run, defaulting Y/);
});

// ── 5 & 6. Round-trip into setFunctionSecrets ───────────────────────────────

test('Y-path then setFunctionSecrets adds GRAPH_LLM_CLASSIFY=1 to the per-secret CLI loop', async () => {
  const restore = patchConfirm(true);
  try {
    const secrets = {
      DATABASE_URL: 'postgresql://x',
      ANTHROPIC_API_KEY: 'sk-ant'
    };
    await captureOutput(async () =>
      promptGraphLlmClassify({ secrets, flags: { yes: false, dryRun: false } }));
    assert.equal(secrets.GRAPH_LLM_CLASSIFY, '1');

    const calls = [];
    function runner(bin, args) {
      calls.push({ bin, args: args.slice() });
      return { ok: true, code: 0, stdout: '', stderr: '' };
    }
    await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
    const keys = calls.map((c) => c.args[2].split('=')[0]);
    assert.ok(keys.includes('GRAPH_LLM_CLASSIFY'),
      'Y-path round-trips into a per-secret CLI invocation for GRAPH_LLM_CLASSIFY');
    const llmCall = calls.find((c) => c.args[2].startsWith('GRAPH_LLM_CLASSIFY='));
    assert.equal(llmCall.args[2], 'GRAPH_LLM_CLASSIFY=1');
  } finally {
    restore();
  }
});

test('N-path then setFunctionSecrets does NOT include GRAPH_LLM_CLASSIFY in the loop', async () => {
  const restore = patchConfirm(false);
  try {
    const secrets = {
      DATABASE_URL: 'postgresql://x',
      ANTHROPIC_API_KEY: 'sk-ant'
    };
    await captureOutput(async () =>
      promptGraphLlmClassify({ secrets, flags: { yes: false, dryRun: false } }));
    assert.equal(secrets.GRAPH_LLM_CLASSIFY, undefined);

    const calls = [];
    function runner(bin, args) {
      calls.push({ bin, args: args.slice() });
      return { ok: true, code: 0, stdout: '', stderr: '' };
    }
    await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
    const keys = calls.map((c) => c.args[2].split('=')[0]);
    assert.ok(!keys.includes('GRAPH_LLM_CLASSIFY'),
      'N-path leaves GRAPH_LLM_CLASSIFY out of the CLI loop entirely');
  } finally {
    restore();
  }
});
