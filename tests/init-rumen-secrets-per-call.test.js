// Sprint 51.5 T3 — per-secret CLI loop in setFunctionSecrets.
//
// Pre-Sprint-51.5, init-rumen.js shelled out to a single multi-arg
// `supabase secrets set KEY1=VAL1 KEY2=VAL2 ...` call. Brad's 2026-05-03
// 4-project install pass observed Supabase CLI v2.90.0 silently dropping
// some args from a multi-arg invocation — even materializing stray entries
// from misparsed argv (his email landed as a secret name). Documented as
// INSTALLER-PITFALLS.md Class J.
//
// These fixtures pin the new contract: one CLI invocation per secret, exit
// code per call, stderr surfaced with the failing key name. The runner
// argument is the test-injection seam — production passes nothing and falls
// back to the real `runShellCaptured`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const initRumen = require(path.join(repoRoot, 'packages', 'cli', 'src', 'init-rumen.js'));
const setFunctionSecrets = initRumen._setFunctionSecrets;

// Capture stdout/stderr for the duration of `fn`. Returns { stdout, stderr,
// result }. The functions in init-rumen.js write progress directly to the
// process streams; this lets tests assert the per-call invocation pattern
// without polluting test output.
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

// A fake runner that records every CLI invocation. Returns { ok: true } by
// default; per-key failures can be configured via `failOn`.
function makeRecordingRunner({ failOn = new Set(), stderr = '' } = {}) {
  const calls = [];
  function runner(bin, args) {
    calls.push({ bin, args: args.slice() });
    // The shape of args is ['secrets', 'set', 'KEY=VALUE'].
    const kv = args[args.length - 1] || '';
    const key = kv.split('=', 1)[0];
    if (failOn.has(key)) {
      return { ok: false, code: 1, stdout: '', stderr };
    }
    return { ok: true, code: 0, stdout: '', stderr: '' };
  }
  return { runner, calls };
}

// ── 1. Happy path: required-only secrets ────────────────────────────────────

test('per-secret loop issues one CLI call per required key (DATABASE_URL, ANTHROPIC_API_KEY)', async () => {
  const { runner, calls } = makeRecordingRunner();
  const secrets = {
    DATABASE_URL: 'postgresql://user:pass@host/db',
    ANTHROPIC_API_KEY: 'sk-ant-test-key'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, true, 'returns true on success');
  assert.equal(calls.length, 2, 'one invocation per required key');
  assert.deepEqual(calls[0].args, ['secrets', 'set', 'DATABASE_URL=postgresql://user:pass@host/db']);
  assert.deepEqual(calls[1].args, ['secrets', 'set', 'ANTHROPIC_API_KEY=sk-ant-test-key']);
  // No multi-arg parsing surface to drop or shuffle keys.
  for (const call of calls) {
    assert.equal(call.args.length, 3, 'every call has exactly one KEY=VAL positional arg');
    assert.match(call.args[2], /^[A-Z_]+=/, 'last arg is single KEY=VAL pair');
  }
});

// ── 2. Optional keys: OPENAI_API_KEY + GRAPH_LLM_CLASSIFY ───────────────────

test('OPENAI_API_KEY is included as a separate call when present', async () => {
  const { runner, calls } = makeRecordingRunner();
  const secrets = {
    DATABASE_URL: 'postgresql://x',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-openai'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.args[2].split('=')[0]),
    ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
});

test('GRAPH_LLM_CLASSIFY is set when secrets.GRAPH_LLM_CLASSIFY === "1"', async () => {
  const { runner, calls } = makeRecordingRunner();
  const secrets = {
    DATABASE_URL: 'postgresql://x',
    ANTHROPIC_API_KEY: 'sk-ant',
    GRAPH_LLM_CLASSIFY: '1'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, true);
  assert.equal(calls.length, 3);
  const keys = calls.map((c) => c.args[2].split('=')[0]);
  assert.deepEqual(keys, ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'GRAPH_LLM_CLASSIFY']);
  assert.equal(calls[2].args[2], 'GRAPH_LLM_CLASSIFY=1');
});

test('GRAPH_LLM_CLASSIFY is omitted when secrets.GRAPH_LLM_CLASSIFY is unset / not "1"', async () => {
  const { runner, calls } = makeRecordingRunner();
  const secrets = {
    DATABASE_URL: 'postgresql://x',
    ANTHROPIC_API_KEY: 'sk-ant',
    GRAPH_LLM_CLASSIFY: '0'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, true);
  assert.equal(calls.length, 2);
  const keys = calls.map((c) => c.args[2].split('=')[0]);
  assert.deepEqual(keys, ['DATABASE_URL', 'ANTHROPIC_API_KEY']);
});

test('full set: DATABASE_URL, ANTHROPIC_API_KEY, OPENAI_API_KEY, GRAPH_LLM_CLASSIFY', async () => {
  const { runner, calls } = makeRecordingRunner();
  const secrets = {
    DATABASE_URL: 'postgresql://x',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-openai',
    GRAPH_LLM_CLASSIFY: '1'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, true);
  assert.equal(calls.length, 4);
  const keys = calls.map((c) => c.args[2].split('=')[0]);
  assert.deepEqual(keys, ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GRAPH_LLM_CLASSIFY']);
});

// ── 3. v2.90.0 multi-arg drop simulation ────────────────────────────────────
//
// The pre-Sprint-51.5 multi-arg call surfaced as a single CLI invocation
// with N positional args; Brad observed v2.90.0 silently dropping some.
// The new per-call loop guarantees N independent CLI invocations. A test
// runner that drops EVERY arg after position 1 of any single call would
// have shipped only DATABASE_URL pre-fix; under the per-call refactor it
// ships every key.

test('v2.90.0-style multi-arg drop: per-call refactor ships every secret regardless of arg dropping', async () => {
  // This runner only honors the FIRST KEY=VAL pair it sees in a single
  // call — the "v2.90.0 drops the rest" simulation. The pre-fix code path
  // would land only DATABASE_URL; the per-call refactor lands all 3.
  const lostByDrop = [];
  function runner(bin, args) {
    // args is ['secrets', 'set', 'KEY1=VAL1', 'KEY2=VAL2', ...]
    const positional = args.slice(2);
    // Only the first KEY=VAL is "respected"; the rest get logged as drops.
    for (let i = 1; i < positional.length; i++) lostByDrop.push(positional[i]);
    return { ok: true, code: 0, stdout: '', stderr: '' };
  }
  const secrets = {
    DATABASE_URL: 'postgresql://x',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-openai'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, true);
  // Per-call loop = exactly one positional KEY=VAL per call → nothing
  // for the drop-simulator to drop. Pre-fix multi-arg would have dropped 2.
  assert.equal(lostByDrop.length, 0,
    'per-call refactor never sends > 1 positional KEY=VAL → v2.90.0 has no extras to drop');
});

// ── 4. Failure surfacing per call ───────────────────────────────────────────

test('exit-code-per-call: aborts on first non-zero with the failing key name', async () => {
  const { runner } = makeRecordingRunner({
    failOn: new Set(['ANTHROPIC_API_KEY']),
    stderr: 'Error: token rate limit\n'
  });
  const secrets = {
    DATABASE_URL: 'postgresql://x',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-openai'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, false, 'returns false on per-call failure');
  // The failure message names the key that broke.
  assert.match(cap.stdout, /supabase secrets set ANTHROPIC_API_KEY failed/);
  // stderr from the failing call is surfaced.
  assert.match(cap.stderr, /token rate limit/);
});

test('aborts BEFORE running later calls when an earlier key fails', async () => {
  const { runner, calls } = makeRecordingRunner({
    failOn: new Set(['DATABASE_URL'])
  });
  const secrets = {
    DATABASE_URL: 'postgresql://x',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-openai',
    GRAPH_LLM_CLASSIFY: '1'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, false);
  assert.equal(calls.length, 1, 'no further calls after first failure');
  assert.equal(calls[0].args[2].split('=')[0], 'DATABASE_URL');
});

test('missing required value (DATABASE_URL undefined) fails loud, no CLI call made', async () => {
  const { runner, calls } = makeRecordingRunner();
  const secrets = {
    DATABASE_URL: undefined,
    ANTHROPIC_API_KEY: 'sk-ant'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, false);
  assert.equal(calls.length, 0, 'no CLI invocation when in-memory map is missing a key');
  assert.match(cap.stdout, /DATABASE_URL missing from in-memory secrets map/);
});

// ── 5. Dry-run path ─────────────────────────────────────────────────────────

test('dry-run: no CLI calls, returns true, prints (dry-run) suffix', async () => {
  const { runner, calls } = makeRecordingRunner();
  const secrets = {
    DATABASE_URL: 'postgresql://x',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-openai',
    GRAPH_LLM_CLASSIFY: '1'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, true, { runner }));
  assert.equal(cap.result, true);
  assert.equal(calls.length, 0, 'dry-run never shells out');
  assert.match(cap.stdout, /\(dry-run\)/);
});

// ── 6. Secret value with shell-special characters (quotes, $, etc.) ─────────

test('values with shell-special chars are passed verbatim as a single positional arg (no shell expansion)', async () => {
  const { runner, calls } = makeRecordingRunner();
  const secrets = {
    DATABASE_URL: "postgresql://user:p@ss$word!@host/db",
    ANTHROPIC_API_KEY: 'sk-ant'
  };
  const cap = await captureOutput(async () => setFunctionSecrets(secrets, false, { runner }));
  assert.equal(cap.result, true);
  // The whole KEY=VALUE is one argv element → spawnSync passes it as a
  // single C-string to execve, never invoking a shell. No quoting needed.
  assert.equal(calls[0].args[2], "DATABASE_URL=postgresql://user:p@ss$word!@host/db");
});
