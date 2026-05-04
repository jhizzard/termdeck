// Sprint 51.6 T3 — Bug C regression guard: every `supabase functions deploy`
// invocation in init-rumen.js MUST pass `--project-ref <ref>` explicitly.
//
// Background: Brad's 2026-05-03 jizzard-brain install hit a subprocess
// link-state isolation bug — `supabase link --project-ref` ran successfully
// (audit-upgrade probes confirmed the link), then a few subprocesses later
// `supabase functions deploy <name> --no-verify-jwt` errored with `Cannot
// find project ref. Have you run supabase link?` because supabase CLI's
// link state lives in the cwd's supabase/config.toml, and the staged-
// functions tmp dir doesn't have one. Threading --project-ref explicitly
// dodges link-state coupling entirely.
//
// This file pins the contract by:
//   1. Calling deployFunctions(version, projectRef='', dryRun=false) and
//      asserting it returns false (input validation rejects empty projectRef).
//   2. Reading the init-rumen.js source and asserting it contains the
//      `'--project-ref'` literal in the deploy argv. A future PR that
//      drops the flag will fail this test loud.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const INIT_RUMEN_SRC = path.join(repoRoot, 'packages', 'cli', 'src', 'init-rumen.js');
const initRumen = require(INIT_RUMEN_SRC);
const { _deployFunctions } = initRumen;

test('deployFunctions rejects when projectRef is missing/empty', () => {
  // No subprocess should fire — early validation returns false.
  assert.equal(_deployFunctions('0.4.5', undefined, false), false);
  assert.equal(_deployFunctions('0.4.5', '', false), false);
  assert.equal(_deployFunctions('0.4.5', null, false), false);
});

test('deployFunctions returns true on dry-run without spawning subprocesses', () => {
  // dry-run short-circuits before runShell.
  assert.equal(_deployFunctions('0.4.5', 'realprojectref789', true), true);
});

// Static contract pin — asserts the init-rumen.js source contains the
// `'--project-ref'` literal in the deploy argv. A regression that drops
// the flag would surface here even without exercising the subprocess.
test('init-rumen.js source: every functions-deploy argv contains --project-ref', () => {
  const src = fs.readFileSync(INIT_RUMEN_SRC, 'utf8');

  // The deploy argv lives in the for-loop body of deployFunctions(). Pin
  // both the literal flag and its association with the deploy command.
  assert.match(src, /'functions',\s*'deploy',\s*name,\s*\n\s*'--project-ref',\s*projectRef/,
    "init-rumen.js: `supabase functions deploy <name>` must pass `--project-ref <projectRef>` explicitly (Sprint 51.6 T3 / Brad Bug C)");

  // Belt-and-suspenders: the validation guard at the top of deployFunctions.
  assert.match(src, /deployFunctions: projectRef is required/,
    "deployFunctions must validate projectRef and surface a clear error message");
});

// Sprint 52 dogfood (v1.0.8) — `--use-api` regression guard. The default
// supabase CLI bundler uses Docker, which on macOS can't bind-mount paths
// under /var/folders/ (the macOS default os.tmpdir()). Symptom: deploy
// errors with `entrypoint path does not exist (supabase/functions/<name>/
// index.ts)` even though the file IS present in the staging dir. Pinning
// `--use-api` ensures the deploy uploads via the Management API path,
// bypassing Docker entirely.
test('init-rumen.js source: every functions-deploy argv contains --use-api (v1.0.8 macOS Docker workaround)', () => {
  const src = fs.readFileSync(INIT_RUMEN_SRC, 'utf8');

  // The deploy argv must include `'--use-api'` somewhere within the
  // deploy-command argv block.
  assert.match(src,
    /'functions',\s*'deploy',\s*name,[\s\S]{0,400}'--use-api'/,
    "init-rumen.js: `supabase functions deploy <name>` must pass `--use-api` to bypass Docker bundler (v1.0.8 — fixes macOS+/var/folders+stale-supabase-CLI deploy failure)");

  // Step banner should mention --use-api so the user-visible output is
  // consistent with what the wizard actually runs.
  assert.match(src,
    /Running:\s*supabase\s*functions\s*deploy[^\n`]*--use-api/,
    "init-rumen.js: the user-facing 'Running:' step banner must reflect --use-api");
});
