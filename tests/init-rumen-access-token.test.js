// Regression test for the `supabase link` access-token detection in
// packages/cli/src/init-rumen.js (v0.6.4 candidate, fixes Brad's
// 2026-04-26 report).
//
// When the wizard runs `supabase link --project-ref <ref>` and the user
// has neither run `supabase login` nor set SUPABASE_ACCESS_TOKEN, the
// Supabase CLI exits non-zero with stderr like:
//
//   Access token not provided. Supply an access token by running
//   supabase login or setting the SUPABASE_ACCESS_TOKEN environment
//   variable.
//
// The wizard now detects that signature and prints a path-aware hint
// pointing the user at the dashboard PAT page instead of dumping the
// raw CLI output. This test pins the detector itself; the hint string
// is asserted by reading the file (no exported function for the printer
// since it just writes to stderr).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const initRumen = require(path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'init-rumen.js'));
const detect = initRumen._looksLikeMissingAccessToken;

test('detector matches Supabase CLI "Access token not provided" stderr', () => {
  const realStderr = `2026/04/26 00:25:32 Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.\n`;
  assert.equal(detect(realStderr), true);
});

test('detector matches the SUPABASE_ACCESS_TOKEN phrase even without the leading sentence', () => {
  // Future Supabase CLI releases may reword the prefix; we anchor on
  // the env-var name too.
  assert.equal(detect('please set the SUPABASE_ACCESS_TOKEN environment variable\n'), true);
});

test('detector ignores unrelated supabase link errors', () => {
  assert.equal(detect('Cannot connect to Docker daemon\n'), false);
  assert.equal(detect('project ref does not exist\n'), false);
  assert.equal(detect(''), false);
  assert.equal(detect(null), false);
  assert.equal(detect(undefined), false);
});

test('hint text in init-rumen.js points at the Supabase token dashboard', () => {
  // Locking down the actionable URL + export command in the printer body
  // — both must survive any future rewrite of printAccessTokenHint().
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'init-rumen.js'),
    'utf-8'
  );
  assert.match(src, /supabase\.com\/dashboard\/account\/tokens/,
    'hint must include the dashboard URL where users generate the PAT');
  assert.match(src, /export SUPABASE_ACCESS_TOKEN=sbp_/,
    'hint must show the exact export command shape (sbp_ prefix)');
  assert.match(src, /termdeck init --rumen/,
    'hint must tell the user how to retry');
});
